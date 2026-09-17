import { Brain, ExternalLink, Play } from "lucide-react";
import { useState } from "react";
import { api, cls, dateTime, Empty, ErrorBox, EXCHANGE_NAMES, krw, Modal, pct, Stat, useAction, useApi, usd } from "../lib.tsx";

const PERIOD: Record<string, string> = { day: "일", week: "주", month: "월" };

export default function Research() {
  const list = useApi<any>("/research", 15_000);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAction();
  const b = list.data?.budget;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <div className="eyebrow mb-1">AI RESEARCH</div>
          <h1 className="text-2xl font-semibold">AI 리서치</h1>
          <p className="muted text-sm mt-1">스크리닝 → OpenAI 웹 검색 조사 → 검증 → 계좌별 매매 계획 순서로 진행됩니다. 조사에는 수 분이 걸릴 수 있습니다.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["upbit", "bithumb", "coinone"] as const).map((e) => (
            <button
              key={e}
              className="btn"
              disabled={!!busy || list.data?.running.includes(e)}
              onClick={() => run(e, () => api("/research/run", { body: { exchange: e } }).then(list.reload), `${EXCHANGE_NAMES[e]} 리서치를 시작했습니다.`)}
            >
              <Play size={14} /> {EXCHANGE_NAMES[e]} {list.data?.running.includes(e) ? "진행 중…" : "지금 실행"}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox message={list.error} />
      {b && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <Stat label={`이번 ${PERIOD[b.period]} 사용액`} value={usd(b.spentUsd)} sub={`예산 ${usd(b.budgetUsd)}`} tone={b.spentUsd > b.budgetUsd * 0.9 ? "down" : ""} />
          <Stat label="남은 예산" value={usd(b.remainingUsd)} sub={`기간 시작 ${dateTime(b.since)}`} />
          <Stat label="1회 예상 비용" value={usd(b.estimatePerRunUsd)} sub="최근 실행 기준(여유 20%)" />
          <Stat label={`${PERIOD[b.period]} 예상 총비용`} value={usd(b.projectedPerPeriodUsd)} sub="현재 주기·거래소 수 기준" tone={b.projectedPerPeriodUsd > b.budgetUsd ? "down" : ""} />
        </div>
      )}
      <section className="panel">
        {list.data?.runs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>시작</th>
                  <th>거래소</th>
                  <th>모델</th>
                  <th>상태</th>
                  <th>결과</th>
                  <th className="text-right">토큰(입/출)</th>
                  <th className="text-right">검색</th>
                  <th className="text-right">비용</th>
                </tr>
              </thead>
              <tbody>
                {list.data.runs.map((r: any) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                    <td className="whitespace-nowrap">
                      {dateTime(r.started_at)}
                      <div className="muted text-xs">{r.trigger === "schedule" ? "예약" : "수동"}</div>
                    </td>
                    <td>{EXCHANGE_NAMES[r.exchange]}</td>
                    <td className="text-xs">{r.model}</td>
                    <td>
                      <span className={cls("pill", r.status === "completed" ? "" : r.status === "running" ? "gray" : "red")}>{{ completed: "완료", running: "진행 중", failed: "실패" }[r.status as string] ?? r.status}</span>
                    </td>
                    <td className="text-sm max-w-96">
                      {r.result ? (
                        <>
                          {r.result.picks.map((p: any) => `${p.symbol} ${(p.weight * 100).toFixed(0)}%`).join(", ") || "종목 없음"} · 현금 {(r.result.cashWeight * 100).toFixed(0)}%
                        </>
                      ) : (
                        <span className="down text-xs">{r.error}</span>
                      )}
                    </td>
                    <td className="text-right num text-xs">
                      {krw(r.input_tokens)} / {krw(r.output_tokens)}
                    </td>
                    <td className="text-right num">{r.web_searches}</td>
                    <td className="text-right num">{usd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            <Brain className="mx-auto mb-3 muted" />
            아직 리서치 기록이 없습니다. 설정에서 OpenAI 키를 등록한 뒤 실행해 보세요.
          </Empty>
        )}
      </section>
      {open && <ResearchDetail id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ResearchDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useApi<any>(`/research/${id}`);
  const r = d.data?.result;
  return (
    <Modal open onClose={onClose} title={d.data ? `${EXCHANGE_NAMES[d.data.exchange]} 리서치 · ${dateTime(d.data.started_at)}` : "리서치"}>
      <ErrorBox message={d.error || d.data?.error || ""} />
      {r && (
        <div className="space-y-5">
          <div className="panel p-4">
            <div className="flex gap-2 items-center mb-2">
              <span className={cls("pill", r.riskLevel === "high" ? "red" : r.riskLevel === "low" ? "" : "amber")}>위험 {({ low: "낮음", medium: "보통", high: "높음" } as any)[r.riskLevel]}</span>
              <span className="pill gray">현금 {(r.cashWeight * 100).toFixed(1)}%</span>
              <span className="muted text-xs">
                {d.data.model} · {usd(d.data.cost_usd)} · 검색 {d.data.web_searches}회
              </span>
            </div>
            <p className="text-sm leading-7 whitespace-pre-wrap">{r.summary}</p>
          </div>
          {r.picks.map((p: any) => (
            <div key={p.symbol} className="panel p-4">
              <div className="flex flex-wrap justify-between gap-2 mb-2">
                <div className="font-semibold text-lg">
                  {p.symbol} <span className="up num">{(p.weight * 100).toFixed(1)}%</span>
                </div>
                <div className="text-xs muted num">
                  확신도 {(p.confidence * 100).toFixed(0)}% · 기간 {p.horizonHours}시간 · 손절 -{p.stopLossPct}% · 익절 +{p.takeProfitPct}%
                </div>
              </div>
              <p className="text-sm leading-6">
                <b>근거</b> {p.thesis}
              </p>
              <p className="text-sm leading-6 mt-2 warn">
                <b>위험</b> {p.risks}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {p.sources.map((s: any, i: number) => (
                  <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="btn sm max-w-full">
                    <ExternalLink size={12} /> <span className="truncate max-w-72">{s.title || s.url}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
          {r.exits.length > 0 && (
            <div className="panel p-4">
              <h3 className="font-semibold mb-2">정리 권고</h3>
              {r.exits.map((x: any) => (
                <div key={x.symbol} className="text-sm py-1">
                  <b>{x.symbol}</b> <span className="muted">{x.reason}</span>
                </div>
              ))}
            </div>
          )}
          {r.dropped.length > 0 && (
            <div className="panel p-4">
              <h3 className="font-semibold mb-2">검증에서 제외된 AI 추천</h3>
              {r.dropped.map((x: any, i: number) => (
                <div key={i} className="text-sm py-1">
                  <b>{x.symbol}</b> <span className="down">{x.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {d.data?.candidates && (
        <details className="panel p-4 mt-5">
          <summary className="cursor-pointer font-semibold">스크리닝 결과 (후보 {d.data.candidates.candidates.length} / 전체 {d.data.candidates.universe})</summary>
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th>후보</th>
                  <th className="text-right">가격</th>
                  <th className="text-right">24h</th>
                  <th className="text-right">RSI</th>
                  <th className="text-right">점수</th>
                </tr>
              </thead>
              <tbody>
                {d.data.candidates.candidates.map((c: any) => (
                  <tr key={c.symbol}>
                    <td>
                      {c.symbol} <span className="muted text-xs">{c.name}</span> {c.held && <span className="pill gray">보유</span>}
                    </td>
                    <td className="text-right num">{krw(c.price)}</td>
                    <td className="text-right num">{pct(c.analysis.change24h)}</td>
                    <td className="text-right num">{c.analysis.rsi.toFixed(1)}</td>
                    <td className="text-right num">{c.analysis.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-xs muted mt-3 leading-6">
            제외: {d.data.candidates.excluded.map((x: any) => `${x.symbol}(${x.reason})`).join(", ") || "없음"}
          </div>
        </details>
      )}
    </Modal>
  );
}
