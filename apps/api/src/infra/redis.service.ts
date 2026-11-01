import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { env } from "../config/env";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  /** BullMQ needs connections with maxRetriesPerRequest: null. */
  readonly bull: Redis;

  constructor() {
    this.client = new Redis(env().REDIS_URL, { lazyConnect: false });
    this.bull = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
  }

  /** A fresh connection (e.g. for the Socket.IO adapter's pub/sub). */
  duplicate(): Redis {
    return this.client.duplicate();
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.client.quit(), this.bull.quit()]);
  }
}
