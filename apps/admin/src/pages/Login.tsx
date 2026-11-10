import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "../components/ui";
import { errorText } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Login() {
  const { requestCode, verifyCode, verifyMfa } = useAuth();
  const [phone, setPhone] = useState("");
  const [otpId, setOtpId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setOtpId(await requestCode(phone));
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await verifyCode(otpId!, code);
      if (r) {
        setMfaToken(r.mfaToken);
        setBusy(false);
      }
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  };

  const verifySecond = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await verifyMfa(mfaToken!, mfaCode);
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  };

  const restart = () => {
    setOtpId(null);
    setMfaToken(null);
    setCode("");
    setMfaCode("");
    setErr(null);
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1fr_1.1fr]">
      <div className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <span className="font-display text-3xl font-bold">zuma <span className="ml-1 rounded-md bg-amber px-2 py-0.5 align-middle text-xs tracking-wider text-ink uppercase">Ops</span></span>
        <div>
          <p className="font-display text-4xl leading-tight font-bold">Operations console</p>
          <p className="mt-3 max-w-sm text-[#a9b0a8]">Rides, drivers, money and safety for Zuma in Abuja. Every action you take here is logged.</p>
        </div>
        <span className="text-xs text-[#a9b0a8]">Authorised Zuma staff only</span>
      </div>
      <div className="flex items-center justify-center p-6">
        {mfaToken ? (
          <form onSubmit={verifySecond} className="flex w-full max-w-sm flex-col gap-4">
            <h1 className="font-display text-3xl font-bold">{useRecovery ? "Use a recovery code" : "Authenticator code"}</h1>
            <p className="text-sm text-muted">
              {useRecovery ? "Enter one of the recovery codes you saved when you set up two-factor sign-in. Each code works once." : "Open your authenticator app and enter the 6-digit code for Zuma Admin."}
            </p>
            <Field label={useRecovery ? "Recovery code" : "6-digit code"} error={err}>
              {useRecovery ? (
                <Input id="mfa" autoComplete="off" placeholder="ABCD-EFGH" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} autoFocus />
              ) : (
                <Input id="mfa" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))} autoFocus />
              )}
            </Field>
            <Button kind="primary" type="submit" loading={busy} disabled={useRecovery ? mfaCode.length < 8 : mfaCode.length !== 6}>Verify and sign in</Button>
            <Button kind="ghost" type="button" onClick={() => { setUseRecovery(!useRecovery); setMfaCode(""); setErr(null); }}>
              {useRecovery ? "Use the authenticator app instead" : "Lost your phone? Use a recovery code"}
            </Button>
            <Button kind="ghost" type="button" onClick={restart}>Start again</Button>
          </form>
        ) : !otpId ? (
          <form onSubmit={send} className="flex w-full max-w-sm flex-col gap-4">
            <h1 className="font-display text-3xl font-bold">Sign in</h1>
            <p className="text-sm text-muted">Use the phone number your admin account was created with. We'll text you a 6-digit code.</p>
            <Field label="Phone number" error={err}>
              <Input id="phone" autoComplete="tel" inputMode="tel" placeholder="0803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus />
            </Field>
            <Button kind="primary" type="submit" loading={busy} disabled={phone.trim().length < 7}>Send code</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="flex w-full max-w-sm flex-col gap-4">
            <h1 className="font-display text-3xl font-bold">Enter the code</h1>
            <p className="text-sm text-muted">If {phone} has admin access, a code is on its way. It expires in 5 minutes.</p>
            <Field label="6-digit code" error={err}>
              <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
            </Field>
            <Button kind="primary" type="submit" loading={busy} disabled={code.length !== 6}>Sign in</Button>
            <Button kind="ghost" type="button" onClick={restart}>Use a different number</Button>
          </form>
        )}
      </div>
    </div>
  );
}
