import { Body, Controller, Headers, HttpCode, Post } from "@nestjs/common";
import { AppScope, OtpRequestBody, OtpVerifyBody, RefreshBody } from "@zuma/contracts";
import { z } from "zod";
import { Auth, AuthContext, ClientIp, ZodPipe } from "../../common/http";
import { Public } from "./auth.guard";
import { AuthService } from "./auth.service";

const VerifyBody = OtpVerifyBody.extend({ appScope: AppScope });

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post("otp/request")
  @HttpCode(200)
  request(@Body(new ZodPipe(OtpRequestBody)) body: OtpRequestBody, @ClientIp() ip: string) {
    return this.auth.requestOtp(body, ip);
  }

  @Public()
  @Post("otp/verify")
  @HttpCode(200)
  verify(@Body(new ZodPipe(VerifyBody)) body: z.infer<typeof VerifyBody>, @ClientIp() ip: string, @Headers("user-agent") ua?: string) {
    return this.auth.verifyOtp(body, ip, ua);
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) body: { refreshToken: string }, @ClientIp() ip: string, @Headers("user-agent") ua?: string) {
    return this.auth.refresh(body.refreshToken, ip, ua);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext) {
    await this.auth.logout(auth.sessionId);
  }

  @Post("logout-all")
  @HttpCode(204)
  async logoutAll(@Auth() auth: AuthContext) {
    await this.auth.logoutAll(auth.userId);
  }
}
