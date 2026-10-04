import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProtocolError } from '@modelcontextprotocol/server';
import { FigmaError, indexNodes, type FigmaSource } from './figma.js';
import { canonical, eventName, subscriptionSchema, tagsIn,
  type Comment, type EventOccurrence, type Subscription, type SubscriptionArguments } from './schema.js';
import type { StateStore } from './store.js';
import { ResourceQueue } from './queue.js';

export class ListenError extends ProtocolError {
  constructor(message: string, code = -32602) { super(code, message); }
}
export interface DeliveryEvent extends Omit<EventOccurrence, 'sequence' | 'observedAt'> { cursor: string }
export interface EventBatch {
  events: DeliveryEvent[]; cursor: string; hasMore: boolean; truncated: boolean; nextPollMs: number;
}
export class ListenEngine extends EventEmitter {
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
  constructor(readonly store: StateStore, private readonly figma: FigmaSource, readonly options: {
    pollIntervalMs?: number; discoveryIntervalMs?: number; retentionMs?: number; maxEvents?: number;
  } = {}) { super(); this.setMaxListeners(100); }
  get interval(): number { return this.options.pollIntervalMs ?? 3000; }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result;
  }
  subscriptions(): Subscription[] { return structuredClone(this.store.state.subscriptions); }
  subscription(id: string): Subscription {
    const subscription = this.store.state.subscriptions.find(s => s.id === id);
    if (!subscription) throw new ListenError('Unknown subscription', -32011);
    return subscription;
  }
  async subscribe(input: unknown, source: Subscription['source'] = 'tool'): Promise<Subscription> {
    const args = subscriptionSchema.parse(input);
    const id = `sub_${createHash('sha256').update(canonical(args)).digest('hex').slice(0,24)}`;
    return this.serialized(async () => {
      let subscription = this.store.state.subscriptions.find(s => s.id === id);
      if (!subscription) {
        if (this.store.state.subscriptions.length >= 100) throw new ListenError('Subscription limit (100) reached', -32013);
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
    } catch { throw new ListenError('Invalid cursor or cursor belongs to a different subscription'); }
  }
  private matches(subscription: Subscription, event: EventOccurrence): boolean {
    const { scope, tag, include_thread_replies } = subscription.arguments;
    if (Date.parse(event.timestamp) < Date.parse(subscription.createdAt)) return false;
    if (this.denied.has(event.data.file_key)) return false;
    if ('file_key' in scope) {
      if (event.data.file_key !== scope.file_key) return false;
      if (scope.kind === 'page' && event.data.page_id !== scope.page_id) return false;
      if (scope.kind === 'frame' && event.data.node_id !== scope.node_id && !event.data.ancestor_ids.includes(scope.node_id)) return false;
    } else if (!subscription.coverage.file_keys.includes(event.data.file_key)) return false;
    if (!tag) return true;
    return tagsIn(event.data.text).includes(tag) ||
      (include_thread_replies && !!event.data.parent_id && event.data.thread_has_tag.includes(tag));
  }
  read(id: string, cursor?: string | null, maxEvents = 50, maxAgeMs?: number): EventBatch {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100) throw new ListenError('max_events must be between 1 and 100');
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
      const { sequence: _, observedAt: __, ...publicEvent } = event;
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
    return { desired_interval_ms: this.interval, request_spacing_ms: this.figma.requestIntervalMs ?? null,
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
  private enqueueFile(key: string): void {
    this.enqueue(`comments:${key}`, () => this.pollFile(key), async error => {
      await this.serialized(async () => {
        if (error instanceof FigmaError && [401,403,404].includes(error.status)) this.denied.add(key);
        for (const sub of this.forFile(key)) { sub.coverage.complete = false; sub.coverage.last_error = error.message; }
        await this.store.save();
      });
    });
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
          sub.coverage.complete = result.warnings.length === 0; delete sub.coverage.last_error;
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
            sub.coverage.warnings = [...discovery.warnings];
            sub.coverage.complete = discovery.warnings.length === 0 && !sub.coverage.last_error;
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
  private async pollFile(key: string): Promise<void> {
    if (!this.forFile(key).length) return;
    // Network waits never hold the state mutation lock. Subscription tools remain responsive.
    const comments = await this.figma.comments(key);
    const current = this.forFile(key);
    const knownBefore = new Set(this.store.state.seen[key] ?? []);
    const freshBefore = comments.filter(c => !knownBefore.has(c.id));
    let index: ReturnType<typeof indexNodes> | undefined;
    let fileName = this.fileNames.get(key);
    if (current.some(s => s.arguments.scope.kind === 'page' || s.arguments.scope.kind === 'frame') &&
        freshBefore.some(c => current.some(s => Date.parse(c.created_at) >= Date.parse(s.createdAt)))) {
      const file = await this.figma.file(key); index = indexNodes(file.document); fileName = file.name;
    }
    await this.serialized(async () => {
      if (this.stopped) return;
      const interested = this.forFile(key);
      if (!interested.length) return;
      this.denied.delete(key);
      const known = new Set(this.store.state.seen[key] ?? []);
      const fresh = [...new Map(comments.filter(c => !known.has(c.id)).map(c => [c.id, c])).values()]
        .sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
      if (new Set([...known, ...fresh.map(c => c.id)]).size > 100000) throw new Error(
        'Observed comment limit (100000 per file) reached; use a new state directory');
      const byId = new Map(comments.map(c => [c.id, c]));
      for (const sub of interested) {
        const discovery = this.discoveries.get(this.scopeKey(sub.arguments.scope));
        sub.coverage.warnings = [...(discovery?.warnings ?? [])];
        sub.coverage.complete = sub.coverage.warnings.length === 0;
        sub.coverage.excluded_unanchored_comments = 0;
        delete sub.coverage.last_error;
      }
      for (const comment of fresh) {
        let root: Comment = comment;
        const visited = new Set([root.id]);
        while (root.parent_id && byId.has(root.parent_id) && !visited.has(root.parent_id)) {
          root = byId.get(root.parent_id)!; visited.add(root.id);
        }
        const nodeId = root.client_meta?.node_id ?? null;
        const anchor = nodeId ? index?.get(nodeId) : undefined;
        if (!nodeId || !anchor) for (const sub of interested) {
          if (Date.parse(comment.created_at) >= Date.parse(sub.createdAt) &&
              (sub.arguments.scope.kind === 'page' || sub.arguments.scope.kind === 'frame')) {
            sub.coverage.excluded_unanchored_comments++; sub.coverage.complete = false;
          }
        }
        if (interested.some(s => Date.parse(comment.created_at) >= Date.parse(s.createdAt))) {
          const sequence = ++this.store.state.sequence;
          this.store.state.events.push({
            eventId: `figma_${createHash('sha256').update(`${key}:${comment.id}`).digest('hex')}`,
            name: eventName, timestamp: comment.created_at, sequence, observedAt: new Date().toISOString(),
            data: { file_key: key, ...(fileName ? { file_name: fileName } : {}),
              comment_id: comment.id, thread_id: root.id, parent_id: comment.parent_id || null,
              text: comment.message, author: { id: comment.user.id,
                ...(typeof comment.user.handle === 'string' ? { handle: comment.user.handle } : {}) }, created_at: comment.created_at,
              resolved_at: comment.resolved_at || null, node_id: nodeId, page_id: anchor?.pageId ?? null,
              ancestor_ids: anchor?.ancestors ?? [], thread_has_tag: tagsIn(root.message),
              url: `https://www.figma.com/design/${encodeURIComponent(key)}?${new URLSearchParams({
                ...(nodeId ? { 'node-id': nodeId } : {}), 'comment-id': comment.id }).toString()}` },
          });
        }
        known.add(comment.id);
      }
      this.store.state.seen[key] = [...known];
      for (const sub of interested) {
        sub.coverage.last_success_at = new Date().toISOString();
        if (sub.coverage.excluded_unanchored_comments) sub.coverage.warnings.push(
          'Some comments could not be mapped to a page/frame and were excluded from that scoped subscription.');
      }
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
