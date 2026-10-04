import { mkdir, readFile, writeFile, rename, unlink, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventOccurrence, Subscription, CommentSnapshot, DesignSnapshot, PendingDesign, Reaction } from './schema.js';

export interface State {
  version: 1; epoch: string; ownerId: string; sequence: number;
  subscriptions: Subscription[];
  seen: Record<string, string[]>;
  events: EventOccurrence[];
  comments: Record<string, CommentSnapshot>;
  designs: Record<string, DesignSnapshot>;
  pendingDesigns: Record<string, PendingDesign>;
  reactions: Record<string, { observedAt: string; items: Reaction[] }>;
  /** Any cursor below this sequence crossed an eviction boundary. */
  droppedThrough: number;
}
export class StateStore {
  state!: State;
  private locked = false;
  private saveTail: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async open(ownerId: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, 'process.lock');
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close(); this.locked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (failure) { alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(
        'Another Figma listen process owns this state directory. Use --state-dir for a separate client.');
      await unlink(lockPath);
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close(); this.locked = true;
    }
    try {
      const raw = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as State;
      if (raw.version !== 1 || typeof raw.epoch !== 'string' || !Number.isSafeInteger(raw.sequence) ||
          !Array.isArray(raw.events) || !Array.isArray(raw.subscriptions) || !raw.seen ||
          !Number.isSafeInteger(raw.droppedThrough)) throw new Error('Unsupported or corrupt state file');
      if (raw.ownerId !== ownerId) throw new Error('Saved state belongs to another Figma account. Use a different --state-dir.');
      // v1.1 state is migrated without replaying historical edits/designs.
      raw.comments ??= {}; raw.designs ??= {}; raw.reactions ??= {}; raw.pendingDesigns ??= {};
      for (const sub of raw.subscriptions) sub.arguments.event_types ??= ['figma.comment.created'];
      this.state = raw;
      this.state.subscriptions = raw.subscriptions.filter(s => s.source === 'tool' ||
        (s.source === 'poll' && s.expiresAt && Date.parse(s.expiresAt) > Date.now()));
      await chmod(join(this.directory, 'state.json'), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
      this.state = { version: 1, epoch: randomUUID(), ownerId, sequence: 0,
        subscriptions: [], seen: {}, events: [], comments: {}, designs: {}, pendingDesigns: {}, reactions: {}, droppedThrough: 0 };
    }
  }
  async save(): Promise<void> {
    if (!this.locked) throw new Error('Cannot save closed state store');
    const serialized = JSON.stringify(this.state);
    this.saveTail = this.saveTail.catch(() => {}).then(async () => {
      const destination = join(this.directory, 'state.json');
      const temporary = join(this.directory, `state.${process.pid}.tmp`);
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, destination);
    });
    return this.saveTail;
  }
  async close(): Promise<void> {
    await this.saveTail.catch(() => {});
    if (this.locked) { this.locked = false; await unlink(join(this.directory, 'process.lock')).catch(() => {}); }
  }
}
