import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../../config/env";
import { DomainError } from "../../common/errors";
import type { AuthContext } from "../../common/http";

const ISSUER = "zuma-api";

@Injectable()
export class TokensService {
  private key() {
    return new TextEncoder().encode(env().JWT_SECRET);
  }

  async signAccess(ctx: AuthContext): Promise<string> {
    return new SignJWT({ scope: ctx.scope, sid: ctx.sessionId, roles: ctx.roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(ctx.userId)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${env().ACCESS_TOKEN_TTL_S}s`)
      .sign(this.key());
  }

  async verifyAccess(token: string): Promise<AuthContext> {
    try {
      const { payload } = await jwtVerify(token, this.key(), { issuer: ISSUER, algorithms: ["HS256"] });
      return {
        userId: String(payload.sub),
        scope: payload.scope as AuthContext["scope"],
        sessionId: String(payload.sid),
        roles: (payload.roles as string[]) ?? [],
      };
    } catch {
      throw new DomainError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
    }
  }

  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: this.hashRefresh(token) };
  }

  hashRefresh(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
