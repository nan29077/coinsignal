import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth")) window.dispatchEvent(new Event("cs-unauthorized"));
    throw new ApiError(data.error || `요청 실패 (${res.status})`, res.status);
  }
  return data as T;
}

/** Load data, refresh on an interval, expose reload(). */
export function useApi<T>(path: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const current = useRef(path);
  current.current = path;
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (current.current === path) {
        setData(d);
        setError("");
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void reload();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, intervalMs);
    return () => clearInterval(t);
  }, [reload, intervalMs]);
  return { data, error, loading, reload, setData };
}

// ------------------------------------------------------------------ formatting
export const krw = (n: number | null | undefined, digits?: number) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const max = digits ?? (abs >= 100 ? 0 : abs >= 1 ? 2 : 6);
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: max }).format(n);
};
export const pct = (n: number | null | undefined, digits = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`);
export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`);
export const dateTime = (v: string | number | null | undefined) =>
  v ? new Date(v).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
export const EXCHANGE_NAMES: Record<string, string> = { upbit: "업비트", bithumb: "빗썸", coinone: "코인원" };
export const cls = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ------------------------------------------------------------------ toast
const ToastCtx = createContext<(msg: string, kind?: "ok" | "error") => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; kind: "ok" | "error"; id: number } | null>(null);
  const show = useCallback((msg: string, kind: "ok" | "error" = "ok") => setT({ msg, kind, id: Date.now() }), []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), t.kind === "error" ? 7000 : 3500);
    return () => clearTimeout(h);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div role="status" className={cls("toast text-sm", t.kind === "error" ? "down" : "up")} onClick={() => setT(null)}>
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: disables while running, toasts result/error. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
      setBusy(key);
      try {
        const r = await fn();
        if (okMsg) toast(okMsg);
        return r;
      } catch (e) {
        toast((e as Error).message, "error");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ------------------------------------------------------------------ small components
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cls("switch", on && "on")} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal panel p-5" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 mb-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn sm" onClick={onClose} aria-label="닫기">
            닫기
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-12 text-center muted text-sm">{children}</div>;
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "up" | "down" | "" }) {
  return (
    <div className="panel p-4 min-w-0">
      <div className="muted text-xs mb-2">{label}</div>
      <div className={cls("text-xl font-semibold num truncate", tone)}>{value}</div>
      {sub && <div className="muted text-xs mt-1 truncate">{sub}</div>}
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="panel p-3 mb-4 text-sm down">
      {message}
    </div>
  );
}

export const tone = (n: number | null | undefined) => (n === null || n === undefined ? "" : n >= 0 ? "up" : "down");
