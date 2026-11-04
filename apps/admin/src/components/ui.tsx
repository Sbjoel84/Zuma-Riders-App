import { clsx } from "clsx";
import { Loader2, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { errorText } from "../lib/api";

// ---------------- buttons ----------------

type Kind = "primary" | "secondary" | "danger" | "ghost" | "amber";
export function Button({ kind = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind; size?: "sm" | "md"; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer whitespace-nowrap",
        size === "sm" ? "h-[34px] px-3 text-xs" : "h-10 px-4 text-sm",
        kind === "primary" && "bg-ink text-white hover:bg-ink-2",
        kind === "amber" && "bg-amber text-ink hover:brightness-95",
        kind === "secondary" && "border border-line bg-white text-ink hover:border-ink",
        kind === "danger" && "border border-bad bg-white text-bad hover:bg-bad-soft",
        kind === "ghost" && "text-muted hover:text-ink",
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------------- surfaces ----------------

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={clsx("min-w-0 rounded-[14px] border border-[#e6e8e3] bg-white", className)}>
      {title || actions ? (
        <header className="flex flex-wrap items-center justify-between gap-2 px-[18px] pt-4 pb-2">
          {typeof title === "string" ? <h2 className="text-base font-bold">{title}</h2> : title}
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={clsx(pad && "px-[18px] pb-[18px]", !title && !actions && pad && "pt-[18px]")}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, note, tone = "muted" }: { label: string; value: ReactNode; note?: ReactNode; tone?: "muted" | "up" | "down" }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] border border-[#e6e8e3] bg-white p-4">
      <span className="text-[13px] font-medium text-muted">{label}</span>
      <span className="tabular font-display text-[28px] leading-tight font-bold">{value}</span>
      {note ? <span className={clsx("text-xs font-semibold", tone === "up" && "text-ok", tone === "down" && "text-bad", tone === "muted" && "text-muted")}>{note}</span> : null}
    </div>
  );
}

const TONES = {
  neutral: "bg-line-soft text-[#3d443c]",
  amber: "bg-amber-soft text-amber-text",
  green: "bg-ok-soft text-ok-text",
  red: "bg-bad-soft text-bad-text",
  blue: "bg-info-soft text-info",
  violet: "bg-violet-soft text-violet",
} as const;
export type Tone = keyof typeof TONES;
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={clsx("inline-block rounded-full px-2.5 py-[3px] text-xs font-semibold whitespace-nowrap", TONES[tone])}>{children}</span>;
}

export function Chips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx("h-9 cursor-pointer rounded-full border px-3.5 text-[13px] font-semibold", value === o.value ? "border-ink bg-ink text-white" : "border-[#d6d9d2] bg-white text-ink hover:border-ink")}
        >
          {o.label}
          {o.count !== undefined ? <span className="ml-1.5 opacity-70">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------------- form controls ----------------

const inputCls = "h-10 w-full rounded-[10px] border border-[#d6d9d2] bg-white px-3 text-sm text-ink placeholder:text-[#8a918a]";
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
      {error ? <span className="text-xs text-bad">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={clsx(inputCls, "pr-8", p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={clsx(inputCls, "h-auto py-2.5 resize-y", p.className)} />;

// ---------------- tables ----------------

export function Table({ head, children, minWidth = 720, empty }: { head: ReactNode[]; children: ReactNode; minWidth?: number; empty?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead>
          <tr className="bg-[#f8f9f6] text-left text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-3.5 py-2.5 font-semibold first:pl-[18px] last:pr-[18px]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty}
    </div>
  );
}
export function Td({ children, className, ...rest }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return <td {...rest} className={clsx("border-t border-line-soft px-3.5 py-2.5 align-middle first:pl-[18px] last:pr-[18px]", className)}>{children}</td>;
}

// ---------------- states ----------------

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted" role="status">
      <Loader2 className="size-5 animate-spin text-amber" aria-hidden /> {label}
    </div>
  );
}
export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {body ? <p className="max-w-md text-sm text-muted">{body}</p> : null}
    </div>
  );
}
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-bad-soft px-4 py-3 text-sm font-semibold text-bad-text">
      <span>{errorText(error)}</span>
      {retry ? <Button size="sm" onClick={retry}>Try again</Button> : null}
    </div>
  );
}

/** Loading / error / content in one place, so every page handles all three. */
export function Async<T>({ q, children, loading }: { q: { isLoading: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown }; children: (d: T) => ReactNode; loading?: string }) {
  if (q.isLoading) return <Spinner label={loading} />;
  if (q.isError || q.data === undefined) return <ErrorBox error={q.error} retry={() => q.refetch()} />;
  return <>{children(q.data)}</>;
}

// ---------------- dialog ----------------

export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} className="m-auto w-[min(520px,calc(100vw-32px))] rounded-[16px] border-0 p-0 shadow-2xl backdrop:bg-ink/50">
      <div className="flex items-center justify-between border-b border-line-soft px-5 py-4">
        <h2 className="font-display text-lg font-bold">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="cursor-pointer rounded-md p-1 text-muted hover:text-ink">
          <X className="size-5" />
        </button>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4 text-sm">{children}</div>
      {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line-soft px-5 py-3">{footer}</div> : null}
    </dialog>
  );
}

/**
 * Confirm an action, optionally asking for a reason (most admin writes require one).
 * Usage: const confirm = useConfirm(); confirm({ title, body, reason: true, confirmLabel, danger, run: (reason) => ... })
 */
interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  reason?: boolean | string;
  reasonLabel?: string;
  confirmLabel: string;
  danger?: boolean;
  run: (reason: string) => Promise<unknown>;
  success?: string;
}
const ConfirmCtx = createContext<(o: ConfirmOpts) => void>(() => undefined);
const ToastCtx = createContext<(msg: string, tone?: "ok" | "bad") => void>(() => undefined);
export const useConfirm = () => useContext(ConfirmCtx);
export const useToast = () => useContext(ToastCtx);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: "ok" | "bad" }[]>([]);

  const toast = useCallback((msg: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const open = useCallback((o: ConfirmOpts) => {
    setOpts(o);
    setReason(typeof o.reason === "string" ? o.reason : "");
    setErr(null);
  }, []);

  const go = async () => {
    if (!opts) return;
    if (opts.reason && reason.trim().length < 3) return setErr("Give a short reason (it's saved to the audit log).");
    setBusy(true);
    setErr(null);
    try {
      await opts.run(reason.trim());
      if (opts.success) toast(opts.success);
      setOpts(null);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={open}>
        {children}
        <Dialog
          open={!!opts}
          onClose={() => !busy && setOpts(null)}
          title={opts?.title ?? ""}
          footer={
            <>
              <Button onClick={() => setOpts(null)} disabled={busy}>Cancel</Button>
              <Button kind={opts?.danger ? "danger" : "primary"} loading={busy} onClick={go}>{opts?.confirmLabel}</Button>
            </>
          }
        >
          {opts?.body ? <div className="text-muted">{opts.body}</div> : null}
          {opts?.reason ? (
            <Field label={opts.reasonLabel ?? "Reason (saved to the audit log)"} error={err}>
              <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </Field>
          ) : err ? (
            <p className="text-sm text-bad">{err}</p>
          ) : null}
        </Dialog>
        <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(420px,calc(100vw-32px))] flex-col gap-2">
          {toasts.map((t) => (
            <div key={t.id} className={clsx("pointer-events-auto flex items-start gap-2.5 rounded-[12px] px-4 py-3 text-sm font-semibold shadow-lg", t.tone === "ok" ? "bg-ink text-white" : "bg-bad text-white")}>
              <span className={clsx("mt-1.5 size-2 flex-none rounded-full", t.tone === "ok" ? "bg-amber" : "bg-white")} />
              {t.msg}
            </div>
          ))}
        </div>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[30px] leading-tight font-bold">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
