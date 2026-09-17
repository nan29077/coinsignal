import { useEffect, useState } from "react";
import TimeChart from "./Chart.tsx";
import { api, cls, dateTime, Empty, ErrorBox, krw, Modal, pct, Stat, tone, useAction, useApi } from "../lib.tsx";

type Detail = {
  label: string;
  snapshot: {
    account: any;
    cashKrw: number;
    lockedKrw: number;
    equityKrw: number;
    stale: boolean;
    error?: string;
    positions: { symbol: string; name: string; qty: number; costKrw: number; avgPrice: number; price: number | null; valueKrw: number | null; pnlKrw: number | null; pnlPct: number | null; stopLossPct: number; takeProfitPct: number; stale: boolean; openedAt: string }[];
  };
  orders: any[];
  equity: { ts: number; equity: number }[];
};

const KIND: Record<string, string> = { rebalance: "리밸런싱", stop_loss: "손절", take_profit: "익절", manual: "수동", liquidate: "전량 매도", exit: "AI 제외" };
const STATUS: Record<string, string> = { filled: "체결", failed: "실패", canceled: "미체결 취소", submitted: "확인 대기", submitting: "전송 중" };

export default function AccountDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<Detail>(`/accounts/${id}`, 20_000);
  const { busy, run } = useAction();
  const a = d.data?.snapshot.account;
  const [form, setForm] = useState<Record<string, number | string>>({});
  const [buy, setBuy] = useState({ symbol: "", krw: 100000 });
  const [resetKrw, setResetKrw] = useState(10_000_000);

  useEffect(() => {
    if (!a) return;
    setForm((f) =>
      Object.keys(f).length
        ? f
        : {
            execution: a.execution,
            feePct: a.fee_pct,
            slippagePct: a.slippage_pct,
            dailyLossLimitPct: a.daily_loss_limit_pct,
            defaultStopLossPct: a.default_stop_loss_pct,
            defaultTakeProfitPct: a.default_take_profit_pct,
            rebalanceBandPct: a.rebalance_band_pct,
          },
    );
  }, [a]);

  const s = d.data?.snapshot;
  const paper = a?.mode === "paper";
  const fields: [string, string, number, number, number][] = [
    ["dailyLossLimitPct", "일일 손실 한도 % (0=끔)", 0, 100, 0.5],
    ["defaultStopLossPct", "기본 손절 % (AI 미지정 시)", 0.5, 50, 0.5],
    ["defaultTakeProfitPct", "기본 익절 % (AI 미지정 시)", 0.5, 300, 0.5],
    ["rebalanceBandPct", "리밸런싱 허용 오차 %p", 0.5, 20, 0.5],
    ...(paper
      ? ([
          ["feePct", "모의 수수료 %", 0, 2, 0.01],
          ["slippagePct", "모의 슬리피지 %", 0, 5, 0.01],
        ] as [string, string, number, number, number][])
      : []),
  ];

  return (
    <Modal open onClose={onClose} title={d.data?.label ?? "계좌"}>
      <ErrorBox message={d.error || s?.error || ""} />
      {s && a && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="총 평가 자산" value={`${krw(s.equityKrw)}원`} sub={s.stale ? "일부 시세 지연" : "실시간"} />
            <Stat label="원화 (주문 가능)" value={`${krw(s.cashKrw)}원`} sub={s.lockedKrw ? `주문 중 ${krw(s.lockedKrw)}원` : undefined} />
            {paper ? (
              <Stat label="시작 대비" value={pct((s.equityKrw / a.initial_krw - 1) * 100)} tone={tone(s.equityKrw - a.initial_krw)} sub={`시작 ${krw(a.initial_krw)}원`} />
            ) : (
              <Stat
                label="오늘 시작 대비"
                value={a.day_start_equity ? pct((s.equityKrw / a.day_start_equity - 1) * 100) : "—"}
                tone={tone(a.day_start_equity ? s.equityKrw - a.day_start_equity : null)}
                sub="KST 0시 기준"
              />
            )}
            <Stat label="상태" value={a.halted ? "정지" : a.enabled ? "운용 중" : "꺼짐"} sub={a.halt_reason ?? (a.execution === "auto" ? "자동 실행" : "승인 후 실행")} tone={a.halted ? "down" : a.enabled ? "up" : ""} />
          </div>

          <section className="panel p-4">
            <h3 className="font-semibold mb-2">자산 흐름</h3>
            <TimeChart data={(d.data?.equity ?? []).map((x) => ({ time: x.ts, equity: x.equity }))} series={[{ key: "equity", label: "평가 자산", color: "#4ce4bd" }]} />
          </section>

          <section className="panel">
            <div className="p-4 flex flex-wrap justify-between gap-2 items-center">
              <h3 className="font-semibold">보유 종목</h3>
              <button
                className="btn danger sm"
                disabled={!s.positions.length || !!busy}
                onClick={() => {
                  if (!confirm(`${d.data!.label}의 보유 코인을 모두 시장가로 매도할까요?`)) return;
                  void run("liq", () => api(`/accounts/${id}/liquidate`, { body: {} }).then(d.reload), "전량 매도 주문을 실행했습니다.");
                }}
              >
                전량 매도
              </button>
            </div>
            {s.positions.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>코인</th>
                      <th className="text-right">수량</th>
                      <th className="text-right">평균가</th>
                      <th className="text-right">현재가</th>
                      <th className="text-right">평가금액</th>
                      <th className="text-right">손익</th>
                      <th>손절/익절</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {s.positions.map((p) => (
                      <tr key={p.symbol}>
                        <td>
                          <b>{p.symbol}</b> <span className="muted text-xs">{p.name}</span>
                        </td>
                        <td className="text-right num">{p.qty.toFixed(8).replace(/\.?0+$/, "")}</td>
                        <td className="text-right num">{krw(p.avgPrice)}</td>
                        <td className={cls("text-right num", p.stale && "warn")}>{krw(p.price)}</td>
                        <td className="text-right num">{krw(p.valueKrw)}</td>
                        <td className={cls("text-right num", p.stale ? "muted" : tone(p.pnlKrw))}>
                          {p.stale ? "시세 확인 필요" : `${krw(p.pnlKrw)} (${pct(p.pnlPct)})`}
                        </td>
                        <td className="num text-xs">
                          -{p.stopLossPct}% / +{p.takeProfitPct}%
                        </td>
                        <td className="text-right">
                          <button
                            className="btn sm"
                            disabled={!!busy}
                            onClick={() => confirm(`${p.symbol} 전량을 시장가로 매도할까요?`) && run(p.symbol, () => api(`/accounts/${id}/order`, { body: { side: "sell", symbol: p.symbol } }).then(d.reload), "매도했습니다.")}
                          >
                            매도
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>보유 중인 코인이 없습니다.</Empty>
            )}
            <div className="p-4 border-t flex flex-wrap items-end gap-2" style={{ borderColor: "var(--line)" }}>
              <label className="field">
                <span>수동 매수 심볼</span>
                <input className="input w-28" value={buy.symbol} placeholder="BTC" onChange={(e) => setBuy({ ...buy, symbol: e.target.value.toUpperCase() })} />
              </label>
              <label className="field">
                <span>금액(원, 수수료 포함)</span>
                <input className="input w-40" type="number" min={5000} value={buy.krw} onChange={(e) => setBuy({ ...buy, krw: Number(e.target.value) })} />
              </label>
              <button
                className="btn"
                disabled={!buy.symbol || buy.krw < 5000 || !!busy}
                onClick={() =>
                  (paper || confirm(`실거래 계좌에서 ${buy.symbol}을(를) ${krw(buy.krw)}원 시장가 매수합니다. 계속할까요?`)) &&
                  run("buy", () => api(`/accounts/${id}/order`, { body: { side: "buy", symbol: buy.symbol, krw: buy.krw } }).then(d.reload), "매수했습니다.")
                }
              >
                시장가 매수
              </button>
              <span className="muted text-xs">수동 주문도 AI 목표 비중에 포함되어 다음 리밸런싱 때 조정될 수 있습니다.</span>
            </div>
          </section>

          <section className="panel p-4">
            <h3 className="font-semibold mb-4">운용 설정</h3>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <label className="field">
                <span>매매 실행 방식</span>
                <select className="input" value={String(form.execution ?? "approval")} onChange={(e) => setForm({ ...form, execution: e.target.value })}>
                  <option value="approval">알림 후 승인 시 실행</option>
                  <option value="auto">자동 실행</option>
                </select>
              </label>
              {fields.map(([k, label, min, max, step]) => (
                <label className="field" key={k}>
                  <span>{label}</span>
                  <input className="input" type="number" min={min} max={max} step={step} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value === "" ? "" : Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <p className="muted text-xs mt-3">손절·익절과 일일 손실 한도는 승인 방식과 관계없이 매분 자동으로 감시·실행됩니다. 종목 수와 비중은 AI가 결정합니다.</p>
            <button
              className="btn primary mt-4"
              disabled={!!busy}
              onClick={() => {
                const body = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v]));
                if (body.execution === "auto" && a.mode === "live" && a.execution !== "auto" && !confirm("실거래 계좌를 자동 실행으로 바꾸면 승인 없이 실제 주문이 나갑니다. 계속할까요?")) return;
                void run("save", () => api(`/accounts/${id}`, { method: "PATCH", body }).then(d.reload), "저장했습니다.");
              }}
            >
              설정 저장
            </button>
            {paper && (
              <div className="mt-6 pt-4 border-t flex flex-wrap items-end gap-2" style={{ borderColor: "var(--line)" }}>
                <label className="field">
                  <span>모의 계좌 초기화 · 시작 자금(원)</span>
                  <input className="input w-44" type="number" value={resetKrw} onChange={(e) => setResetKrw(Number(e.target.value))} />
                </label>
                <button className="btn danger" disabled={!!busy} onClick={() => confirm("보유 종목과 자산 기록을 지우고 초기화할까요? (거래 기록은 유지)") && run("reset", () => api(`/accounts/${id}/reset`, { body: { initialKrw: resetKrw } }).then(d.reload), "초기화했습니다.")}>
                  초기화
                </button>
              </div>
            )}
          </section>

          <section className="panel">
            <h3 className="font-semibold p-4">주문 기록</h3>
            {d.data!.orders.length ? (
              <div className="table-wrap max-h-[420px] overflow-y-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>시각</th>
                      <th>코인</th>
                      <th>구분</th>
                      <th>유형</th>
                      <th>상태</th>
                      <th className="text-right">체결금액</th>
                      <th className="text-right">수수료</th>
                      <th className="text-right">실현손익</th>
                      <th>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.data!.orders.map((o) => (
                      <tr key={o.id}>
                        <td className="whitespace-nowrap muted">{dateTime(o.created_at)}</td>
                        <td>{o.symbol}</td>
                        <td className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "매수" : "매도"}</td>
                        <td>{KIND[o.kind] ?? o.kind}</td>
                        <td className={cls(o.status === "failed" && "down", o.status === "submitted" && "warn")}>{STATUS[o.status] ?? o.status}</td>
                        <td className="text-right num">{krw(o.executed_krw)}</td>
                        <td className="text-right num">{krw(o.fee_krw)}</td>
                        <td className={cls("text-right num", tone(o.pnl_krw))}>{o.pnl_krw === null ? "—" : krw(o.pnl_krw)}</td>
                        <td className="text-xs muted max-w-72">{o.error ? <span className="down">{o.error}</span> : o.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>주문 기록이 없습니다.</Empty>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
