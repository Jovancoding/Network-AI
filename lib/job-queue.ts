/**
 * Persistent Job Queue — Resumable task orchestration with durable storage
 *
 * Provides a job queue that persists jobs to disk (JSON files) with support
 * for status tracking, retries, priority ordering, and crash recovery.
 * Designed for long-running swarm orchestration tasks that must survive
 * process restarts.
 *
 * Backends:
 *   - FileJobStore (built-in) — JSON files in a directory
 *   - IJobStore interface — implement for SQLite, Postgres, etc.
 *
 * Features:
 *   - Priority-based FIFO queue
 *   - Configurable retries with exponential backoff
 *   - Job timeout enforcement
 *   - Crash recovery: stale "running" jobs are re-queued on startup
 *   - Pluggable storage backends
 *
 * Usage:
 *   const queue = new JobQueue({ store: new FileJobStore('./data/jobs') });
 *   await queue.start();
 *   await queue.enqueue({ type: 'delegateTask', payload: { agentId: 'analyzer', ... } });
 *
 * @module JobQueue
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, readdir, unlink, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

// ============================================================================
// TYPES
// ============================================================================

/** Job status */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Priority level (lower = higher priority) */
export type JobPriority = 0 | 1 | 2 | 3 | 4 | 5;

/** A persistent job record */
export interface JobRecord {
  /** Unique job ID */
  id: string;
  /** Job type (e.g. 'delegateTask', 'batchProcess') */
  type: string;
  /** Job payload — any serializable data */
  payload: Record<string, unknown>;
  /** Current status */
  status: JobStatus;
  /** Priority (0 = highest, 5 = lowest; default: 2) */
  priority: JobPriority;
  /** Number of attempts so far */
  attempts: number;
  /** Maximum attempts (default: 3) */
  maxAttempts: number;
  /** When the job was created */
  createdAt: number;
  /** When the job was last updated */
  updatedAt: number;
  /** When the job started running */
  startedAt?: number;
  /** When the job completed or failed */
  completedAt?: number;
  /** Result data (on success) */
  result?: unknown;
  /** Error message (on failure) */
  error?: string;
  /** Job timeout in ms (default: 300000 = 5 min) */
  timeoutMs: number;
  /** Metadata for tracking */
  metadata?: Record<string, unknown>;
}

/** Options for creating a new job */
export interface JobCreateOptions {
  /** Job type */
  type: string;
  /** Job payload */
  payload: Record<string, unknown>;
  /** Priority (default: 2) */
  priority?: JobPriority;
  /** Max attempts (default: 3) */
  maxAttempts?: number;
  /** Timeout in ms (default: 300000) */
  timeoutMs?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Job handler function — processes a single job.
 * Return a result on success, or throw to fail.
 */
export type JobHandler = (job: JobRecord) => Promise<unknown>;

/** Job queue configuration */
export interface JobQueueConfig {
  /** Storage backend */
  store: IJobStore;
  /** Polling interval in ms (default: 1000) */
  pollIntervalMs?: number;
  /** Maximum concurrent jobs (default: 5) */
  concurrency?: number;
  /** Base retry delay in ms (default: 1000) */
  retryBaseDelayMs?: number;
  /** Maximum retry delay in ms (default: 60000) */
  retryMaxDelayMs?: number;
  /** Stale job threshold in ms — re-queue "running" jobs older than this (default: 600000 = 10 min) */
  staleThresholdMs?: number;
}

/** Stats snapshot */
export interface JobQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

// ============================================================================
// STORE INTERFACE
// ============================================================================

/**
 * Pluggable storage backend for the job queue.
 * Implement this for SQLite, Postgres, Redis, etc.
 */
export interface IJobStore {
  /** Initialize the store (create tables/dirs) */
  init(): Promise<void>;
  /** Save or update a job */
  save(job: JobRecord): Promise<void>;
  /** Get a job by ID */
  get(id: string): Promise<JobRecord | null>;
  /** Delete a job by ID */
  delete(id: string): Promise<void>;
  /** List jobs by status, ordered by priority ASC then createdAt ASC */
  listByStatus(status: JobStatus, limit?: number): Promise<JobRecord[]>;
  /** Count jobs by status */
  countByStatus(status: JobStatus): Promise<number>;
  /** Find stale running jobs (startedAt < threshold) */
  findStale(thresholdMs: number): Promise<JobRecord[]>;
}

// ============================================================================
// FILE JOB STORE
// ============================================================================

/**
 * File-system job store — persists jobs as individual JSON files.
 * Simple and dependency-free. Suitable for single-node deployments.
 */
export class FileJobStore implements IJobStore {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    try {
      await stat(this.dir);
    } catch {
      await mkdir(this.dir, { recursive: true });
    }
  }

  async save(job: JobRecord): Promise<void> {
    const filePath = join(this.dir, `${job.id}.json`);
    await writeFile(filePath, JSON.stringify(job, null, 2), 'utf-8');
  }

  async get(id: string): Promise<JobRecord | null> {
    try {
      const filePath = join(this.dir, `${id}.json`);
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as JobRecord;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(join(this.dir, `${id}.json`));
    } catch {
      // Ignore if already deleted
    }
  }

  async listByStatus(status: JobStatus, limit = 100): Promise<JobRecord[]> {
    const files = await readdir(this.dir);
    const jobs: JobRecord[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.dir, file), 'utf-8');
        const job = JSON.parse(raw) as JobRecord;
        if (job.status === status) jobs.push(job);
      } catch {
        // Skip corrupt files
      }
    }

    // Sort by priority ASC, then createdAt ASC
    jobs.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    return jobs.slice(0, limit);
  }

  async countByStatus(status: JobStatus): Promise<number> {
    const jobs = await this.listByStatus(status, Infinity);
    return jobs.length;
  }

  async findStale(thresholdMs: number): Promise<JobRecord[]> {
    const cutoff = Date.now() - thresholdMs;
    const running = await this.listByStatus('running', Infinity);
    return running.filter((j) => j.startedAt !== undefined && j.startedAt < cutoff);
  }
}

// ============================================================================
// JOB QUEUE
// ============================================================================

/**
 * Persistent job queue with priority ordering, retries, and crash recovery.
 *
 * Register handlers for job types, then start the queue. Jobs are
 * persisted to the configured store and survive process restarts.
 */
export class JobQueue extends EventEmitter {
  private handlers = new Map<string, JobHandler>();
  private activeJobs = new Map<string, Promise<void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly store: IJobStore;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly staleThresholdMs: number;

  constructor(config: JobQueueConfig) {
    super();
    this.store = config.store;
    this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    this.concurrency = config.concurrency ?? 5;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.retryMaxDelayMs = config.retryMaxDelayMs ?? 60_000;
    this.staleThresholdMs = config.staleThresholdMs ?? 600_000;
  }

  /** Register a handler for a job type */
  handle(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Start the queue: init store, recover stale jobs, begin polling */
  async start(): Promise<void> {
    if (this.running) return;

    await this.store.init();
    await this.recoverStaleJobs();

    this.running = true;
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => this.emit('error', err));
    }, this.pollIntervalMs);
    this.emit('started');
  }

  /** Stop the queue (active jobs continue but no new ones are dequeued) */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for active jobs to finish
    await Promise.allSettled(this.activeJobs.values());
    this.activeJobs.clear();
    this.emit('stopped');
  }

  /** Enqueue a new job */
  async enqueue(options: JobCreateOptions): Promise<JobRecord> {
    const job: JobRecord = {
      id: randomBytes(8).toString('hex'),
      type: options.type,
      payload: options.payload,
      status: 'pending',
      priority: options.priority ?? 2 as JobPriority,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timeoutMs: options.timeoutMs ?? 300_000,
      metadata: options.metadata,
    };

    await this.store.save(job);
    this.emit('enqueued', job);
    return job;
  }

  /** Cancel a pending or running job */
  async cancel(jobId: string): Promise<JobRecord | null> {
    const job = await this.store.get(jobId);
    if (!job) return null;
    if (job.status === 'completed' || job.status === 'cancelled') return job;

    job.status = 'cancelled';
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    await this.store.save(job);
    this.emit('cancelled', job);
    return job;
  }

  /** Get a job by ID */
  async getJob(jobId: string): Promise<JobRecord | null> {
    return this.store.get(jobId);
  }

  /** Get queue stats */
  async stats(): Promise<JobQueueStats> {
    const [pending, running, completed, failed, cancelled] = await Promise.all([
      this.store.countByStatus('pending'),
      this.store.countByStatus('running'),
      this.store.countByStatus('completed'),
      this.store.countByStatus('failed'),
      this.store.countByStatus('cancelled'),
    ]);
    return { pending, running, completed, failed, cancelled, total: pending + running + completed + failed + cancelled };
  }

  /** Whether the queue is running */
  get isRunning(): boolean {
    return this.running;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.running) return;

    const availableSlots = this.concurrency - this.activeJobs.size;
    if (availableSlots <= 0) return;

    const jobs = await this.store.listByStatus('pending', availableSlots);
    for (const job of jobs) {
      if (this.activeJobs.has(job.id)) continue;
      if (job.status !== 'pending') continue;

      const handler = this.handlers.get(job.type);
      if (!handler) {
        this.emit('unhandled', job);
        continue;
      }

      const jobPromise = this.processJob(job, handler);
      this.activeJobs.set(job.id, jobPromise);
      jobPromise.finally(() => this.activeJobs.delete(job.id));
    }
  }

  private async processJob(job: JobRecord, handler: JobHandler): Promise<void> {
    // Mark as running
    job.status = 'running';
    job.attempts++;
    job.startedAt = Date.now();
    job.updatedAt = Date.now();
    await this.store.save(job);
    this.emit('processing', job);

    try {
      const result = await Promise.race([
        handler(job),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Job timed out after ${job.timeoutMs}ms`)), job.timeoutMs),
        ),
      ]);

      // Success
      job.status = 'completed';
      job.result = result;
      job.completedAt = Date.now();
      job.updatedAt = Date.now();
      await this.store.save(job);
      this.emit('completed', job);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (job.attempts < job.maxAttempts) {
        // Retry with backoff
        const delay = Math.min(
          this.retryBaseDelayMs * Math.pow(2, job.attempts - 1),
          this.retryMaxDelayMs,
        );
        job.status = 'pending';
        job.error = errorMsg;
        job.updatedAt = Date.now();
        // Add delay before re-processing by updating createdAt (moves to back of queue)
        job.createdAt = Date.now() + delay;
        await this.store.save(job);
        this.emit('retry', job, delay);
      } else {
        // Final failure
        job.status = 'failed';
        job.error = errorMsg;
        job.completedAt = Date.now();
        job.updatedAt = Date.now();
        await this.store.save(job);
        this.emit('failed', job);
      }
    }
  }

  private async recoverStaleJobs(): Promise<void> {
    const stale = await this.store.findStale(this.staleThresholdMs);
    for (const job of stale) {
      if (job.attempts < job.maxAttempts) {
        job.status = 'pending';
        job.updatedAt = Date.now();
        await this.store.save(job);
        this.emit('recovered', job);
      } else {
        job.status = 'failed';
        job.error = 'Stale job exceeded max attempts';
        job.completedAt = Date.now();
        job.updatedAt = Date.now();
        await this.store.save(job);
        this.emit('failed', job);
      }
    }
  }
}
