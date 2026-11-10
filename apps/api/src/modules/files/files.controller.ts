import { Body, Controller, Get, Param, Post, Put, Req, Res } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { fail } from "../../common/errors";
import { Auth, type AuthContext, ZodPipe } from "../../common/http";
import { env } from "../../config/env";
import { sha256, verifyToken } from "../../infra/crypto";
import { PrismaService } from "../../infra/prisma.service";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, StorageService } from "../../infra/storage.service";
import { Public } from "../auth/auth.guard";

const UploadBody = z.object({
  purpose: z.enum(["DRIVER_DOCUMENT", "VEHICLE_DOCUMENT", "CHAT_IMAGE", "AVATAR"]),
  mimeType: z.enum(ALLOWED_MIME),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES, "Files can be up to 10 MB"),
});
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

/**
 * Uploads go straight from the phone to storage with a presigned PUT; the API only records the file and
 * later checks it exists before attaching it to a document or message.
 */
@Controller("v1/files")
export class FilesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Post("uploads")
  async createUpload(@Auth() auth: AuthContext, @Body(new ZodPipe(UploadBody)) body: z.infer<typeof UploadBody>) {
    if (body.purpose === "CHAT_IMAGE" && body.mimeType === "application/pdf") fail("FILE_INVALID", "Only photos can be sent in chat");
    const key = `${body.purpose.toLowerCase().replace("_", "-")}/${auth.userId}/${randomUUID()}.${EXT[body.mimeType]}`;
    const file = await this.prisma.db.fileObject.create({
      data: { uploaderId: auth.userId, bucket: this.storage.bucket, objectKey: key, mimeType: body.mimeType, sizeBytes: body.sizeBytes, sha256: "", isPrivate: true },
    });
    const put = await this.storage.presignPut(key, body.mimeType, body.sizeBytes);
    return { fileId: file.id, uploadUrl: put.url, method: "PUT", headers: put.headers, expiresInS: 900 };
  }

  /** Development storage: receives the bytes for a signed upload URL. */
  @Public()
  @Put("local/:token")
  async localPut(@Param("token") token: string, @Req() req: Request, @Res() res: Response) {
    const t = env().STORAGE_PROVIDER === "local" ? verifyToken<{ k: string; op: string; m: string; s: number }>(token) : null;
    if (!t || t.op !== "put") return res.status(403).json({ error: { code: "FORBIDDEN", message: "Upload link expired" } });
    if ((req.headers["content-type"] ?? "").split(";")[0] !== t.m) return res.status(400).json({ error: { code: "FILE_INVALID", message: "Content-Type does not match the upload" } });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > Math.min(t.s, MAX_UPLOAD_BYTES)) return res.status(413).json({ error: { code: "FILE_INVALID", message: "File is larger than declared" } });
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    await this.storage.writeLocal(t.k, data);
    await this.prisma.db.fileObject.update({ where: { objectKey: t.k }, data: { sha256: sha256(data), sizeBytes: data.length, scanStatus: "CLEAN" } });
    return res.status(200).end();
  }

  /** Development storage: serves a file for a signed download URL. */
  @Public()
  @Get("local/:token")
  async localGet(@Param("token") token: string, @Res() res: Response) {
    const t = env().STORAGE_PROVIDER === "local" ? verifyToken<{ k: string; op: string }>(token) : null;
    if (!t || t.op !== "get") return res.status(403).send("Link expired");
    const f = await this.prisma.db.fileObject.findUnique({ where: { objectKey: t.k } });
    if (!f) return res.status(404).send("Not found");
    const data = await this.storage.readLocal(t.k).catch(() => null);
    if (!data) return res.status(404).send("Not found");
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    return res.send(data);
  }
}
