import { AlertTriangle, Brain, ClipboardCheck, Pause, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import AccountDetail from "../components/AccountDetail.tsx";
import { api, cls, dateTime, Empty, ErrorBox, krw, pct, Switch, tone, useAction, useApi, usd } from "../lib.tsx";

export type AccountRow = {
  account: {
    id: string;
    exchange: string;
    mode: "paper" | "live";
    enabled: number;
    execution: "auto" | "approval";
    halted: number;
    halt_reason: string | null;
    initial_krw: number;
    day_start_equity: number | null;
  };
  label: string;
  hasKeys: boolean;
  pendingPlans: number;
  snapshot: { cashKrw: number; lockedKrw: number; equityKrw: number; stale: boolean; positions: { symbol: string; valueKrw: number | null; pnlPct: number | null }[]; error?: string } | null;
  snapshotError?: string;
};

export default function Dashboard() {
  const accounts = useApi<{ killSwitch: boolean; accounts: AccountRow[] }>("/accounts", 30_000);
  const plans = useApi<any[]>("/plans", 30_000);
  const research = useApi<any>("/research", 30_000);
  const events = useApi<any[]>("/events?limit=12", 30_000);
  const [detail, setDetail] = useState<string | null>(null);
  const { busy, run } = useAction();

  const pending = (plans.data ?? []).filter((p) => p.status === "pending");
  const patch = (id: string, body: object, msg: string) =>
    run(id, async () => {
      await api(`/accounts/${id}`, { method: "PATCH", body });
      await accounts.reload();
    }, msg);

  const reloadAll = () => Promise.all([accounts.reload(), plans.reload(), research.reload(), events.reload()]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <div className="eyebrow mb-1">OVERVIEW</div>
          <h1 className="text-2xl font-semibold">운용 대시보드</h1>
          <p className="muted text-sm mt-1">거래소별 모의투자·실거래 계좌를 따로 운용합니다. 모의투자와 실거래는 서로 영향을 주지 않습니다.</p>
        </div>
        <button className="btn" onClick={reloadAll} disabled={accounts.loading}>
          <RefreshCw size={15} className={accounts.loading ? "animate-spin" : ""} /> 새로고침
        </button>
      </div>
      <ErrorBox message={accounts.error} />

      {pending.length > 0 && (
        <section className="panel p-4 mb-6" style={{ borderColor: "#5b4a24" }}>
          <div className="flex items-center gap-2 mb-3 warn font-semibold">
            <ClipboardCheck size={18} /> 승인 대기 중인 매매 계획 {pending.length}건
          </div>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg" style={{ background: "var(--panel-2)" }}>
                <div className="text-sm min-w-0">
                  <b>{p.label}</b> · {p.preview?.orders?.length ?? 0}건 ·{" "}
                  <span className="muted">
                    {p.preview?.orders?.map((o: any) => `${o.side === "buy" ? "매수" : "매도"} ${o.symbol} ${krw(o.krw)}원`).join(", ")}
                  </span>
                  <div className="muted text-xs mt-1">만료 {dateTime(p.expires_at)}</div>
                </div>
                <div className="flex gap-2">
                  <button className="btn primary sm" disabled={!!busy} onClick={() => run(p.id, () => api(`/plans/${p.id}/approve`, { body: {} }).then(() => setTimeout(reloadAll, 1500)), "승인했습니다. 주문을 실행합니다.")}>
                    승인
                  </button>
                  <button className="btn sm" disabled={!!busy} onClick={() => run(p.id, () => api(`/plans/${p.id}/reject`, { body: {} }).then(reloadAll), "거절했습니다.")}>
                    거절
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mb-8">
        {(accounts.data?.accounts ?? []).map((row) => {
          const a = row.account;
          const s = row.snapshot;
          const base = a.mode === "paper" ? a.initial_krw : a.day_start_equity;
          const change = s && base ? (s.equityKrw / base - 1) * 100 : null;
          const err = row.snapshotError ?? s?.error;
          return (
            <div key={a.id} className={cls("panel p-4 flex flex-col gap-3", a.mode === "live" && "border-[#2f4a63]")}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold flex items-center gap-2">
                    {row.label}
                    <span className={cls("pill", a.mode === "live" ? "amber" : "gray")}>{a.mode === "live" ? "LIVE" : "PAPER"}</span>
                  </div>
                  <div className="text-xs muted mt-1">
                    {a.execution === "auto" ? "자동 실행" : "승인 후 실행"}
                    {row.pendingPlans > 0 && <span className="warn"> · 승인 대기 {row.pendingPlans}</span>}
                  </div>
                </div>
                <Switch
                  label={`${row.label} 운용`}
                  on={!!a.enabled}
                  disabled={busy === a.id || (a.mode === "live" && !row.hasKeys)}
                  onChange={(v) => {
                    if (v && a.mode === "live" && !confirm(`${row.label}을(를) 활성화하면 AI 판단에 따라 실제 자금으로 주문이 실행됩니다. 계속할까요?`)) return;
                    void patch(a.id, { enabled: v }, v ? "운용을 시작합니다." : "운용을 중지했습니다.");
                  }}
                />
              </div>
              {a.mode === "live" && !row.hasKeys ? (
                <div className="text-sm muted">설정에서 거래소 API 키를 등록하면 사용할 수 있습니다.</div>
              ) : (
                <>
                  <div>
                    <div className="muted text-xs">총 평가 자산</div>
                    <div className="text-2xl font-semibold num">{s ? `${krw(s.equityKrw)}원` : "—"}</div>
                    <div className={cls("text-xs num", tone(change))}>
                      {change === null ? "" : `${pct(change)} ${a.mode === "paper" ? "(시작 자금 대비)" : "(오늘 시작 대비)"}`}
                      {s?.stale && <span className="warn"> · 일부 시세 지연</span>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div className="muted text-xs">원화</div>
                      <div className="num">{s ? krw(s.cashKrw + s.lockedKrw) : "—"}</div>
                    </div>
                    <div>
                      <div className="muted text-xs">보유 종목</div>
                      <div className="num truncate">{s ? (s.positions.length ? s.positions.map((p) => p.symbol).join(", ") : "없음") : "—"}</div>
                    </div>
                  </div>
                </>
              )}
              {err && <div className="text-xs down">{err}</div>}
              {a.halted ? (
                <div className="text-xs down flex items-center gap-1">
                  <AlertTriangle size={13} /> 정지됨: {a.halt_reason}
                </div>
              ) : null}
              <div className="flex gap-2 mt-auto pt-1">
                <button className="btn sm" onClick={() => setDetail(a.id)} disabled={a.mode === "live" && !row.hasKeys}>
                  상세·설정
                </button>
                <button
                  className="btn sm"
                  disabled={!a.enabled || !!busy}
                  onClick={() => run(a.id, () => api(`/accounts/${a.id}/halt`, { body: { halted: !a.halted } }).then(accounts.reload), a.halted ? "재개했습니다." : "정지했습니다.")}
                >
                  {a.halted ? <Play size={13} /> : <Pause size={13} />} {a.halted ? "재개" : "정지"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3">
            <Brain size={17} className="up" /> 최근 AI 리서치
          </h2>
          {research.data && (
            <div className="text-xs muted mb-3">
              예산 {usd(research.data.budget.spentUsd)} / {usd(research.data.budget.budgetUsd)} ({{ day: "일", week: "주", month: "월" }[research.data.budget.period as string]}) · 1회 예상 {usd(research.data.budget.estimatePerRunUsd)}
              {research.data.running.length > 0 && <span className="up"> · 진행 중: {research.data.running.join(", ")}</span>}
            </div>
          )}
          {(research.data?.runs ?? []).slice(0, 5).map((r: any) => (
            <div key={r.id} className="py-2 border-t text-sm" style={{ borderColor: "var(--line)" }}>
              <div className="flex justify-between gap-2">
                <span>
                  {r.exchange} · {r.model}
                </span>
                <span className={cls("pill", r.status === "completed" ? "" : r.status === "running" ? "gray" : "red")}>{r.status}</span>
              </div>
              <div className="muted text-xs mt-1">
                {dateTime(r.started_at)} · {usd(r.cost_usd)} ·{" "}
                {r.result ? r.result.picks.map((p: any) => `${p.symbol} ${(p.weight * 100).toFixed(0)}%`).join(", ") || "전액 현금" : r.error ?? ""}
              </div>
            </div>
          ))}
          {research.data && !research.data.runs.length && <Empty>아직 리서치 기록이 없습니다.</Empty>}
        </section>
        <section className="panel p-4">
          <h2 className="font-semibold mb-3">최근 활동</h2>
          {(events.data ?? []).map((e: any) => (
            <div key={e.id} className="py-1.5 text-sm flex gap-3">
              <span className="muted text-xs w-24 shrink-0 pt-0.5">{dateTime(e.ts)}</span>
              <span className={cls(e.level === "error" ? "down" : e.level === "warn" ? "warn" : e.level === "trade" ? "up" : "")}>{e.message}</span>
            </div>
          ))}
          {events.data && !events.data.length && <Empty>활동 기록이 없습니다.</Empty>}
        </section>
      </div>

      {detail && <AccountDetail id={detail} onClose={() => { setDetail(null); void reloadAll(); }} />}
    </div>
  );
}
