import { KeyRound, ShieldAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, cls, dateTime, ErrorBox, EXCHANGE_NAMES, Switch, useAction, useApi, usd } from "../lib.tsx";

type SettingsData = {
  ai: any;
  telegram: { enabled: boolean; chatId: string; notifyTrades: boolean; notifyResearch: boolean };
  global: { killSwitch: boolean };
  secrets: Record<string, { hint: string; updatedAt: string } | null>;
  models: { id: string; label: string; tier: string; input: number; output: number }[];
  budget: any;
};

function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel p-5">
      <h2 className="font-semibold text-lg">{title}</h2>
      {desc && <p className="muted text-sm mt-1 mb-4 leading-6">{desc}</p>}
      {!desc && <div className="mb-4" />}
      {children}
    </section>
  );
}

function SecretField({ name, label, hint, onSaved }: { name: string; label: string; hint: { hint: string; updatedAt: string } | null; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const { busy, run } = useAction();
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="field flex-1 min-w-60">
        <span>
          {label} {hint ? <span className="up">· 저장됨 {hint.hint} ({dateTime(hint.updatedAt)})</span> : <span className="warn">· 미등록</span>}
        </span>
        <input className="input" type="password" autoComplete="off" value={value} placeholder={hint ? "변경하려면 새 값 입력" : "값 입력"} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button className="btn" disabled={!value || !!busy} onClick={() => run(name, () => api(`/secrets/${name}`, { method: "PUT", body: { value } }).then(() => { setValue(""); onSaved(); }), "암호화해 저장했습니다.")}>
        <KeyRound size={14} /> 저장
      </button>
      {hint && (
        <button className="btn danger" disabled={!!busy} onClick={() => confirm(`${label}을(를) 삭제할까요?`) && run(name, () => api(`/secrets/${name}`, { method: "DELETE" }).then(onSaved), "삭제했습니다.")}>
          삭제
        </button>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const s = useApi<SettingsData>("/settings");
  const [ai, setAi] = useState<any>(null);
  const [tg, setTg] = useState<SettingsData["telegram"] | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const { busy, run } = useAction();
  const [test, setTest] = useState<Record<string, string>>({});

  useEffect(() => {
    if (s.data) {
      setAi((v: any) => v ?? s.data!.ai);
      setTg((v) => v ?? s.data!.telegram);
    }
  }, [s.data]);

  if (!s.data || !ai || !tg) return <div className="muted">{s.error || "불러오는 중…"}</div>;
  const d = s.data;
  const inCatalog = d.models.some((m) => m.id === ai.model);
  const model = d.models.find((m) => m.id === ai.model);
  const periodKo = { day: "일", week: "주", month: "월" }[ai.budgetPeriod as string];
  const runsPerPeriod = ({ day: 24, week: 168, month: 720 }[ai.budgetPeriod as string] ?? 720) / ai.intervalHours;

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <div className="eyebrow mb-1">SETTINGS</div>
        <h1 className="text-2xl font-semibold">설정</h1>
        <p className="muted text-sm mt-1">모든 API 키는 서버에서 AES-256-GCM으로 암호화되어 저장되며, 화면에는 끝 4자리만 표시됩니다.</p>
      </div>
      <ErrorBox message={s.error} />

      <Section title="긴급 중단" desc="켜면 모든 계좌의 자동 매매, 예약 리서치, 계획 실행, 손절 자동 매도가 즉시 멈춥니다. 보유 코인은 매도하지 않습니다.">
        <div className="flex items-center gap-3">
          <Switch label="긴급 중단" on={d.global.killSwitch} onChange={(v) => run("kill", () => api("/settings/kill-switch", { method: "PUT", body: { on: v } }).then(s.reload), v ? "긴급 중단을 켰습니다." : "해제했습니다.")} />
          <span className={cls("font-semibold", d.global.killSwitch ? "down" : "muted")}>
            <ShieldAlert size={16} className="inline mr-1" />
            {d.global.killSwitch ? "중단됨" : "정상 운용"}
          </span>
        </div>
      </Section>

      <Section title="OpenAI" desc="AI가 웹 검색으로 뉴스·공지를 조사해 투자할 코인과 비중을 정합니다. 키는 저장 전에 OpenAI에 조회해 유효성을 확인합니다.">
        <SecretField name="openai_api_key" label="OpenAI API 키" hint={d.secrets.openai_api_key} onSaved={s.reload} />
        <div className="flex items-center gap-2 mt-3">
          <button
            className="btn sm"
            disabled={!d.secrets.openai_api_key || !!busy}
            onClick={() =>
              run("test-openai", async () => {
                const r = await api("/settings/test/openai", { body: {} });
                setTest((t) => ({ ...t, openai: `연결 성공 · 사용 가능 모델 ${r.count}개 · ${r.available.map((m: any) => `${m.id} ${m.available ? "✓" : "✗"}`).join(", ")}` }));
              })
            }
          >
            연결 테스트
          </button>
          <span className="text-xs muted">{test.openai}</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 mt-6">
          <label className="field">
            <span>모델</span>
            <select className="input" value={inCatalog ? ai.model : "__custom"} onChange={(e) => setAi({ ...ai, model: e.target.value === "__custom" ? "" : e.target.value })}>
              {d.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.tier} (${m.input}/${m.output} per 1M)
                </option>
              ))}
              <option value="__custom">직접 입력</option>
            </select>
          </label>
          {!inCatalog && (
            <label className="field">
              <span>모델 ID 직접 입력</span>
              <input className="input" value={ai.model} placeholder="예: gpt-6-astra-2026-09-03" onChange={(e) => setAi({ ...ai, model: e.target.value.trim() })} />
            </label>
          )}
          {!inCatalog && (
            <>
              <label className="field">
                <span>입력 가격 ($/1M 토큰, 비용 계산용)</span>
                <input className="input" type="number" step="0.01" value={ai.customInputPrice} onChange={(e) => setAi({ ...ai, customInputPrice: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>출력 가격 ($/1M 토큰)</span>
                <input className="input" type="number" step="0.01" value={ai.customOutputPrice} onChange={(e) => setAi({ ...ai, customOutputPrice: Number(e.target.value) })} />
              </label>
            </>
          )}
          <label className="field">
            <span>추론 강도</span>
            <select className="input" value={ai.reasoningEffort} onChange={(e) => setAi({ ...ai, reasoningEffort: e.target.value })}>
              <option value="low">낮음 (빠르고 저렴)</option>
              <option value="medium">보통</option>
              <option value="high">높음</option>
              <option value="xhigh">매우 높음 (느리고 비쌈)</option>
            </select>
          </label>
          <label className="field">
            <span>AI에 보낼 후보 코인 수</span>
            <input className="input" type="number" min={5} max={40} value={ai.candidateCount} onChange={(e) => setAi({ ...ai, candidateCount: Number(e.target.value) })} />
          </label>
        </div>

        <h3 className="font-semibold mt-7 mb-3">리서치 주기와 예산</h3>
        <div className="grid sm:grid-cols-3 gap-4">
          <label className="field">
            <span>실행 주기 (시간)</span>
            <input className="input" type="number" min={0.5} max={168} step={0.5} list="interval-presets" value={ai.intervalHours} onChange={(e) => setAi({ ...ai, intervalHours: Number(e.target.value) })} />
            <datalist id="interval-presets">
              {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span>예산 금액 (USD)</span>
            <input className="input" type="number" min={0} step={1} value={ai.budgetUsd} onChange={(e) => setAi({ ...ai, budgetUsd: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>예산 기간</span>
            <select className="input" value={ai.budgetPeriod} onChange={(e) => setAi({ ...ai, budgetPeriod: e.target.value })}>
              <option value="day">하루 (KST)</option>
              <option value="week">1주 (월요일 시작)</option>
              <option value="month">1개월 (1일 시작)</option>
            </select>
          </label>
          <label className="field">
            <span>승인 대기 만료 (분)</span>
            <input className="input" type="number" min={5} max={1440} value={ai.approvalTimeoutMinutes} onChange={(e) => setAi({ ...ai, approvalTimeoutMinutes: Number(e.target.value) })} />
          </label>
          <div className="field sm:col-span-2">
            <span className="block mb-2 muted text-[13px]">리서치 대상 거래소 (계좌가 활성화된 거래소만 실행)</span>
            <div className="flex gap-4 flex-wrap">
              {Object.entries(EXCHANGE_NAMES).map(([id, name]) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ai.exchanges.includes(id)}
                    onChange={(e) => setAi({ ...ai, exchanges: e.target.checked ? [...ai.exchanges, id] : ai.exchanges.filter((x: string) => x !== id) })}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="p-3 rounded-lg mt-4 text-sm leading-6" style={{ background: "var(--panel-2)" }}>
          {model ? `${model.label}` : ai.model} 기준, {ai.intervalHours}시간마다 거래소 {ai.exchanges.length}곳 → {periodKo}당 약 {Math.round(runsPerPeriod * ai.exchanges.length)}회 실행.
          <br />
          최근 1회 예상 비용 {usd(d.budget.estimatePerRunUsd)} (저장된 모델 기준) · 이번 {periodKo} 사용 {usd(d.budget.spentUsd)} / 예산 {usd(ai.budgetUsd)}. 예산을 넘기면 리서치를 자동으로 건너뛰고 알림을 보냅니다.
          {d.budget.estimatePerRunUsd * runsPerPeriod * ai.exchanges.length > ai.budgetUsd && (
            <div className="warn mt-1">
              ⚠ 이 주기로는 {periodKo}당 약 {usd(d.budget.estimatePerRunUsd * runsPerPeriod * ai.exchanges.length)}이 필요해 예산보다 많습니다. 예산이 소진되면 그 기간의 나머지 리서치는 실행되지 않습니다.
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <Switch label="예약 리서치" on={ai.scheduleEnabled} onChange={(v) => setAi({ ...ai, scheduleEnabled: v })} />
          <span className="text-sm">예약 리서치 {ai.scheduleEnabled ? "켜짐" : "꺼짐"}</span>
        </div>
        <button className="btn primary mt-5" disabled={!!busy || !ai.model || !ai.exchanges.length} onClick={() => run("ai", () => api("/settings/ai", { method: "PUT", body: ai }).then(s.reload), "AI 설정을 저장했습니다.")}>
          AI 설정 저장
        </button>
      </Section>

      <Section
        title="거래소 API 키 (실거래)"
        desc={
          <>
            주문·잔고 조회 권한만 주고 <b>출금 권한은 절대 주지 마세요.</b> 업비트·코인원은 API 키에 <b>접속 IP 등록이 필수</b>이므로 이 프로그램이 실행되는 PC(또는 AWS 서버)의 고정 공인 IP를 등록해야 합니다.
          </>
        }
      >
        <div className="space-y-6">
          {(
            [
              ["upbit", "upbit_access_key", "Access Key", "upbit_secret_key", "Secret Key"],
              ["bithumb", "bithumb_access_key", "API Key", "bithumb_secret_key", "Secret Key"],
              ["coinone", "coinone_access_token", "Access Token", "coinone_secret_key", "Secret Key"],
            ] as const
          ).map(([ex, k1, l1, k2, l2]) => (
            <div key={ex} className="space-y-3">
              <div className="font-semibold">{EXCHANGE_NAMES[ex]}</div>
              <SecretField name={k1} label={l1} hint={d.secrets[k1]} onSaved={s.reload} />
              <SecretField name={k2} label={l2} hint={d.secrets[k2]} onSaved={s.reload} />
              <div className="flex items-center gap-2">
                <button
                  className="btn sm"
                  disabled={!d.secrets[k1] || !d.secrets[k2] || !!busy}
                  onClick={() =>
                    run(`test-${ex}`, async () => {
                      const r = await api("/settings/test/exchange", { body: { exchange: ex } });
                      setTest((t) => ({ ...t, [ex]: `연결 성공 · 원화 ${Math.floor(r.krw).toLocaleString()}원 · 보유 자산 ${r.assets}종` }));
                    })
                  }
                >
                  잔고 조회 테스트
                </button>
                <span className="text-xs muted">{test[ex]}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="텔레그램 알림·승인"
        desc={
          <>
            1) 텔레그램 @BotFather 에서 봇을 만들고 토큰을 저장 → 2) 만든 봇에게 아무 메시지나 보냄 → 3) “채팅 ID 찾기” → 4) 사용 켜고 저장. 승인 방식 계좌의 계획은 텔레그램 버튼으로도 승인할 수
            있습니다.
          </>
        }
      >
        <SecretField name="telegram_bot_token" label="봇 토큰" hint={d.secrets.telegram_bot_token} onSaved={s.reload} />
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <label className="field">
            <span>채팅 ID</span>
            <div className="flex gap-2">
              <input className="input" value={tg.chatId} onChange={(e) => setTg({ ...tg, chatId: e.target.value.trim() })} />
              <button
                className="btn"
                disabled={!d.secrets.telegram_bot_token || !!busy}
                onClick={() =>
                  run("detect", async () => {
                    const r = await api("/settings/telegram/detect", { body: {} });
                    if (!r.chats.length) throw new Error("찾은 채팅이 없습니다. 봇에게 메시지를 먼저 보내 주세요.");
                    setTg({ ...tg, chatId: r.chats[r.chats.length - 1].chatId });
                  })
                }
              >
                채팅 ID 찾기
              </button>
            </div>
          </label>
        </div>
        <div className="flex flex-wrap gap-6 mt-4 text-sm">
          {(
            [
              ["enabled", "사용"],
              ["notifyTrades", "체결·손절 알림"],
              ["notifyResearch", "리서치 결과 알림"],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2">
              <Switch label={l} on={tg[k]} onChange={(v) => setTg({ ...tg, [k]: v })} /> {l}
            </label>
          ))}
        </div>
        <div className="flex gap-2 mt-5">
          <button className="btn primary" disabled={!!busy} onClick={() => run("tg", () => api("/settings/telegram", { method: "PUT", body: tg }).then(s.reload), "텔레그램 설정을 저장했습니다.")}>
            저장
          </button>
          <button className="btn" disabled={!!busy} onClick={() => run("tg-test", () => api("/settings/test/telegram", { body: {} }), "테스트 메시지를 보냈습니다.")}>
            테스트 메시지
          </button>
        </div>
      </Section>

      <Section title="관리자 비밀번호">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="field">
            <span>현재 비밀번호</span>
            <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </label>
          <label className="field">
            <span>새 비밀번호 (10자 이상)</span>
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
        </div>
        <button className="btn mt-4" disabled={!pw.current || pw.next.length < 10 || !!busy} onClick={() => run("pw", () => api("/auth/password", { body: pw }).then(() => location.reload()), "변경했습니다. 다시 로그인해 주세요.")}>
          비밀번호 변경
        </button>
      </Section>
    </div>
  );
}
