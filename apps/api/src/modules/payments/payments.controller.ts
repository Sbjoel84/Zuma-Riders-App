import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res } from "@nestjs/common";
import { kobo, Money } from "@zuma/contracts";
import type { Request, Response } from "express";
import { z } from "zod";
import { Auth, type AuthContext, IdempotencyKey, ZodPipe } from "../../common/http";
import { env } from "../../config/env";
import { PaymentsGateway } from "../../infra/payments.gateway";
import { Public, Scopes } from "../auth/auth.guard";
import { PaymentsService } from "./payments.service";

const TopupBody = z.object({ amount: kobo, returnUrl: z.string().max(300).optional() });

@Controller("v1/payments")
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly gateway: PaymentsGateway,
  ) {}

  @Get("banks")
  banks() {
    return this.gateway.banks();
  }

  /** Passengers top up their wallet; drivers pay what they owe in cash-trip commission. */
  @Scopes("PASSENGER", "DRIVER")
  @Post("topups")
  topup(@Auth() auth: AuthContext, @Body(new ZodPipe(TopupBody)) body: z.infer<typeof TopupBody>, @IdempotencyKey() key: string) {
    return this.payments.startTopup(auth.userId, auth.scope === "DRIVER" ? "DRIVER" : "PASSENGER", BigInt(body.amount), key, body.returnUrl);
  }

  @Scopes("PASSENGER", "DRIVER")
  @Get()
  history(@Auth() auth: AuthContext) {
    return this.payments.history(auth.userId);
  }

  @Scopes("PASSENGER")
  @Get("cards")
  cards(@Auth() auth: AuthContext) {
    return this.payments.cards(auth.userId);
  }

  @Scopes("PASSENGER")
  @Put("cards/:id/default")
  setDefault(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.payments.setDefaultCard(auth.userId, id);
  }

  @Scopes("PASSENGER")
  @Delete("cards/:id")
  remove(@Auth() auth: AuthContext, @Param("id") id: string) {
    return this.payments.removeCard(auth.userId, id);
  }

  @Scopes("PASSENGER", "DRIVER")
  @Get(":reference")
  get(@Auth() auth: AuthContext, @Param("reference") reference: string) {
    return this.payments.get(auth.userId, reference);
  }

  @Scopes("PASSENGER", "DRIVER")
  @Post(":reference/verify")
  @HttpCode(200)
  verify(@Auth() auth: AuthContext, @Param("reference") reference: string) {
    return this.payments.verifyForUser(auth.userId, reference);
  }

  // ---------- development checkout (PAYMENTS_PROVIDER=fake only) ----------

  @Public()
  @Get("fake-checkout/:reference")
  async fakeCheckout(@Param("reference") reference: string, @Res() res: Response) {
    if (env().PAYMENTS_PROVIDER !== "fake") return res.status(404).end();
    const t = await this.gateway.fakeCheckoutState(reference);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action *");
    if (!t) return res.status(404).send(page("Payment not found", "<p>This checkout link has expired.</p>"));
    if (t.status !== "pending") return res.send(page("Already completed", `<p>This payment is ${t.status}.</p>${t.callbackUrl ? `<a class="b" href="${esc(back(t.callbackUrl, reference))}">Return to Zuma</a>` : ""}`));
    return res.send(page(`Pay ${Money.format(t.amount)}`, `
      <p class="muted">Test checkout. No real card is charged. In production this page is Paystack's.</p>
      <form method="post"><input type="hidden" name="outcome" value="success"><button class="b">Pay with test card ••4081</button></form>
      <form method="post"><input type="hidden" name="outcome" value="success_decline_later"><button class="b alt">Save a card that declines on trips ••1881</button></form>
      <form method="post"><input type="hidden" name="outcome" value="failed"><button class="b ghost">Decline this payment</button></form>`));
  }

  @Public()
  @Post("fake-checkout/:reference")
  async fakeComplete(@Param("reference") reference: string, @Req() req: Request, @Res() res: Response) {
    if (env().PAYMENTS_PROVIDER !== "fake") return res.status(404).end();
    const outcome = z.enum(["success", "success_decline_later", "failed"]).catch("failed").parse((req.body as { outcome?: string })?.outcome);
    const t = await this.gateway.fakeComplete(reference, outcome);
    if (!t) return res.status(404).end();
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action *");
    if (t.callbackUrl) return res.redirect(303, back(t.callbackUrl, reference));
    return res.send(page("Done", `<p>Payment ${t.status}.</p>`));
  }
}

@Controller("v1/webhooks")
export class WebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  /** Paystack → us. Verified with the HMAC-SHA512 signature over the raw body. */
  @Public()
  @Post("paystack")
  async paystack(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    const raw = req.rawBody?.toString("utf8") ?? JSON.stringify(req.body ?? {});
    const r = await this.payments.handleWebhook(raw, req.headers["x-paystack-signature"] as string | undefined);
    res.status(r.status).json({ ok: r.ok, duplicate: r.duplicate ?? false });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const back = (url: string, reference: string) => `${url}${url.includes("?") ? "&" : "?"}reference=${encodeURIComponent(reference)}`;
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f1;margin:0;padding:24px;color:#12161b}main{max-width:420px;margin:40px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px #0002}
h1{font-size:22px;margin:0 0 8px}.muted{color:#5d645c;font-size:14px}form{margin:10px 0}.b{display:block;width:100%;text-align:center;text-decoration:none;box-sizing:border-box;padding:14px;border-radius:12px;border:0;background:#12161b;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.alt{background:#f2a900;color:#12161b}.ghost{background:#fff;color:#b42318;border:1px solid #e3e5df}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
