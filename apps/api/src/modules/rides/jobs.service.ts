import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { Job, Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "../../config/env";

export type RideJob =
  | { name: "expand"; data: { requestId: string } }
  | { name: "expire"; data: { requestId: string } }
  | { name: "release"; data: { rideId: string } }
  | { name: "sweep"; data: Record<string, never> };

type Handler = (job: Job) => Promise<void>;

/** BullMQ queue for timed ride work: radius expansion, request expiry, earnings release, stale-driver sweep. */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Jobs");
  private queue!: Queue;
  private worker: Worker | null = null;
  private connections: Redis[] = [];
  private handlers = new Map<string, Handler>();

  constructor(private readonly moduleRef: ModuleRef) {}

  private conn() {
    const c = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
    this.connections.push(c);
    return c;
  }

  register(name: RideJob["name"], handler: Handler) {
    this.handlers.set(name, handler);
  }

  async onModuleInit() {
    const prefix = env().NODE_ENV === "test" ? `zuma-test-${process.pid}` : "zuma";
    this.queue = new Queue("rides", { connection: this.conn(), prefix, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: "exponential", delay: 1000 } } });
    if (env().WORKER_ENABLED) {
      this.worker = new Worker(
        "rides",
        async (job) => {
          const h = this.handlers.get(job.name);
          if (!h) throw new Error(`No handler for job ${job.name}`);
          await h(job);
        },
        { connection: this.conn(), prefix, concurrency: 10 },
      );
      this.worker.on("failed", (job, err) => this.log.error(`Job ${job?.name}:${job?.id} failed: ${err.message}`));
      await this.queue.upsertJobScheduler("sweep-stale-drivers", { every: 30_000 }, { name: "sweep", data: {} });
    }
  }

  async add<J extends RideJob>(name: J["name"], data: J["data"], opts: { delayMs?: number; jobId?: string } = {}) {
    await this.queue.add(name, data, { delay: opts.delayMs, jobId: opts.jobId });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
