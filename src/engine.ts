import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProtocolError } from '@modelcontextprotocol/server';
import { FigmaError, indexNodes, type FigmaSource } from './figma.js';
import { canonical, commentInputSchema, eventName, subscriptionSchema, tagsIn, targetId, isDesignEvent, reactionSchema,
  type CommentAccess, type DesignSnapshot, type Comment, type CommentData, type EventData, type EventName, type EventOccurrence, type Reaction, type Subscription, type SubscriptionArguments } from './schema.js';
import type { StateStore } from './store.js';
import { ResourceQueue } from './queue.js';
import { snapshot, diffNodes, scopeChanges } from './diff.js';

export class WatchError extends ProtocolError {
  constructor(message: string, code = -32602) { super(code, message); }
}
export interface DeliveryEvent extends Omit<EventOccurrence, 'sequence' | 'observedAt' | 'since' | 'subscriptionId'> { cursor: string }
export interface EventBatch {
  events: DeliveryEvent[]; cursor: string; hasMore: boolean; truncated: boolean; nextPollMs: number;
}
export class WatchEngine extends EventEmitter {
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private closing?: Promise<void>;
  private started = false;
  private pulsePending?: Promise<void>;
  private queue = new ResourceQueue();
  private retries = new Map<string, { failures: number; at: number }>();
  private denied = new Set<string>();
  private streams = new Map<string, number>();
  private discoveries = new Map<string, { at: number; keys: string[]; warnings: string[] }>();
  private fileNames = new Map<string, string>();
  private posting = new Map<string, Set<Promise<unknown>>>();
  private access: CommentAccess;
  constructor(readonly store: StateStore, private readonly figma: FigmaSource, readonly options: {
    pollIntervalMs?: number; designQuietPeriodMs?: number; discoveryIntervalMs?: number; retentionMs?: number; maxEvents?: number;
    commentAccess?: CommentAccess;
  } = {}) {
    super(); this.setMaxListeners(100);
    store.state.comments ??= {}; store.state.designs ??= {}; store.state.reactions ??= {}; store.state.pendingDesigns ??= {};
    this.access = figma.postComment ? options.commentAccess ?? 'unverified' : 'missing';
  }
  get commentAccess(): CommentAccess { return this.access; }
  private setCommentAccess(access: CommentAccess): void {
    if (access !== this.access) { this.access = access; this.emit('commentAccess', access); }
  }
  /** Comments posted here are marked seen, so they never come back as events to this process. */
  async postComment(input: unknown): Promise<{ comment_id: string; thread_id: string; file_key: string;
    created_at: string; node_id: string | null; url: string }> {
    const args = commentInputSchema.parse(input);
    if (!this.figma.postComment || this.access === 'missing')
      throw new Error('The Figma token lacks the file_comments:write scope.');
    const key = args.file_key;
    // Figma only accepts replies to a thread's root comment.
    const thread = args.reply_to && (this.store.state.comments[key]?.data[args.reply_to]?.thread_id ?? args.reply_to);
    const request = (async () => {
      const comment = await this.figma.postComment!(key, { message: args.message,
        ...(thread ? { comment_id: thread } : {}),
        ...(args.node_id ? { client_meta: { node_id: args.node_id, node_offset: args.node_offset! } } : {}) });
      // Recorded before any poll waiting on this request diffs its snapshot.
      (this.store.state.seen[key] ??= []).push(comment.id);
      return comment;
    })();
    const pending = this.posting.get(key) ?? new Set();
    pending.add(request); this.posting.set(key, pending);
    let comment: Comment;
    try { comment = await request; }
    catch (error) {
      if (error instanceof FigmaError && error.grantedScopes && !error.grantedScopes.includes('file_comments:write'))
        this.setCommentAccess('missing');
      throw error;
    } finally {
      pending.delete(request); if (!pending.size) this.posting.delete(key);
    }
    this.setCommentAccess('granted');
    await this.serialized(() => this.store.save());
    const nodeId = thread ? this.store.state.comments[key]?.data[thread]?.node_id ?? null : args.node_id ?? null;
    return { comment_id: comment.id, thread_id: thread || comment.id, file_key: key, created_at: comment.created_at,
      node_id: nodeId, url: `https://www.figma.com/design/${encodeURIComponent(key)}?${new URLSearchParams({
        ...(nodeId ? { 'node-id': nodeId } : {}), 'comment-id': comment.id })}` };
  }
  get interval(): number { return this.options.pollIntervalMs ?? 3000; }
  get designQuietPeriod(): number { return this.options.designQuietPeriodMs ?? 120000; }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result;
  }
  subscriptions(): Subscription[] { return structuredClone(this.store.state.subscriptions); }
  subscription(id: string): Subscription {
    const subscription = this.store.state.subscriptions.find(s => s.id === id);
    if (!subscription) throw new WatchError('Unknown subscription', -32011);
    return subscription;
  }
  async subscribe(input: unknown, source: Subscription['source'] = 'tool'): Promise<Subscription> {
    const args = subscriptionSchema.parse(input);
    const id = `sub_${createHash('sha256').update(canonical(args)).digest('hex').slice(0,24)}`;
    return this.serialized(async () => {
      let subscription = this.store.state.subscriptions.find(s => s.id === id);
      if (!subscription) {
        if (this.store.state.subscriptions.length >= 100) throw new WatchError('Subscription limit (100) reached', -32013);
        subscription = { id, arguments: args, createdAt: new Date().toISOString(),
          startSequence: this.store.state.sequence, source,
          coverage: { file_keys: [], complete: false, warnings: ['Discovery pending'], excluded_unanchored_comments: 0 } };
        this.store.state.subscriptions.push(subscription);
      }
      if (source === 'tool') { subscription.source = 'tool'; delete subscription.expiresAt; }
      if (source === 'poll' && subscription.source === 'stream') subscription.source = 'poll';
      if (subscription.source === 'poll') subscription.expiresAt = new Date(Date.now() + Math.max(300000, this.interval * 3)).toISOString();
      await this.store.save();
      return structuredClone(subscription);
    });
  }
  async unsubscribe(id: string): Promise<void> {
    await this.serialized(async () => {
      this.store.state.subscriptions = this.store.state.subscriptions.filter(s => s.id !== id);
      this.removeUnusedDiscoveries();
      await this.store.save();
      this.emit('unsubscribe', id);
    });
  }
  retainStream(id: string): void {
    this.streams.set(id, (this.streams.get(id) ?? 0) + 1);
  }
  async releaseStream(id: string): Promise<void> {
    await this.serialized(async () => {
      const remaining = (this.streams.get(id) ?? 1) - 1;
      if (remaining) this.streams.set(id, remaining); else this.streams.delete(id);
      const sub = this.store.state.subscriptions.find(s => s.id === id);
      if (!remaining && sub?.source === 'stream') {
        this.store.state.subscriptions = this.store.state.subscriptions.filter(s => s.id !== id);
        this.removeUnusedDiscoveries(); await this.store.save(); this.emit('unsubscribe', id);
      }
    });
  }
  cursor(id: string, sequence = this.store.state.sequence): string {
    return Buffer.from(JSON.stringify([this.store.state.epoch, id, sequence])).toString('base64url');
  }
  private parseCursor(id: string, cursor: string): { sequence: number; truncated: boolean } {
    try {
      if (cursor.length > 1000) throw new Error();
      const [epoch, subscriptionId, sequence] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (subscriptionId !== id || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error();
      if (epoch !== this.store.state.epoch) return { sequence: this.store.state.droppedThrough, truncated: true };
      if (sequence > this.store.state.sequence) throw new Error();
      return { sequence, truncated: sequence < this.store.state.droppedThrough };
    } catch { throw new WatchError('Invalid cursor or cursor belongs to a different subscription'); }
  }
  private matches(subscription: Subscription, event: EventOccurrence, ignoreAccess = false): boolean {
    if (event.subscriptionId && event.subscriptionId !== subscription.id) return false;
    const { scope, tag, include_thread_replies, event_types } = subscription.arguments;
    if (!event_types.includes(event.name)) return false;
    if (Date.parse(event.timestamp) < Date.parse(subscription.createdAt) ||
        (event.since && Date.parse(event.since) < Date.parse(subscription.createdAt))) return false;
    const channel = isDesignEvent(event.name) ? 'design' : event.name.startsWith('figma.reaction.') ? 'reactions' : 'comments';
    if (!ignoreAccess && this.denied.has(`${channel}:${event.data.file_key}`)) return false;
    if ('file_key' in scope) {
      if (event.data.file_key !== scope.file_key) return false;
    } else if (!subscription.coverage.file_keys.includes(event.data.file_key)) return false;
    if ('target_id' in event.data) return event.data.target_id === targetId(scope);
    const data = event.data;
    const target = targetId(scope);
    if (target && ![data, data.previous_location].some(location => location &&
        (location.node_id === target || location.ancestor_ids.includes(target)))) return false;
    if (!tag) return true;
    return tagsIn(data.text).includes(tag) || tagsIn(data.previous_text ?? '').includes(tag) ||
      (include_thread_replies && !!data.parent_id &&
        [...data.thread_has_tag, ...(data.previous_thread_has_tag ?? [])].includes(tag));
  }
  read(id: string, cursor?: string | null, maxEvents = 50, maxAgeMs?: number): EventBatch {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) throw new WatchError('max_events must be between 1 and 100');
    const subscription = this.subscription(id);
    // The draft's null cursor bootstraps from now. Tool omission replays the subscription's buffer.
    if (cursor === null) return { events: [], cursor: this.cursor(id), hasMore: false, truncated: false, nextPollMs: this.interval };
    const position = cursor === undefined ? { sequence: subscription.startSequence, truncated: false } : this.parseCursor(id, cursor);
    let sequence = Math.max(position.sequence, this.store.state.droppedThrough);
    let truncated = position.truncated || position.sequence < this.store.state.droppedThrough;
    const events: DeliveryEvent[] = [];
    let hasMore = false;
    for (const event of this.store.state.events) {
      if (event.sequence <= sequence) continue;
      if (events.length >= maxEvents) { hasMore = true; break; }
      sequence = event.sequence;
      if (!this.matches(subscription, event)) continue;
      if (maxAgeMs !== undefined && Date.parse(event.timestamp) < Date.now() - maxAgeMs) { truncated = true; continue; }
      const { sequence: _, observedAt: __, since: ___, subscriptionId: ____, ...publicEvent } = event;
      events.push({ ...publicEvent, cursor: this.cursor(id, sequence) });
    }
    if (!hasMore) sequence = this.store.state.sequence;
    return { events, cursor: this.cursor(id, sequence), truncated, hasMore, nextPollMs: this.interval };
  }
  private prune(): void {
    const state = this.store.state;
    const cutoff = Date.now() - (this.options.retentionMs ?? 7 * 86400000);
    while (state.events.length && (state.events.length > (this.options.maxEvents ?? 10000) ||
      Date.parse(state.events[0].observedAt) < cutoff)) {
      state.droppedThrough = state.events.shift()!.sequence;
    }
  }
  private scopeKey(scope: SubscriptionArguments['scope']): string { return canonical(scope); }
  private removeUnusedDiscoveries(): void {
    const ids = new Set(this.store.state.subscriptions.map(s => s.id));
    for (const id of Object.keys(this.store.state.pendingDesigns)) if (!ids.has(id)) delete this.store.state.pendingDesigns[id];
    const active = new Set(this.store.state.subscriptions.map(s => this.scopeKey(s.arguments.scope)));
    for (const key of this.discoveries.keys()) if (!active.has(key)) this.discoveries.delete(key);
  }
  private forFile(key: string): Subscription[] {
    return this.store.state.subscriptions.filter(s => {
      const scope = s.arguments.scope;
      return 'file_key' in scope ? scope.file_key === key : s.coverage.file_keys.includes(key);
    });
  }
  pollingStatus(): Record<string, unknown> {
    return { desired_interval_ms: this.interval, design_quiet_period_ms: this.designQuietPeriod,
      pending_design_changesets: Object.entries(this.store.state.pendingDesigns).map(([id, pending]) => ({
        subscription_id: id, file_keys: Object.keys(pending.files), last_changed_at: pending.lastChangedAt,
        eligible_at: new Date(Date.parse(pending.lastChangedAt) + this.designQuietPeriod).toISOString(),
      })), request_spacing_ms: this.figma.requestIntervalMs ?? null,
      scheduler: 'FIFO; one pending or running job per resource', ...this.queue.status(),
      upstream_requests: this.figma.requestStatus?.() ?? null };
  }
  private enqueue(key: string, operation: () => Promise<void>, failed: (error: Error) => Promise<void>): void {
    if (this.stopped || (this.retries.get(key)?.at ?? 0) > Date.now()) return;
    void this.queue.enqueue(key, async () => {
      if (this.stopped) return;
      try { await operation(); this.retries.delete(key); }
      catch (cause) {
        if (this.stopped) return;
        const error = cause instanceof Error ? cause : new Error('Polling failed');
        const failures = (this.retries.get(key)?.failures ?? 0) + 1;
        const retryAfter = error instanceof FigmaError ? error.retryAfterMs : 0;
        this.retries.set(key, { failures, at: Date.now() + Math.max(retryAfter,
          Math.min(900000, this.interval * 2 ** Math.min(failures, 8))) });
        try { await failed(error); } finally { this.emit('pollError', error); }
        throw error;
      }
    });
  }
  private wants(key: string, channel: 'comments' | 'design' | 'reactions'): Subscription[] {
    return this.forFile(key).filter(sub => sub.arguments.event_types.some(name =>
      channel === 'design' ? isDesignEvent(name) : channel === 'reactions' ? name.startsWith('figma.reaction.') : !isDesignEvent(name)));
  }
  private refreshCoverage(sub: Subscription): void {
    const errors = Object.values(sub.coverage.resource_errors ?? {});
    if (errors.length) sub.coverage.last_error = errors.join('; '); else delete sub.coverage.last_error;
    sub.coverage.warnings = [...(this.discoveries.get(this.scopeKey(sub.arguments.scope))?.warnings ?? [])];
    if (sub.coverage.excluded_unanchored_comments) sub.coverage.warnings.push(
      'Some comments could not be mapped to a page/section/frame and were excluded from that scoped subscription.');
    if (sub.coverage.target_status === 'missing') sub.coverage.warnings.push('Watched target is missing; subscription will follow the same node ID if restored.');
    sub.coverage.complete = !errors.length && !sub.coverage.warnings.length;
  }
  private success(key: string, channel: 'comments' | 'design' | 'reactions'): void {
    this.denied.delete(`${channel}:${key}`);
    for (const sub of this.wants(key, channel)) {
      delete sub.coverage.resource_errors?.[`${channel}:${key}`];
      sub.coverage.last_success_at = new Date().toISOString(); this.refreshCoverage(sub);
    }
  }
  private async failure(key: string, channel: 'comments' | 'design' | 'reactions', error: Error): Promise<void> {
    await this.serialized(async () => {
      if (error instanceof FigmaError && [401,403,404].includes(error.status)) {
        this.denied.add(`${channel}:${key}`);
        if (channel === 'comments') this.denied.add(`reactions:${key}`);
      }
      for (const sub of this.wants(key, channel)) {
        (sub.coverage.resource_errors ??= {})[`${channel}:${key}`] = error.message;
        this.refreshCoverage(sub);
      }
      await this.store.save();
    });
  }
  private enqueueFile(key: string): void {
    if (this.wants(key, 'comments').length) this.enqueue(`comments:${key}`, () => this.pollFile(key), error => this.failure(key, 'comments', error));
    if (this.wants(key, 'design').length) this.enqueue(`design:${key}`, () => this.pollDesign(key), error => this.failure(key, 'design', error));
  }
  private enqueueDiscovery(scope: SubscriptionArguments['scope']): void {
    const scopeKey = this.scopeKey(scope);
    this.enqueue(`discovery:${scopeKey}`, async () => {
      if (!this.store.state.subscriptions.some(s => this.scopeKey(s.arguments.scope) === scopeKey)) return;
      const result = await this.figma.discover(scope);
      await this.serialized(async () => {
        if (this.stopped) return;
        const interested = this.store.state.subscriptions.filter(s => this.scopeKey(s.arguments.scope) === scopeKey);
        if (!interested.length) return;
        const keys = [...new Set(result.files.map(f => f.key))];
        this.discoveries.set(scopeKey, { at: Date.now(), keys, warnings: result.warnings });
        for (const file of result.files) if (file.name) this.fileNames.set(file.key, file.name);
        for (const sub of interested) {
          sub.coverage.file_keys = keys; sub.coverage.warnings = [...result.warnings];
          this.refreshCoverage(sub);
        }
        await this.store.save();
        for (const key of keys) this.enqueueFile(key);
      });
    }, async error => {
      await this.serialized(async () => {
        this.discoveries.delete(scopeKey);
        for (const sub of this.store.state.subscriptions) if (this.scopeKey(sub.arguments.scope) === scopeKey) {
          sub.coverage.complete = false; sub.coverage.last_error = error.message;
          sub.coverage.file_keys = [];
        }
        await this.store.save();
      });
    });
  }
  private pulse(): Promise<void> {
    if (this.pulsePending) return this.pulsePending;
    const operation = this.serialized(async () => {
      if (this.stopped) return;
      const active = this.store.state.subscriptions.filter(s =>
        this.streams.has(s.id) || !s.expiresAt || Date.parse(s.expiresAt) > Date.now());
      const changed = active.length !== this.store.state.subscriptions.length;
      this.store.state.subscriptions = active;
      const previousDropped = this.store.state.droppedThrough;
      this.prune();
      this.removeUnusedDiscoveries();
      const files = new Set<string>();
      const scopes = new Map<string, SubscriptionArguments['scope']>();
      for (const sub of active) {
        const scope = sub.arguments.scope;
        if ('file_key' in scope) {
          if (!sub.coverage.file_keys.includes(scope.file_key)) {
            sub.coverage.file_keys = [scope.file_key]; sub.coverage.warnings = []; sub.coverage.complete = true;
          }
          files.add(scope.file_key);
        } else {
          const key = this.scopeKey(scope);
          const discovery = this.discoveries.get(key);
          if (!discovery || Date.now() - discovery.at > (this.options.discoveryIntervalMs ?? 300000)) scopes.set(key, scope);
          if (discovery) {
            sub.coverage.file_keys = [...discovery.keys];
            this.refreshCoverage(sub);
            for (const file of discovery.keys) files.add(file);
          }
        }
      }
      for (const scope of scopes.values()) this.enqueueDiscovery(scope);
      for (const key of files) this.enqueueFile(key);
      if (changed || previousDropped !== this.store.state.droppedThrough) await this.store.save();
    });
    this.pulsePending = operation;
    void operation.finally(() => { if (this.pulsePending === operation) this.pulsePending = undefined; }).catch(() => {});
    return operation;
  }
  /** Manual polling: enqueue current resources and wait for outstanding work to drain. */
  async tick(): Promise<void> {
    const errors: Error[] = [];
    const record = (error: Error) => errors.push(error);
    this.on('pollError', record);
    try {
      await this.pulse(); await this.queue.idle();
      if (errors.length) throw errors[errors.length - 1];
    } finally { this.off('pollError', record); }
  }
  private append(name: EventName, key: string, data: EventData, timestamp: string, since?: string, subscriptionId?: string): void {
    const sequence = this.store.state.sequence + 1;
    const occurrence: EventOccurrence = { name, data, sequence, timestamp, observedAt: new Date().toISOString(),
      ...(since ? { since } : {}), ...(subscriptionId ? { subscriptionId } : {}), eventId: `figma_${createHash('sha256').update(name === eventName ?
        `${key}:${(data as CommentData).comment_id}` : `${this.store.state.epoch}:${sequence}:${name}:${canonical(data)}`).digest('hex')}` };
    if (!this.forFile(key).some(sub => this.matches(sub, occurrence))) return;
    this.store.state.sequence = sequence; this.store.state.events.push(occurrence);
  }
  private async pollFile(key: string): Promise<void> {
    if (!this.wants(key, 'comments').length) return;
    const observedAt = new Date().toISOString();
    const comments = [...new Map((await this.figma.comments(key)).map(c => [c.id, c])).values()]
      .sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
    if (comments.length > 100000) throw new Error('Comment snapshot limit (100000) exceeded');
    const previous = this.store.state.comments[key];
    let index: ReturnType<typeof indexNodes> | undefined;
    let fileName = this.fileNames.get(key);
    // Resolve anchors when comment content changes or a newly scoped subscription needs a baseline.
    if (this.wants(key, 'comments').some(s => targetId(s.arguments.scope)) &&
        (!previous || canonical(comments) !== canonical(previous.comments) ||
         this.wants(key, 'comments').some(s => Date.parse(s.createdAt) > Date.parse(previous.observedAt)))) {
      const file = await this.figma.file(key); index = indexNodes(file.document); fileName = file.name;
    }
    // The snapshot may already hold a comment this server is posting. Diff once its ID is recorded.
    const posting = this.posting.get(key);
    if (posting) await Promise.allSettled(posting);
    await this.serialized(async () => {
      if (this.stopped || !this.wants(key, 'comments').length) return;
      const interested = this.wants(key, 'comments');
      this.denied.delete(`comments:${key}`);
      const known = new Set(this.store.state.seen[key] ?? []);
      if (new Set([...known, ...comments.map(c => c.id)]).size > 100000)
        throw new Error('Observed comment limit (100000 per file) reached; use a new state directory');
      const byId = new Map(comments.map(c => [c.id, c]));
      const oldById = new Map(previous?.comments.map(c => [c.id, c]) ?? []);
      const data: Record<string, CommentData> = Object.create(null);
      for (const sub of interested) sub.coverage.excluded_unanchored_comments = 0;
      for (const comment of comments) {
        let root = comment;
        const visited = new Set([root.id]);
        while (root.parent_id && byId.has(root.parent_id) && !visited.has(root.parent_id)) {
          root = byId.get(root.parent_id)!; visited.add(root.id);
        }
        const nodeId = root.client_meta?.node_id ?? null;
        const anchor = nodeId ? index?.get(nodeId) : undefined;
        const oldData = previous?.data[comment.id];
        const reusable = !index && oldData?.node_id === nodeId;
        const payload: CommentData = {
          file_key: key, ...(fileName ? { file_name: fileName } : {}),
          comment_id: comment.id, thread_id: root.id, parent_id: comment.parent_id || null,
          text: comment.message, author: { id: comment.user.id,
            ...(typeof comment.user.handle === 'string' ? { handle: comment.user.handle } : {}) },
          created_at: comment.created_at, resolved_at: comment.resolved_at || null,
          node_id: nodeId, page_id: anchor?.pageId ?? (reusable ? oldData.page_id : null),
          ancestor_ids: anchor?.ancestors ?? (reusable ? oldData.ancestor_ids : []), thread_has_tag: tagsIn(root.message),
          url: `https://www.figma.com/design/${encodeURIComponent(key)}?${new URLSearchParams({
            ...(nodeId ? { 'node-id': nodeId } : {}), 'comment-id': comment.id })}`,
        };
        data[comment.id] = payload;
        if (!payload.page_id) for (const sub of interested) if (targetId(sub.arguments.scope)) sub.coverage.excluded_unanchored_comments++;
        const old = oldById.get(comment.id);
        if (!known.has(comment.id)) this.append(eventName, key, payload, comment.created_at);
        else if (old && oldData) {
          const delta = { ...payload, previous_text: oldData.text, previous_thread_has_tag: oldData.thread_has_tag,
            previous_location: { node_id: oldData.node_id, page_id: oldData.page_id, ancestor_ids: oldData.ancestor_ids } };
          if (old.message !== comment.message || canonical(old.client_meta) !== canonical(comment.client_meta))
            this.append('figma.comment.edited', key, delta, observedAt, previous!.observedAt);
          if (!!old.resolved_at !== !!comment.resolved_at) this.append(comment.resolved_at ? 'figma.comment.resolved' : 'figma.comment.reopened',
            key, { ...delta, previous_resolved_at: old.resolved_at || null }, observedAt, previous!.observedAt);
        }
        known.add(comment.id);
      }
      if (previous) for (const old of previous.comments) if (!byId.has(old.id) && previous.data[old.id]) {
        this.append('figma.comment.deleted', key, previous.data[old.id], observedAt, previous.observedAt);
        delete this.store.state.reactions[`${key}:${old.id}`];
      }
      this.store.state.seen[key] = [...known];
      this.store.state.comments[key] = { observedAt, comments: structuredClone(comments), data };
      this.success(key, 'comments');
      this.prune(); await this.store.save(); this.emit('events');
      if (this.wants(key, 'reactions').length) this.enqueue(`reactions:${key}`, () => this.pollReactions(key), error => this.failure(key, 'reactions', error));
    });
  }
  private async pollReactions(key: string): Promise<void> {
    const baseline = this.store.state.comments[key];
    if (!baseline || !this.wants(key, 'reactions').length || this.denied.has(`comments:${key}`)) return;
    let reactionIndex: ReturnType<typeof indexNodes> | undefined;
    // Fallback reactions may change without changing the comments response. Resolve their current scope.
    if (baseline.comments.some(c => c.reactions === undefined) &&
        this.wants(key, 'reactions').some(s => targetId(s.arguments.scope))) {
      reactionIndex = indexNodes((await this.figma.file(key)).document);
    }
    const reactionData = (id: string): CommentData | undefined => {
      const data = this.store.state.comments[key]?.data[id];
      if (!data || !reactionIndex) return data;
      const anchor = data.node_id ? reactionIndex.get(data.node_id) : undefined;
      return { ...data, page_id: anchor?.pageId ?? null, ancestor_ids: anchor?.ancestors ?? [] };
    };
    // Only comments that match a reaction subscription need per-comment fallback requests.
    const interested = baseline.comments.filter(comment => {
      const data = reactionData(comment.id);
      return data && this.wants(key, 'reactions').some(sub => this.matches(sub, {
        eventId: '', sequence: 0, timestamp: new Date().toISOString(), observedAt: '',
        name: sub.arguments.event_types.includes('figma.reaction.added') ? 'figma.reaction.added' : 'figma.reaction.removed', data,
      }, true));
    });
    if (interested.filter(c => c.reactions === undefined).length > 1000)
      throw new Error('Reaction fallback limit (1000 comments per file) exceeded; narrow the scope or use a tag');
    for (const comment of interested) {
      if (this.stopped || !this.wants(key, 'reactions').length) return;
      const observedAt = new Date().toISOString();
      let raw: Reaction[];
      try { raw = comment.reactions ?? await this.figma.reactions(key, comment.id); }
      catch (error) {
        // A comment may disappear between the list and reaction requests. Don't infer reaction removals.
        if (error instanceof FigmaError && error.status === 404) continue;
        throw error;
      }
      const items = raw.map(item => reactionSchema.parse({ emoji: item.emoji, created_at: item.created_at,
        user: { id: item.user.id, ...(typeof item.user.handle === 'string' ? { handle: item.user.handle } : {}) } }));
      await this.serialized(async () => {
        if (this.stopped || this.denied.has(`comments:${key}`)) return;
        const current = reactionData(comment.id);
        if (!current) return;
        const resource = `${key}:${comment.id}`;
        const previous = this.store.state.reactions[resource];
        const identity = (item: Reaction) => canonical([item.user.id, item.emoji]);
        const before = new Map(previous?.items.map(item => [identity(item), item]) ?? []);
        const after = new Map(items.map(item => [identity(item), item]));
        this.denied.delete(`reactions:${key}`);
        for (const [id, reaction] of after) if (!before.has(id)) this.append('figma.reaction.added', key,
          { ...current, reaction }, previous ? observedAt : reaction.created_at, previous?.observedAt);
        if (previous) for (const [id, reaction] of before) if (!after.has(id)) this.append('figma.reaction.removed', key,
          { ...current, reaction }, observedAt, previous.observedAt);
        this.store.state.reactions[resource] = { observedAt, items: [...after.values()] };
        this.prune(); await this.store.save(); this.emit('events');
      });
    }
    await this.serialized(async () => { this.success(key, 'reactions'); await this.store.save(); });
  }
  /** Only a fresh successful observation can confirm that the scope is quiet. */
  private flushDesigns(): void {
    for (const sub of this.store.state.subscriptions) {
      const pending = this.store.state.pendingDesigns[sub.id];
      if (!pending) continue;
      const deadline = Date.parse(pending.lastChangedAt) + this.designQuietPeriod;
      const files = sub.coverage.file_keys;
      if (!files.length || files.some(key => this.denied.has(`design:${key}`) ||
          sub.coverage.resource_errors?.[`design:${key}`] ||
          !this.store.state.designs[key] || Date.parse(this.store.state.designs[key].observedAt) < deadline)) continue;
      const target = targetId(sub.arguments.scope);
      for (const [key, baseline] of Object.entries(pending.files)) {
        if (!files.includes(key)) continue;
        const next = this.store.state.designs[key];
        const beforeNodes: DesignSnapshot['nodes'] = Object.create(null);
        const afterNodes: DesignSnapshot['nodes'] = Object.create(null);
        for (const [id, node] of Object.entries(baseline.nodes)) {
          if (node) beforeNodes[id] = node;
          if (next.nodes[id]) afterNodes[id] = next.nodes[id];
        }
        const before = { ...baseline, observedAt: baseline.since, nodes: beforeNodes };
        const changes = scopeChanges(diffNodes(before, { ...next, nodes: afterNodes }), target);
        const metadataChanged = target === null && baseline.name !== next.name;
        if (!changes.length && !metadataChanged) continue;
        const data = { file_key: key, file_name: next.name,
          url: `https://www.figma.com/design/${encodeURIComponent(key)}${target ? `?${new URLSearchParams({ 'node-id': target })}` : ''}`,
          target_id: target, version: next.version, previous_version: baseline.version,
          changes: changes.slice(0, 1000), total_changes: changes.length, changes_truncated: changes.length > 1000,
          metadata_changed: metadataChanged, first_observed_at: pending.firstChangedAt,
          last_observed_at: pending.lastChangedAt, quiet_period_ms: this.designQuietPeriod };
        this.append('figma.design.changed', key, data, pending.lastChangedAt, baseline.since, sub.id);
        if (target && beforeNodes[target] && !next.nodes[target])
          this.append('figma.scope.deleted', key, data, pending.lastChangedAt, baseline.since, sub.id);
      }
      delete this.store.state.pendingDesigns[sub.id];
    }
  }
  private async pollDesign(key: string): Promise<void> {
    if (!this.wants(key, 'design').length) return;
    // Figma mutates the current version in place. Neither a version ID nor a
    // shallow page tree is a safe gate for changes to descendant properties.
    const file = await this.figma.file(key);
    const observedAt = new Date().toISOString();
    const next = snapshot(file, observedAt);
    await this.serialized(async () => {
      if (this.stopped || !this.wants(key, 'design').length) return;
      const previous = this.store.state.designs[key];
      const changes = previous ? diffNodes(previous, next) : [];
      for (const sub of this.wants(key, 'design')) {
        const target = targetId(sub.arguments.scope);
        if (previous && Date.parse(previous.observedAt) >= Date.parse(sub.createdAt)) {
          const scoped = scopeChanges(changes, target);
          const renamed = target === null && previous.name !== next.name;
          if (scoped.length || renamed) {
            const pending = this.store.state.pendingDesigns[sub.id] ??= {
              firstChangedAt: observedAt, lastChangedAt: observedAt, files: Object.create(null),
            };
            pending.lastChangedAt = observedAt;
            const baseline = pending.files[key] ??= { version: previous.version, name: previous.name,
              since: previous.observedAt, nodes: Object.create(null) };
            for (const change of scoped) if (!Object.hasOwn(baseline.nodes, change.node_id))
              baseline.nodes[change.node_id] = previous.nodes[change.node_id] ?? null;
          }
        }
        if (target) sub.coverage.target_status = next.nodes[target] ? 'present' : 'missing';
      }
      this.store.state.designs[key] = next;
      this.fileNames.set(key, next.name); this.success(key, 'design');
      this.flushDesigns();
      this.prune(); await this.store.save(); this.emit('events');
    });
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const run = () => {
      if (this.stopped) return;
      void this.pulse().catch(error => this.emit('pollError', error));
      this.timer = setTimeout(run, this.interval);
    };
    this.timer = setTimeout(run, 0);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    this.closing = (async () => {
      await this.queue.close();
      await this.tail.catch(() => {});
      this.prune();
      try { await this.store.save(); } finally { await this.store.close(); }
    })();
    return this.closing;
  }
}
