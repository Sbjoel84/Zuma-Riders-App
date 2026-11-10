import { useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { Async, Badge, Button, Card, Field, Input, PageHeader, useToast } from "../components/ui";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";

interface SecurityState { totpEnabled: boolean; enabledAt: string | null; required: boolean; recoveryCodesLeft: number; name: string; phone: string }

/** Two-factor sign-in for the signed-in admin. Also the only page an admin sees until they enrol when 2FA is required. */
export function Security({ enrolOnly = false }: { enrolOnly?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { reload, signOut } = useAuth();
  const q = useQuery({ queryKey: ["security"], queryFn: () => api.get<SecurityState>("/v1/admin/me/security") });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (setup) QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => setSetup(await api.post("/v1/admin/me/2fa/setup")));
  const enable = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>("/v1/admin/me/2fa/enable", { code });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["security"] });
      toast("Two-factor sign-in is on.");
    });
  const regenerate = () =>
    run(async () => {
      const r = await api.post<{ recoveryCodes: string[] }>("/v1/admin/me/2fa/recovery-codes", { code });
      setCodes(r.recoveryCodes);
      setCode("");
      qc.invalidateQueries({ queryKey: ["security"] });
    });
  const disable = () =>
    run(async () => {
      await api.post("/v1/admin/me/2fa/disable", { code });
      setCode("");
      qc.invalidateQueries({ queryKey: ["security"] });
      toast("Two-factor sign-in is off.");
    });

  const download = () => {
    const blob = new Blob([`Zuma Admin recovery codes\nEach code works once.\n\n${codes!.join("\n")}\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "zuma-admin-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const body = (
    <Async q={q}>
      {(s) => (
        <div className="flex max-w-2xl flex-col gap-4">
          {codes ? (
            <Card title="Save your recovery codes">
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted">If you lose your phone, each of these codes signs you in once. Store them somewhere safe, away from your phone. You won't see them again.</p>
                <ol className="tabular grid grid-cols-2 gap-2 rounded-[10px] bg-[#f8f9f6] p-3 font-mono text-sm sm:grid-cols-5">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={download}>Download as a text file</Button>
                  <Button kind="primary" onClick={() => { setCodes(null); if (enrolOnly) void reload(); }}>{enrolOnly ? "I've saved them, continue" : "Done"}</Button>
                </div>
              </div>
            </Card>
          ) : null}

          <Card title="Two-factor sign-in" actions={s.totpEnabled ? <Badge tone="green">On</Badge> : <Badge tone={s.required ? "red" : "amber"}>{s.required ? "Required" : "Off"}</Badge>}>
            <div className="flex flex-col gap-3 text-sm">
              <p className="text-muted">After the SMS code, you'll also enter a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or Authy). This stops anyone with a copy of your SIM from signing in.</p>
              {s.totpEnabled ? (
                <>
                  <p>Turned on {s.enabledAt ? new Date(s.enabledAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : ""} · {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? "" : "s"} left</p>
                  <Field label="Code from your app (to confirm changes)" error={err}>
                    <Input inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="123456" />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={code.length !== 6} loading={busy} onClick={regenerate}>Get new recovery codes</Button>
                    {!s.required ? <Button kind="danger" disabled={code.length !== 6} loading={busy} onClick={disable}>Turn off</Button> : null}
                  </div>
                  {s.required ? <p className="text-xs text-muted">Two-factor sign-in is required for all Zuma admins. If you change phones, ask a super admin to reset it from Settings.</p> : null}
                </>
              ) : setup ? (
                <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
                  <div className="flex flex-col items-center gap-2">
                    {qr ? <img src={qr} alt="QR code to add Zuma Admin to your authenticator app" className="size-[220px] rounded-[10px] border border-line-soft" /> : <div className="size-[220px] rounded-[10px] bg-line-soft" />}
                  </div>
                  <div className="flex flex-col gap-3">
                    <ol className="list-decimal pl-5 text-sm leading-relaxed">
                      <li>Open your authenticator app and add an account.</li>
                      <li>Scan the QR code, or enter this key: <code className="rounded bg-[#f1f3ee] px-1.5 py-0.5 text-xs break-all">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></li>
                      <li>Enter the 6-digit code the app shows.</li>
                    </ol>
                    <Field label="6-digit code" error={err}>
                      <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
                    </Field>
                    <div className="flex gap-2">
                      <Button kind="primary" disabled={code.length !== 6} loading={busy} onClick={enable}>Turn on</Button>
                      <Button kind="ghost" onClick={() => { setSetup(null); setCode(""); setErr(null); }}>Cancel</Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {err ? <p className="text-bad">{err}</p> : null}
                  <div><Button kind="primary" loading={busy} onClick={start}>Set up authenticator app</Button></div>
                </>
              )}
            </div>
          </Card>
        </div>
      )}
    </Async>
  );

  if (!enrolOnly) {
    return (
      <>
        <PageHeader title="Your security" subtitle="Sign-in protection for your admin account" />
        {body}
      </>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-10">
      <div>
        <span className="font-display text-2xl font-bold">zuma <span className="ml-1 rounded-md bg-amber px-2 py-0.5 align-middle text-xs tracking-wider text-ink uppercase">Ops</span></span>
        <h1 className="mt-6 font-display text-3xl font-bold">Set up two-factor sign-in</h1>
        <p className="mt-1 text-sm text-muted">Zuma requires an authenticator app for all admin accounts. It takes about a minute.</p>
      </div>
      {body}
      <div><Button kind="ghost" onClick={signOut}>Sign out</Button></div>
    </div>
  );
}
