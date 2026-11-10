import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { Scopes } from "../auth/auth.guard";
import { ChatService } from "./chat.service";

const SendBody = z.object({
  clientMessageId: z.string().min(8).max(64),
  body: z.string().max(500).optional(),
  attachmentId: z.string().optional(),
  quickReply: z.boolean().optional(),
});

@Scopes("PASSENGER", "DRIVER")
@Controller("v1/rides/:id/messages")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.list(id, auth);
  }

  @Post()
  send(@Auth() auth: AuthContext, @Param("id") id: string, @Body(new ZodPipe(SendBody)) body: z.infer<typeof SendBody>) {
    return this.chat.send(id, auth, body);
  }

  @Post("read")
  @HttpCode(200)
  read(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.chat.markRead(id, auth);
  }
}
