import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ProtocolError } from '@modelcontextprotocol/server';
import { FigmaError, indexNodes, type FigmaSource } from './figma.js';
import { canonical, eventName, subscriptionSchema, tagsIn,
  type Comment, type EventOccurrence, type Subscription, type SubscriptionArguments } from './schema.js';
import type { StateStore } from './store.js';

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
  private failures = 0;
  private denied = new Set<string>();
  private streams = new Map<string, number>();
  private discoveries = new Map<string, { at: number; keys: string[]; warnings: string[]; names: Map<string, string> }>();
  constructor(readonly store: StateStore, private readonly figma: FigmaSource, readonly options: {
    pollIntervalMs?: number; discoveryIntervalMs?: number; retentionMs?: number; maxEvents?: number;
  } = {}) { super(); this.setMaxListeners(100); }
  get interval(): number { return this.options.pollIntervalMs ?? 60000; }
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
      this.discoveries.delete(id);
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
        this.discoveries.delete(id); await this.store.save(); this.emit('unsubscribe', id);
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
  async tick(): Promise<void> { return this.serialized(() => this.poll()); }
  private async poll(): Promise<void> {
    if (this.stopped) return;
    this.store.state.subscriptions = this.store.state.subscriptions.filter(s =>
      this.streams.has(s.id) || !s.expiresAt || Date.parse(s.expiresAt) > Date.now());
    const subscriptions = this.store.state.subscriptions;
    const names = new Map<string, string>();
    const files = new Set<string>();
    let failure: Error | undefined;
    for (const subscription of subscriptions) {
      try {
        let discovery = this.discoveries.get(subscription.id);
        if (!discovery || Date.now() - discovery.at > (this.options.discoveryIntervalMs ?? 300000)) {
          const result = await this.figma.discover(subscription.arguments.scope);
          discovery = { at: Date.now(), keys: result.files.map(f => f.key), warnings: result.warnings,
            names: new Map(result.files.filter(f => f.name).map(f => [f.key, f.name!])) };
          this.discoveries.set(subscription.id, discovery);
        }
        subscription.coverage.file_keys = discovery.keys;
        subscription.coverage.warnings = [...discovery.warnings];
        subscription.coverage.complete = discovery.warnings.length === 0;
        subscription.coverage.excluded_unanchored_comments = 0;
        delete subscription.coverage.last_error;
        for (const key of discovery.keys) files.add(key);
        for (const [key, name] of discovery.names) names.set(key, name);
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Discovery failed');
        subscription.coverage.complete = false;
        subscription.coverage.last_error = failure.message;
        // Do not claim old discovery is current, or deliver buffered events from this scope.
        subscription.coverage.file_keys = [];
      }
    }
    for (const key of files) {
      if (this.stopped) break;
      const interested = subscriptions.filter(s => s.coverage.file_keys.includes(key));
      try {
        const comments = await this.figma.comments(key);
        this.denied.delete(key);
        const known = new Set(this.store.state.seen[key] ?? []);
        const fresh = comments.filter(c => !known.has(c.id)).sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
        if (new Set([...known, ...fresh.map(c => c.id)]).size > 100000) throw new Error(
          'Observed comment limit (100000 per file) reached; use a new state directory');
        const byId = new Map(comments.map(c => [c.id, c]));
        const needsIndex = interested.some(s => s.arguments.scope.kind === 'page' || s.arguments.scope.kind === 'frame');
        let index: ReturnType<typeof indexNodes> | undefined;
        if (needsIndex && fresh.some(c => interested.some(s => Date.parse(c.created_at) >= Date.parse(s.createdAt)))) {
          const file = await this.figma.file(key);
          index = indexNodes(file.document); names.set(key, file.name);
        }
        for (const comment of fresh) {
          let root: Comment = comment;
          const visited = new Set([root.id]);
          while (root.parent_id && byId.has(root.parent_id) && !visited.has(root.parent_id)) {
            root = byId.get(root.parent_id)!; visited.add(root.id);
          }
          const nodeId = root.client_meta?.node_id ?? null;
          const anchor = nodeId ? index?.get(nodeId) : undefined;
          if (needsIndex && (!nodeId || !anchor)) for (const sub of interested) {
            if (Date.parse(comment.created_at) < Date.parse(sub.createdAt)) continue;
            if (sub.arguments.scope.kind === 'page' || sub.arguments.scope.kind === 'frame') {
              sub.coverage.excluded_unanchored_comments++;
              sub.coverage.complete = false;
            }
          }
          if (interested.some(s => Date.parse(comment.created_at) >= Date.parse(s.createdAt))) {
            const sequence = ++this.store.state.sequence;
            this.store.state.events.push({
              eventId: `figma_${createHash('sha256').update(`${key}:${comment.id}`).digest('hex')}`,
              name: eventName, timestamp: comment.created_at, sequence, observedAt: new Date().toISOString(),
              data: { file_key: key, ...(names.has(key) ? { file_name: names.get(key) } : {}),
                comment_id: comment.id, thread_id: root.id, parent_id: comment.parent_id || null,
                text: comment.message, author: comment.user, created_at: comment.created_at,
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
        // Commit the event log and seen IDs together before notifying a client.
        this.prune(); await this.store.save(); this.emit('events');
      } catch (error) {
        failure = error instanceof Error ? error : new Error('Polling failed');
        if (error instanceof FigmaError && [401,403,404].includes(error.status)) this.denied.add(key);
        for (const sub of interested) { sub.coverage.complete = false; sub.coverage.last_error = failure.message; }
        if (error instanceof FigmaError && error.status === 429) break;
      }
    }
    this.prune(); await this.store.save();
    if (failure) { this.emit('pollError', failure); throw failure; }
  }
  start(): void {
    const run = async () => {
      try { await this.tick(); this.failures = 0; }
      catch { this.failures++; }
      if (!this.stopped) this.timer = setTimeout(run, Math.min(900000, this.interval * 2 ** Math.min(this.failures, 4)));
    };
    this.timer = setTimeout(run, 0);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    this.closing = (async () => {
      await this.tail.catch(() => {});
      try { await this.store.save(); } finally { await this.store.close(); }
    })();
    return this.closing;
  }
}
