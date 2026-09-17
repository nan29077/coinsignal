import { Activity, Brain, ClipboardCheck, LayoutDashboard, LineChart, LogOut, Menu, ScrollText, Settings, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, cls, useAction } from "./lib.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Research from "./pages/Research.tsx";
import Plans from "./pages/Plans.tsx";
import Market from "./pages/Market.tsx";
import SettingsPage from "./pages/Settings.tsx";
import Logs from "./pages/Logs.tsx";

const NAV = [
  { id: "dashboard", label: "대시보드", icon: LayoutDashboard },
  { id: "plans", label: "매매 계획·승인", icon: ClipboardCheck },
  { id: "research", label: "AI 리서치", icon: Brain },
  { id: "market", label: "시장·백테스트", icon: LineChart },
  { id: "settings", label: "설정", icon: Settings },
  { id: "logs", label: "활동 로그", icon: ScrollText },
] as const;
type View = (typeof NAV)[number]["id"];

function useHashView(): [View, (v: View) => void] {
  const read = () => (NAV.some((n) => n.id === location.hash.slice(1)) ? (location.hash.slice(1) as View) : "dashboard");
  const [view, setView] = useState<View>(read);
  useEffect(() => {
    const h = () => setView(read());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return [view, (v) => (location.hash = v)];
}

function AuthScreen({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [token, setToken] = useState("");
  const { busy, run } = useAction();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run("auth", async () => {
      if (setup) {
        if (password !== confirm) throw new Error("비밀번호 확인이 일치하지 않습니다.");
        await api("/auth/setup", { body: { password, token } });
      } else await api("/auth/login", { body: { password } });
      onDone();
    });
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="panel p-7 w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <span className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--mint)", color: "#0a211e" }}>
            <Activity size={22} />
          </span>
          <div>
            <div className="font-bold text-lg">CoinSignal</div>
            <div className="muted text-xs">{setup ? "최초 관리자 설정" : "관리자 로그인"}</div>
          </div>
        </div>
        {setup && (
          <label className="field">
            <span>설정 토큰 (서버 콘솔에 표시됨)</span>
            <input className="input" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
          </label>
        )}
        <label className="field">
          <span>비밀번호{setup && " (10자 이상)"}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} required />
        </label>
        {setup && (
          <label className="field">
            <span>비밀번호 확인</span>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        <button className="btn primary w-full justify-center" disabled={!!busy}>
          {busy ? "확인 중…" : setup ? "관리자 만들기" : "로그인"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState<{ setupRequired: boolean; authenticated: boolean } | null>(null);
  const [view, setView] = useHashView();
  const [menu, setMenu] = useState(false);
  const [kill, setKill] = useState(false);
  const check = useCallback(() => api("/auth/status").then(setAuth).catch(() => setAuth({ setupRequired: false, authenticated: false })), []);
  useEffect(() => {
    void check();
    const h = () => setAuth((a) => (a ? { ...a, authenticated: false } : a));
    window.addEventListener("cs-unauthorized", h);
    return () => window.removeEventListener("cs-unauthorized", h);
  }, [check]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const load = () => api("/settings").then((s) => setKill(s.global.killSwitch)).catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [auth?.authenticated, view]);

  if (!auth) return <div className="p-10 muted">불러오는 중…</div>;
  if (!auth.authenticated) return <AuthScreen setup={auth.setupRequired} onDone={check} />;

  const Page = { dashboard: Dashboard, research: Research, plans: Plans, market: Market, settings: SettingsPage, logs: Logs }[view];
  return (
    <div className="min-h-screen md:flex">
      <aside className={cls("md:w-56 md:min-h-screen border-r md:block", menu ? "block" : "hidden")} style={{ borderColor: "var(--line)", background: "#0d1623" }}>
        <div className="px-5 py-6 flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--mint)", color: "#0a211e" }}>
            <Activity size={22} />
          </span>
          <div>
            <div className="font-bold">CoinSignal</div>
            <div className="text-[10px] tracking-[.2em] muted">AI INVESTMENT</div>
          </div>
        </div>
        <nav className="px-3 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => {
                setView(n.id);
                setMenu(false);
              }}
              className={cls("w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-left", view === n.id ? "bg-[#19342f] text-[#63eccb]" : "text-[#9cacbf] hover:bg-[#142032]")}
            >
              <n.icon size={17} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="px-3 mt-6 pb-6">
          <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-[#9cacbf] hover:bg-[#142032]" onClick={() => api("/auth/logout", { body: {} }).then(check)}>
            <LogOut size={17} />
            로그아웃
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--line)" }}>
          <span className="font-bold">CoinSignal</span>
          <button className="btn sm" onClick={() => setMenu(!menu)} aria-label="메뉴">
            <Menu size={16} />
          </button>
        </header>
        {kill && (
          <div className="px-5 py-2.5 text-sm flex items-center gap-2" style={{ background: "#3a1f28", color: "#ffc3cc" }}>
            <ShieldAlert size={16} /> 긴급 중단이 켜져 있습니다. 자동 매매·예약 리서치·계획 실행이 모두 멈춘 상태입니다. (설정에서 해제)
          </div>
        )}
        <div className="p-4 lg:p-8 max-w-[1500px] mx-auto">
          <Page />
        </div>
      </main>
    </div>
  );
}
