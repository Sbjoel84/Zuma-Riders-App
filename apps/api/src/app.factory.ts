import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import Redis from "ioredis";
import type { ServerOptions } from "socket.io";
import { AppModule } from "./app.module";
import { requestIdMiddleware } from "./common/http";
import { env } from "./config/env";

/** Socket.IO with the Redis adapter so events fan out across API instances. */
class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private clients: Redis[] = [];

  async connect() {
    const pub = new Redis(env().REDIS_URL);
    const sub = pub.duplicate();
    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, { ...options, pingInterval: 20000, pingTimeout: 20000 });
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close() {
    await Promise.allSettled(this.clients.map((c) => c.quit()));
  }
}

export async function createApp(): Promise<{ app: INestApplication; close: () => Promise<void> }> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: env().NODE_ENV === "test" ? ["error"] : ["log", "warn", "error"], rawBody: true });
  // BigInt (kobo) serialises as a string everywhere.
  app.set("json replacer", (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(requestIdMiddleware);
  const origins = env().CORS_ORIGINS === "*" ? true : env().CORS_ORIGINS.split(",");
  app.enableCors({ origin: origins, credentials: true });
  const io = new RedisIoAdapter(app);
  await io.connect();
  app.useWebSocketAdapter(io);
  app.enableShutdownHooks();
  return {
    app,
    close: async () => {
      await app.close();
      await io.close();
    },
  };
}
