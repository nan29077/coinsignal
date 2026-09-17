import { z } from "zod";
import { db, nowIso } from "../db.ts";
import { AppError } from "../errors.ts";
import { EXCHANGES, EXCHANGE_NAMES, type Exchange } from "../settings.ts";

export type Mode = "paper" | "live";
export type Account = {
  id: string;
  exchange: Exchange;
  mode: Mode;
  enabled: number;
  execution: "auto" | "approval";
  halted: number;
  halt_reason: string | null;
  initial_krw: number;
  cash_krw: number;
  fee_pct: number;
  slippage_pct: number;
  daily_loss_limit_pct: number;
  default_stop_loss_pct: number;
  default_take_profit_pct: number;
  rebalance_band_pct: number;
  day_start_date: string | null;
  day_start_equity: number | null;
  last_equity: number | null;
  last_equity_at: number | null;
  updated_at: string;
};
export type Position = {
  account_id: string;
  symbol: string;
  qty: number;
  cost_krw: number;
  opened_at: string;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  last_price: number | null;
  last_price_at: number | null;
};

export const accountId = (e: Exchange, m: Mode) => `${m}:${e}`;
export const accountLabel = (a: Pick<Account, "exchange" | "mode">) => `${EXCHANGE_NAMES[a.exchange]} ${a.mode === "live" ? "실거래" : "모의투자"}`;

export function ensureAccounts() {
  for (const e of EXCHANGES)
    for (const m of ["paper", "live"] as const) {
      db().run("INSERT OR IGNORE INTO accounts (id, exchange, mode, updated_at) VALUES (?, ?, ?, ?)", accountId(e, m), e, m, nowIso());
    }
}

export function listAccounts(): Account[] {
  return db().all<Account>("SELECT * FROM accounts ORDER BY CASE exchange WHEN 'upbit' THEN 0 WHEN 'bithumb' THEN 1 ELSE 2 END, mode DESC");
}

export function getAccount(id: string): Account {
  const a = db().get<Account>("SELECT * FROM accounts WHERE id = ?", id);
  if (!a) throw new AppError("계좌를 찾을 수 없습니다.", 404);
  return a;
}

export function getPositions(accountId: string): Position[] {
  return db().all<Position>("SELECT * FROM positions WHERE account_id = ? AND qty > 0 ORDER BY cost_krw DESC", accountId);
}

export const accountUpdateSchema = z
  .object({
    enabled: z.boolean(),
    execution: z.enum(["auto", "approval"]),
    feePct: z.number().min(0).max(2),
    slippagePct: z.number().min(0).max(5),
    dailyLossLimitPct: z.number().min(0).max(100),
    defaultStopLossPct: z.number().min(0.5).max(50),
    defaultTakeProfitPct: z.number().min(0.5).max(300),
    rebalanceBandPct: z.number().min(0.5).max(20),
  })
  .partial();

export function updateAccount(id: string, input: z.infer<typeof accountUpdateSchema>) {
  getAccount(id);
  const map: Record<string, string> = {
    enabled: "enabled",
    execution: "execution",
    feePct: "fee_pct",
    slippagePct: "slippage_pct",
    dailyLossLimitPct: "daily_loss_limit_pct",
    defaultStopLossPct: "default_stop_loss_pct",
    defaultTakeProfitPct: "default_take_profit_pct",
    rebalanceBandPct: "rebalance_band_pct",
  };
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (!entries.length) return getAccount(id);
  db().run(
    `UPDATE accounts SET ${entries.map(([k]) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ...entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : (v as string | number))),
    nowIso(),
    id,
  );
  return getAccount(id);
}

export function resetPaperAccount(id: string, initialKrw: number) {
  const a = getAccount(id);
  if (a.mode !== "paper") throw new AppError("모의투자 계좌만 초기화할 수 있습니다.");
  if (!(initialKrw >= 100_000 && initialKrw <= 10_000_000_000)) throw new AppError("시작 자금은 10만원 ~ 100억원 사이로 입력해 주세요.");
  db().tx(() => {
    db().run("DELETE FROM positions WHERE account_id = ?", id);
    db().run("DELETE FROM equity_snapshots WHERE account_id = ?", id);
    db().run("UPDATE plans SET status = 'expired' WHERE account_id = ? AND status = 'pending'", id);
    db().run(
      "UPDATE accounts SET initial_krw = ?, cash_krw = ?, halted = 0, halt_reason = NULL, day_start_date = NULL, day_start_equity = NULL, last_equity = NULL, updated_at = ? WHERE id = ?",
      initialKrw,
      initialKrw,
      nowIso(),
      id,
    );
  });
}

export function setHalt(id: string, halted: boolean, reason: string | null) {
  db().run("UPDATE accounts SET halted = ?, halt_reason = ?, updated_at = ? WHERE id = ?", Number(halted), halted ? reason : null, nowIso(), id);
}

// ---------- per-account async lock (orders for one account never run concurrently) ----------
const chains = new Map<string, Promise<unknown>>();
export function withAccountLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    id,
    run.catch(() => undefined),
  );
  return run;
}
