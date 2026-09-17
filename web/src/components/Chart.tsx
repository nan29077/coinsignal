import { Area, AreaChart, CartesianGrid, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { krw } from "../lib.tsx";

type Series = { key: string; label: string; color: string; dashed?: boolean };

/** Time-series chart; x axis shows date when the range spans more than one day. */
export default function TimeChart({ data, series, height = 240 }: { data: Record<string, number>[]; series: Series[]; height?: number }) {
  if (data.length < 2) return <div className="muted text-sm flex items-center justify-center" style={{ height }}>기록이 쌓이면 그래프가 표시됩니다.</div>;
  const span = data[data.length - 1].time - data[0].time;
  const tick = (v: number) =>
    new Date(v).toLocaleString("ko-KR", span > 36 * 3_600_000 ? { month: "numeric", day: "numeric", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  const [main, ...rest] = series;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`g-${main.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={main.color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={main.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#253247" strokeDasharray="4 5" />
          <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tick} stroke="#8295ad" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={50} />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v) => krw(v)} stroke="#8295ad" tick={{ fontSize: 11 }} width={78} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: "#142032", border: "1px solid #314159", borderRadius: 10, color: "#e7eef7", fontSize: 13 }}
            labelFormatter={(v) => new Date(Number(v)).toLocaleString("ko-KR")}
            formatter={(v, name) => [`${krw(Number(v))}원`, series.find((s) => s.key === name)?.label ?? String(name)]}
          />
          {rest.length > 0 && <Legend formatter={(v) => series.find((s) => s.key === v)?.label ?? v} wrapperStyle={{ fontSize: 12 }} />}
          <Area type="linear" dataKey={main.key} stroke={main.color} strokeWidth={2} fill={`url(#g-${main.key})`} isAnimationActive={false} />
          {rest.map((s) => (
            <Line key={s.key} type="linear" dataKey={s.key} stroke={s.color} strokeDasharray={s.dashed ? "5 4" : undefined} dot={false} strokeWidth={1.6} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
