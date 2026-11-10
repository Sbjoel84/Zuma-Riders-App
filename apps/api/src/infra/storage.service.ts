import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { signToken } from "./crypto";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

/**
 * Private object storage for driver documents and chat images.
 * `s3` works with any S3-compatible store (Cloudflare R2, AWS S3, DigitalOcean Spaces) through presigned
 * URLs, so files never pass through the API. `local` (development only) stores files on disk and signs
 * short-lived upload/download URLs served by FilesController.
 */
@Injectable()
export class StorageService {
  private s3: S3Client | null = null;

  get bucket() {
    return env().STORAGE_PROVIDER === "s3" ? env().S3_BUCKET! : "local";
  }

  private client() {
    if (!this.s3) {
      const e = env();
      this.s3 = new S3Client({
        region: e.S3_REGION, endpoint: e.S3_ENDPOINT, forcePathStyle: Boolean(e.S3_ENDPOINT),
        credentials: { accessKeyId: e.S3_ACCESS_KEY_ID!, secretAccessKey: e.S3_SECRET_ACCESS_KEY! },
      });
    }
    return this.s3;
  }

  localPath(key: string) {
    const root = path.resolve(env().STORAGE_LOCAL_DIR);
    const p = path.resolve(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error("Invalid object key");
    return p;
  }

  async presignPut(key: string, mimeType: string, sizeBytes: number): Promise<{ url: string; headers: Record<string, string> }> {
    if (env().STORAGE_PROVIDER === "local") {
      return { url: `${env().PUBLIC_API_URL}/v1/files/local/${signToken({ k: key, op: "put", m: mimeType, s: sizeBytes }, 900)}`, headers: { "Content-Type": mimeType } };
    }
    const url = await getSignedUrl(this.client(), new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType, ContentLength: sizeBytes }), { expiresIn: 900 });
    return { url, headers: { "Content-Type": mimeType } };
  }

  async presignGet(key: string, ttlS = 300): Promise<string> {
    if (env().STORAGE_PROVIDER === "local") return `${env().PUBLIC_API_URL}/v1/files/local/${signToken({ k: key, op: "get" }, ttlS)}`;
    return getSignedUrl(this.client(), new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttlS });
  }

  /** Size of the stored object, or null when nothing was uploaded. */
  async head(key: string): Promise<{ size: number } | null> {
    if (env().STORAGE_PROVIDER === "local") {
      const st = await stat(this.localPath(key)).catch(() => null);
      return st ? { size: st.size } : null;
    }
    try {
      const r = await this.client().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch {
      return null;
    }
  }

  async writeLocal(key: string, data: Buffer) {
    const p = this.localPath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async readLocal(key: string) {
    return readFile(this.localPath(key));
  }
}
