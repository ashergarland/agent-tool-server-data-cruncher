import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { buildChildEnvironment } from './child-environment.js';
import { resolveExecutables, type Executables } from './executables.js';
import { BoundedQueue } from './queue.js';

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'closed';

export interface RuntimeWorkspace {
  readonly root: string;
  readonly childTempDir: string;
  readonly materializeDir: string;
}

/**
 * Process-wide execution context: resolved binaries, isolated scratch space, bounded queues and
 * shutdown state. Initialisation is memoised so `createApplication()` stays synchronous.
 */
export class Runtime {
  public readonly toolQueue: BoundedQueue;
  public readonly uploadQueue: BoundedQueue;

  private readonly abortController = new AbortController();
  private state: LifecycleState = 'starting';
  private workspacePromise: Promise<RuntimeWorkspace> | undefined;
  private executablesPromise: Promise<Executables> | undefined;
  private cachedExecutables: Executables | undefined;

  public constructor(private readonly config: AppConfig) {
    this.toolQueue = new BoundedQueue(
      config.limits.toolConcurrency,
      config.limits.toolQueueLimit,
      'tool work',
    );
    this.uploadQueue = new BoundedQueue(
      config.limits.uploadConcurrency,
      config.limits.toolQueueLimit,
      'uploads',
    );
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  public get lifecycleState(): LifecycleState {
    return this.state;
  }

  public get isAccepting(): boolean {
    return this.state === 'starting' || this.state === 'ready';
  }

  public get executableVersions(): Record<string, string> | undefined {
    if (!this.cachedExecutables) return undefined;
    return {
      jq: this.cachedExecutables.jq.version,
      ripgrep: this.cachedExecutables.ripgrep.version,
    };
  }

  /**
   * Memoises a lazily-initialised resource, but drops the memo if it rejects so a transient
   * failure (tmpfs not yet mounted, a probe timing out under load) does not become permanent for
   * the life of the process. `check()` is deliberately re-runnable and readiness is only cached
   * for a few seconds, so the next caller must be able to retry.
   */
  private memoize<T>(
    read: () => Promise<T> | undefined,
    store: (promise: Promise<T> | undefined) => void,
    create: () => Promise<T>,
  ): Promise<T> {
    const existing = read();
    if (existing) return existing;
    const promise = create().catch((error: unknown) => {
      store(undefined);
      throw error;
    });
    store(promise);
    return promise;
  }

  public workspace(): Promise<RuntimeWorkspace> {
    return this.memoize(
      () => this.workspacePromise,
      (promise) => {
        this.workspacePromise = promise;
      },
      async () => {
        const root = join(
          this.config.limits.tempDir,
          `data-cruncher-${process.pid}-${randomBytes(6).toString('hex')}`,
        );
        const workspace: RuntimeWorkspace = {
          root,
          childTempDir: join(root, 'child'),
          materializeDir: join(root, 'materialized'),
        };
        await mkdir(workspace.childTempDir, { recursive: true, mode: 0o700 });
        await mkdir(workspace.materializeDir, { recursive: true, mode: 0o700 });
        return workspace;
      },
    );
  }

  public executables(): Promise<Executables> {
    return this.memoize(
      () => this.executablesPromise,
      (promise) => {
        this.executablesPromise = promise;
      },
      async () => {
        const workspace = await this.workspace();
        const executables = await resolveExecutables({ tempDir: workspace.childTempDir });
        this.cachedExecutables = executables;
        return executables;
      },
    );
  }

  public async childEnvironment(): Promise<Record<string, string>> {
    const [{ pathEntries }, workspace] = await Promise.all([this.executables(), this.workspace()]);
    return buildChildEnvironment({ pathEntries, tempDir: workspace.childTempDir });
  }

  /** Verifies scratch space and binaries without touching caller data. */
  public async check(): Promise<void> {
    const workspace = await this.workspace();
    const probe = join(workspace.root, `.readiness-${randomBytes(4).toString('hex')}`);
    await writeFile(probe, 'ok', { mode: 0o600 });
    await rm(probe, { force: true });
    await this.executables();
    if (this.state === 'starting') this.state = 'ready';
  }

  public beginDraining(): void {
    if (this.state === 'closed') return;
    this.state = 'draining';
    this.toolQueue.close();
    this.uploadQueue.close();
    this.abortController.abort();
  }

  public async close(): Promise<void> {
    this.beginDraining();
    this.state = 'closed';
    const workspace = await this.workspacePromise?.catch(() => undefined);
    if (workspace) await rm(workspace.root, { recursive: true, force: true });
  }
}

export const createRuntime = (config: AppConfig): Runtime => new Runtime(config);
