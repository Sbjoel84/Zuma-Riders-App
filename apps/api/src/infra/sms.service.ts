import { Injectable, Logger } from "@nestjs/common";
import { env } from "../config/env";

export interface SentSms {
  to: string;
  body: string;
  at: Date;
}

/**
 * SMS delivery. `console` (dev/test only — refused in production by env validation) logs the message
 * and keeps the last messages in memory so tests can read OTPs; `termii` sends through Termii.
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger("SMS");
  readonly outbox: SentSms[] = [];

  async send(to: string, body: string): Promise<{ providerRef: string | null; provider: string }> {
    const e = env();
    if (e.SMS_PROVIDER === "console") {
      this.outbox.push({ to, body, at: new Date() });
      if (this.outbox.length > 200) this.outbox.shift();
      if (e.NODE_ENV !== "test") this.log.log(`[dev SMS] to ${to}: ${body}`);
      return { providerRef: null, provider: "console" };
    }
    const res = await fetch("https://api.ng.termii.com/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: to.replace("+", ""), from: e.TERMII_SENDER_ID, sms: body, type: "plain", channel: "dnd", api_key: e.TERMII_API_KEY }),
    });
    const json = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
    if (!res.ok) {
      this.log.error(`Termii send failed (${res.status}): ${json.message ?? "unknown"}`);
      throw new Error("SMS provider rejected the message");
    }
    return { providerRef: json.message_id ?? null, provider: "termii" };
  }

  /** Test helper. */
  lastTo(phone: string): SentSms | undefined {
    return [...this.outbox].reverse().find((m) => m.to === phone);
  }
}
