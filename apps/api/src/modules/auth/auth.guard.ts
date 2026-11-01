import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError } from "../../common/errors";
import type { AppRequest, AuthContext } from "../../common/http";
import { PrismaService } from "../../infra/prisma.service";
import { RedisService } from "../../infra/redis.service";
import { TokensService } from "./tokens.service";

export const PUBLIC = "public";
export const SCOPES = "scopes";
export const PERMISSION = "permission";

/** Route needs no token. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route accepts only tokens issued to these apps. */
export const Scopes = (...s: AuthContext["scope"][]) => SetMetadata(SCOPES, s);
/** Admin route requiring a permission key (resource:action). Implies ADMIN scope. */
export const RequirePermission = (p: string) => SetMetadata(PERMISSION, p);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new DomainError("UNAUTHENTICATED", "Sign in required");
    const auth = await this.tokens.verifyAccess(header.slice(7));

    // Revoked sessions (logout, logout-all, suspension) are pushed to Redis so access tokens die immediately.
    if (await this.redis.client.exists(`sess:revoked:${auth.sessionId}`)) {
      throw new DomainError("UNAUTHENTICATED", "This session was signed out");
    }
    req.auth = auth;

    const scopes = this.reflector.getAllAndOverride<AuthContext["scope"][]>(SCOPES, targets);
    const permission = this.reflector.getAllAndOverride<string>(PERMISSION, targets);
    if (scopes && !scopes.includes(auth.scope)) throw new DomainError("FORBIDDEN", "This action is not available in this app");
    if (permission) {
      if (auth.scope !== "ADMIN") throw new DomainError("FORBIDDEN", "Admin access required");
      const has = await this.hasPermission(auth.userId, permission);
      if (!has) throw new DomainError("FORBIDDEN", `Missing permission ${permission}`);
    }
    return true;
  }

  private async hasPermission(userId: string, key: string): Promise<boolean> {
    const cacheKey = `perms:${userId}`;
    let perms = await this.redis.client.smembers(cacheKey);
    if (perms.length === 0) {
      const rows = await this.prisma.db.rolePermission.findMany({
        where: { role: { users: { some: { userId } } } },
        select: { permission: { select: { key: true } } },
      });
      perms = rows.map((r) => r.permission.key);
      if (perms.length) {
        await this.redis.client.sadd(cacheKey, ...perms);
        await this.redis.client.expire(cacheKey, 300);
      }
    }
    return perms.includes(key);
  }
}
