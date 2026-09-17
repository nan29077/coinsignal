import { useState } from "react";
import { cls, dateTime, Empty, ErrorBox, useApi } from "../lib.tsx";

export default function Logs() {
  const [level, setLevel] = useState("all");
  const ev = useApi<any[]>("/events?limit=500", 15_000);
  const rows = (ev.data ?? []).filter((e) => level === "all" || e.level === level);
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <div className="eyebrow mb-1">LOGS</div>
          <h1 className="text-2xl font-semibold">활동 로그</h1>
        </div>
        <select className="input w-36" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="구분">
          <option value="all">전체</option>
          <option value="trade">체결</option>
          <option value="warn">경고</option>
          <option value="error">오류</option>
          <option value="info">정보</option>
        </select>
      </div>
      <ErrorBox message={ev.error} />
      <section className="panel">
        {rows.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>구분</th>
                  <th>계좌</th>
                  <th>내용</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap muted">{dateTime(e.ts)}</td>
                    <td className={cls(e.level === "error" ? "down" : e.level === "warn" ? "warn" : e.level === "trade" ? "up" : "muted")}>{e.level}</td>
                    <td className="text-xs muted whitespace-nowrap">{e.account_id ?? "—"}</td>
                    <td className="text-sm">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>기록이 없습니다.</Empty>
        )}
      </section>
    </div>
  );
}
