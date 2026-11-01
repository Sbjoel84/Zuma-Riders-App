import {
  ArgumentsHost,
  CallHandler,
  Catch,
  createParamDecorator,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  PipeTransform,
  SetMetadata,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import type { Request, Response } from "express";
import { Observable, from, of, switchMap, tap } from "rxjs";
import { ZodError, ZodSchema } from "zod";
import { DomainError } from "./errors";
import { RedisService } from "../infra/redis.service";

// ---------- request context ----------

export interface AuthContext {
  userId: string;
  scope: "PASSENGER" | "DRIVER" | "ADMIN";
  sessionId: string;
  roles: string[];
}

export type AppRequest = Request & { auth?: AuthContext; requestId?: string };

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.auth) throw new DomainError("UNAUTHENTICATED", "Sign in required");
  return req.auth;
});

export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  return (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
});

export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(key)) {
    throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (a UUID) with this request");
  }
  return key;
});

// ---------- validation ----------

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new DomainError("VALIDATION_FAILED", "Some fields are invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    return r.data;
  }
}

// ---------- errors ----------

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Errors");
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<AppRequest>();
    const requestId = req.requestId;

    if (exception instanceof DomainError) {
      return res.status(exception.status).json({ error: { code: exception.code, message: exception.message, details: exception.details, requestId } });
    }
    if (exception instanceof ZodError) {
      return res.status(422).json({ error: { code: "VALIDATION_FAILED", message: "Some fields are invalid", details: exception.issues, requestId } });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "VALIDATION_FAILED";
      return res.status(status).json({ error: { code, message: exception.message, requestId } });
    }
    this.log.error(`Unhandled error on ${req.method} ${req.url} [${requestId}]`, exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on our side", requestId } });
  }
}

// ---------- idempotency ----------

export const IDEMPOTENT = "idempotent";
/** Marks a mutating route as replay-safe: same key + same body returns the stored response for 24h. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly redis: RedisService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const handler = ctx.getHandler();
    if (!Reflect.getMetadata(IDEMPOTENT, handler)) return next.handle();
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9-]{8,100}$/.test(key)) {
      throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header (a UUID) with this request");
    }
    const owner = req.auth?.userId ?? "anon";
    const redisKey = `idem:${owner}:${key}`;
    const hash = createHash("sha256").update(req.method + req.originalUrl + JSON.stringify(req.body ?? {})).digest("hex");
    const r = this.redis.client;

    return from(r.set(redisKey, JSON.stringify({ state: "pending", hash }), "EX", 86400, "NX")).pipe(
      switchMap((acquired) => {
        if (acquired) {
          return next.handle().pipe(
            tap({
              next: (body) => void r.set(redisKey, JSON.stringify({ state: "done", hash, status: res.statusCode, body }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), "EX", 86400),
              error: () => void r.del(redisKey),
            }),
          );
        }
        return from(r.get(redisKey)).pipe(
          switchMap((raw) => {
            const stored = raw ? JSON.parse(raw) : null;
            if (!stored) return next.handle();
            if (stored.hash !== hash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for a different request");
            if (stored.state === "pending") throw new DomainError("IDEMPOTENCY_IN_PROGRESS", "The original request is still being processed");
            res.status(stored.status);
            res.setHeader("Idempotent-Replayed", "true");
            return of(stored.body);
          }),
        );
      }),
    );
  }
}

export function requestIdMiddleware(req: AppRequest, res: Response, next: () => void) {
  const incoming = req.headers["x-request-id"];
  req.requestId = typeof incoming === "string" && incoming.length < 100 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
}
