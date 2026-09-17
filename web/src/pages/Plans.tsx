import { api, cls, dateTime, Empty, ErrorBox, krw, useAction, useApi } from "../lib.tsx";

const STATUS: Record<string, [string, string]> = {
  pending: ["승인 대기", "amber"],
  executing: ["실행 중", "gray"],
  executed: ["실행 완료", ""],
  rejected: ["거절", "gray"],
  expired: ["만료", "gray"],
  failed: ["실패", "red"],
  noop: ["변경 없음", "gray"],
};

export default function Plans() {
  const plans = useApi<any[]>("/plans", 10_000);
  const { busy, run } = useAction();
  return (
    <div>
      <div className="mb-6">
        <div className="eyebrow mb-1">PLANS</div>
        <h1 className="text-2xl font-semibold">매매 계획·승인</h1>
        <p className="muted text-sm mt-1">AI 리서치 결과로 만든 계좌별 리밸런싱 계획입니다. 승인 시점의 최신 시세로 주문 금액을 다시 계산해 실행합니다.</p>
      </div>
      <ErrorBox message={plans.error} />
      <div className="space-y-3">
        {(plans.data ?? []).map((p) => {
          const [label, tone] = STATUS[p.status] ?? [p.status, "gray"];
          return (
            <section key={p.id} className="panel p-4">
              <div className="flex flex-wrap justify-between gap-3">
                <div>
                  <div className="font-semibold flex items-center gap-2">
                    {p.label} <span className={cls("pill", tone)}>{label}</span>
                  </div>
                  <div className="muted text-xs mt-1">
                    생성 {dateTime(p.created_at)}
                    {p.status === "pending" && ` · 만료 ${dateTime(p.expires_at)}`}
                    {p.decided_via && ` · ${p.decided_via === "telegram" ? "텔레그램" : p.decided_via === "web" ? "웹" : p.decided_via}에서 처리`}
                    {p.preview?.equity && ` · 계획 당시 총자산 ${krw(p.preview.equity)}원`}
                  </div>
                </div>
                {p.status === "pending" && (
                  <div className="flex gap-2">
                    <button className="btn primary sm" disabled={!!busy} onClick={() => run(p.id, () => api(`/plans/${p.id}/approve`, { body: {} }).then(() => setTimeout(plans.reload, 1500)), "승인했습니다.")}>
                      승인
                    </button>
                    <button className="btn sm" disabled={!!busy} onClick={() => run(p.id, () => api(`/plans/${p.id}/reject`, { body: {} }).then(plans.reload), "거절했습니다.")}>
                      거절
                    </button>
                  </div>
                )}
              </div>
              <div className="grid lg:grid-cols-2 gap-4 mt-3">
                <div>
                  <div className="text-xs muted mb-1">목표 비중</div>
                  <div className="text-sm">
                    {p.targets.picks.map((t: any) => `${t.symbol} ${(t.weight * 100).toFixed(1)}%`).join(" · ") || "코인 없음"} · 현금 {(p.targets.cashWeight * 100).toFixed(1)}%
                  </div>
                  {p.preview?.orders?.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {p.preview.orders.map((o: any, i: number) => (
                        <div key={i} className="text-sm">
                          <span className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "매수" : "매도"}</span> {o.symbol} {krw(o.krw)}원{" "}
                          <span className="muted text-xs">
                            ({(o.currentWeight * 100).toFixed(1)}% → {(o.targetWeight * 100).toFixed(1)}%, {o.reason})
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {p.result && (
                  <div>
                    <div className="text-xs muted mb-1">실행 결과</div>
                    {p.result.error && <div className="text-sm down">{p.result.error}</div>}
                    {(p.result.results ?? []).map((r: any, i: number) => (
                      <div key={i} className={cls("text-sm", r.status === "failed" && "down")}>
                        {r.side === "buy" ? "매수" : "매도"} {r.symbol} · {r.status} · {krw(r.krw)}원 {r.error && `· ${r.error}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          );
        })}
        {plans.data && !plans.data.length && <Empty>아직 매매 계획이 없습니다. AI 리서치가 완료되면 활성화된 계좌마다 계획이 만들어집니다.</Empty>}
      </div>
    </div>
  );
}
