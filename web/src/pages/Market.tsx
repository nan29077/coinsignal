import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import TimeChart from "../components/Chart.tsx";
import { api, cls, dateTime, ErrorBox, EXCHANGE_NAMES, krw, Modal, pct, Stat, tone, useAction, useApi } from "../lib.tsx";

type Ticker = { symbol: string; name: string; price: number; changePct: number; volumeKrw: number; timestamp: number; warning: boolean };

export default function Market() {
  const [exchange, setExchange] = useState("upbit");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Ticker | null>(null);
  const t = useApi<{ tickers: Ticker[]; receivedAt: number }>(`/market/tickers?exchange=${exchange}`, 30_000);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (t.data?.tickers ?? []).filter((x) => !q || `${x.symbol} ${x.name}`.toLowerCase().includes(q)).slice(0, 150);
  }, [t.data, query]);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <div className="eyebrow mb-1">MARKET</div>
          <h1 className="text-2xl font-semibold">시장·백테스트</h1>
          <p className="muted text-sm mt-1">원화 마켓 거래대금 순. 종목을 누르면 기술 지표와 규칙 백테스트를 볼 수 있습니다.</p>
        </div>
        <div className="flex gap-2">
          <select className="input w-32" value={exchange} onChange={(e) => setExchange(e.target.value)} aria-label="거래소">
            {Object.entries(EXCHANGE_NAMES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-3 muted" />
            <input className="input pl-9 w-52" placeholder="이름 또는 심볼" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="검색" />
          </div>
        </div>
      </div>
      <ErrorBox message={t.error} />
      <section className="panel">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>코인</th>
                <th className="text-right">현재가</th>
                <th className="text-right">변동률*</th>
                <th className="text-right">24h 거래대금</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.symbol} className="cursor-pointer" onClick={() => setSelected(x)}>
                  <td>
                    <b>{x.symbol}</b> <span className="muted text-xs">{x.name}</span> {x.warning && <span className="pill red">유의</span>}
                  </td>
                  <td className="text-right num">{krw(x.price)}</td>
                  <td className={cls("text-right num", tone(x.changePct))}>{pct(x.changePct)}</td>
                  <td className="text-right num muted">{krw(x.volumeKrw / 1e8, 1)}억</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs muted p-3">
          * 업비트·빗썸 전일 대비, 코인원 24시간 전 대비 · 수신 {t.data ? dateTime(t.data.receivedAt) : "—"}
        </p>
      </section>
      {selected && <CoinModal exchange={exchange} ticker={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CoinModal({ exchange, ticker, onClose }: { exchange: string; ticker: Ticker; onClose: () => void }) {
  const a = useApi<any>(`/market/analysis?exchange=${exchange}&symbol=${ticker.symbol}`);
  const [bt, setBt] = useState<any>(null);
  const [params, setParams] = useState({ feePct: 0.05, slippagePct: 0.05, stopLossPct: 5, takeProfitPct: 10 });
  const { busy, run } = useAction();
  useEffect(() => setBt(null), [ticker.symbol]);
  return (
    <Modal open onClose={onClose} title={`${ticker.name} (${ticker.symbol}) · ${EXCHANGE_NAMES[exchange]}`}>
      <ErrorBox message={a.error} />
      {a.data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="규칙 신호 (확률 아님)" value={`${a.data.signal} · ${a.data.score}`} />
            <Stat label="RSI(14, 1h)" value={a.data.rsi.toFixed(1)} />
            <Stat label="24h / 7d" value={`${pct(a.data.change24h)}`} sub={a.data.change7d === null ? "7일 이력 부족" : `7일 ${pct(a.data.change7d)}`} tone={tone(a.data.change24h)} />
            <Stat label="시간 변동성" value={`${a.data.volatility.toFixed(2)}%`} sub={`거래량 ${a.data.volumeRatio.toFixed(2)}배`} />
          </div>
          <TimeChart data={a.data.candles.map((c: any) => ({ time: c.time, close: c.close }))} series={[{ key: "close", label: "종가", color: "#4ce4bd" }]} />
          <p className="text-sm muted">
            {a.data.reason} 마지막 완료 봉 마감: {dateTime(a.data.asOf)}
          </p>
          <section className="panel p-4">
            <h3 className="font-semibold mb-3">규칙 백테스트 (전액 투입 기준, 최근 약 8일)</h3>
            <div className="flex flex-wrap gap-3 items-end">
              {(
                [
                  ["feePct", "수수료 %"],
                  ["slippagePct", "슬리피지 %"],
                  ["stopLossPct", "손절 %"],
                  ["takeProfitPct", "익절 %"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="field">
                  <span>{l}</span>
                  <input className="input w-24" type="number" step="0.01" value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />
                </label>
              ))}
              <button className="btn primary" disabled={!!busy} onClick={() => run("bt", async () => setBt(await api("/market/backtest", { body: { exchange, symbol: ticker.symbol, ...params } })))}>
                {busy ? "계산 중" : "실행"}
              </button>
            </div>
            {bt && (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <Stat label="전략 수익률" value={pct(bt.returnPct)} tone={tone(bt.returnPct)} />
                  <Stat label="단순 보유 수익률" value={pct(bt.benchmarkPct)} tone={tone(bt.benchmarkPct)} />
                  <Stat label="최대 낙폭" value={`${bt.drawdownPct.toFixed(2)}%`} />
                  <Stat label="체결 횟수" value={`${bt.trades}회`} sub={bt.winRatePct === null ? "" : `승률 ${bt.winRatePct.toFixed(0)}%`} />
                </div>
                <TimeChart
                  data={bt.curve}
                  series={[
                    { key: "value", label: "전략", color: "#4ce4bd" },
                    { key: "benchmark", label: "단순 보유", color: "#8da0b7", dashed: true },
                  ]}
                />
                <p className="text-xs muted">
                  {dateTime(bt.start)} ~ {dateTime(bt.end)} · 다음 봉 종가 체결 가정 · {bt.openPosition ? "종료 시 보유 중(청산 비용 미반영)" : "종료 시 현금"}. 과거 성과는 미래 수익을 보장하지 않습니다.
                </p>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
