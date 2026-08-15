import { busy } from '../errors.js';

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort?: () => void;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Bounded work queue: at most `concurrency` tasks run at once and at most `queueLimit` tasks
 * wait. Saturation produces a typed retryable error instead of unbounded memory growth.
 */
export class BoundedQueue {
  private running = 0;
  private closed = false;
  private readonly waiters: Waiter[] = [];

  public constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
    private readonly label = 'work',
  ) {}

  public get active(): number {
    return this.running;
  }

  public get queued(): number {
    return this.waiters.length;
  }

  public close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(busy(`The server is shutting down and cannot accept ${this.label}`));
    }
  }

  public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      return Promise.reject(busy(`The server is shutting down and cannot accept ${this.label}`));
    }
    if (signal?.aborted) {
      return Promise.reject(busy('The request was cancelled before it started'));
    }
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(
        busy(`Too much ${this.label} in progress; retry after a short delay`, {
          active: this.running,
          queued: this.waiters.length,
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(busy('The request was cancelled while queued'));
        },
      };
      if (signal && waiter.onAbort)
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.running -= 1;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.running += 1;
    waiter.resolve();
  }
}
