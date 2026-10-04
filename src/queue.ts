interface Job {
  key: string;
  run: () => Promise<unknown>;
  done: Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

/** FIFO dispatch, paced starts, bounded concurrency, and one slot per resource. */
export class ResourceQueue {
  private jobs = new Map<string, Job>();
  private waiting: Job[] = [];
  private active = new Set<string>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private idleWaiters: (() => void)[] = [];
  private nextStartAt = 0;
  private pausedUntil = 0;
  private coalesced = 0;
  readonly maxConcurrent: number;
  readonly startIntervalMs: number;

  constructor(options: { maxConcurrent?: number; startIntervalMs?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.startIntervalMs = options.startIntervalMs ?? 0;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) throw new Error('Invalid concurrency limit');
    if (!Number.isFinite(this.startIntervalMs) || this.startIntervalMs < 0) throw new Error('Invalid request spacing');
  }

  enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Request queue closed'));
    const existing = this.jobs.get(key);
    if (existing) { this.coalesced++; return existing.done as Promise<T>; }
    let resolve!: (result: unknown) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    // Periodic producers need not wait; callers may still await the original result.
    void done.catch(() => {});
    const job = { key, run, done, resolve, reject };
    this.jobs.set(key, job); this.waiting.push(job); this.dispatch();
    return done as Promise<T>;
  }

  /** Backoff is a shared dispatch gate, not a sleep in each individual job. */
  pause(milliseconds: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.max(0, milliseconds));
    this.dispatch();
  }
  private dispatch(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.stopped) return;
    while (this.waiting.length && this.active.size < this.maxConcurrent) {
      const delay = Math.max(this.nextStartAt, this.pausedUntil) - Date.now();
      if (delay > 0) { this.timer = setTimeout(() => this.dispatch(), Math.min(delay, 2147483647)); return; }
      const job = this.waiting.shift()!;
      this.active.add(job.key); this.nextStartAt = Date.now() + this.startIntervalMs;
      // Dispatch does not await the response. Completion only releases this job's slot.
      void Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
        this.active.delete(job.key); this.jobs.delete(job.key); this.dispatch();
        if (!this.active.size && !this.waiting.length) for (const resolve of this.idleWaiters.splice(0)) resolve();
      });
    }
  }

  status(): { queued_resources: number; running_resources: string[]; coalesced_requests: number;
    max_concurrent_jobs: number; backoff_until: string | null } {
    return { queued_resources: this.waiting.length, running_resources: [...this.active],
      coalesced_requests: this.coalesced, max_concurrent_jobs: this.maxConcurrent,
      backoff_until: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null };
  }
  idle(): Promise<void> {
    if (!this.active.size && !this.waiting.length) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const job of this.waiting.splice(0)) { this.jobs.delete(job.key); job.reject(new Error('Request queue closed')); }
    if (!this.active.size) for (const resolve of this.idleWaiters.splice(0)) resolve();
    await this.idle();
  }
}
