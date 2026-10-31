import { DOMAIN_LABELS, DOMAINS } from '@agentos/shared';
import { useState, type FormEvent } from 'react';
import { useSession } from '../session.tsx';
import { DOMAIN_ICONS, Photo, Spinner } from '../ui.tsx';

const PILLARS: Record<(typeof DOMAINS)[number], string> = {
  production: '设备前兆、OEE、排产',
  supply: '供应商评分、补货审批',
  quality: '8D 闭环、AOI 漏检',
  logistics: 'AGV 调度、码垛工位',
  ehs: '安全行为、峰谷用电',
  hr: '制度问答、组织健康',
};

const ACCOUNTS = [
  ['chairman', '董事长'],
  ['production', '生产经理'],
  ['supply', '供应链经理'],
  ['quality', '品质经理'],
  ['logistics', '物流主管'],
  ['ehs', '安环经理'],
  ['hr', 'HR 经理'],
];

export function Login() {
  const { login } = useSession();
  const [username, setUsername] = useState('chairman');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-[1.1fr_1fr]">
      <Photo src="/photos/login.jpg" alt="工厂产线实景" className="hidden text-white lg:flex">
        <div className="relative flex flex-1 flex-col justify-between gap-10 bg-ink-900/80 p-12">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-brand-600">
              <span className="num text-2xl font-bold">D</span>
            </span>
            <div className="leading-tight">
              <div className="text-lg font-bold">达智汇 AgentOS</div>
              <div className="font-mono text-[10px] tracking-[0.12em] text-[#8c9ab0]">MANUFACTURING · OS</div>
            </div>
          </div>
          <div>
            <span className="font-mono text-[11px] tracking-[0.14em] text-sky-300">FROM SHOP FLOOR TO BOARDROOM</span>
            <h1 className="mt-3 text-[32px] leading-tight font-bold">
              一线发生的每一件事，
              <br />
              自动汇总到经理与董事长面前
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">
              按身份解锁岗位智能体与数据；事件沿「一线 → 经理信号 → 董事长态势」上卷，跨部门的关联一眼可见。
            </p>
            <div className="mt-8 grid max-w-xl grid-cols-2 gap-2.5 xl:grid-cols-3">
              {DOMAINS.map((d, i) => {
                const Icon = DOMAIN_ICONS[d];
                return (
                  <div key={d} className="rounded-[10px] border border-white/12 bg-ink-900/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="num text-lg leading-none font-bold text-sky-300">{String(i + 1).padStart(2, '0')}</span>
                      <Icon className="size-4 text-slate-300" />
                    </div>
                    <div className="mt-2 text-sm font-semibold">{DOMAIN_LABELS[d]}</div>
                    <div className="text-xs text-slate-400">{PILLARS[d]}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-slate-400">系统内业务数据均为仿真演示数据</p>
        </div>
      </Photo>

      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex size-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <span className="num text-xl font-bold">D</span>
            </span>
            <div className="text-lg font-bold">达智汇 AgentOS</div>
          </div>
          <h2 className="text-2xl font-bold text-slate-900">登录</h2>
          <p className="mt-1 text-sm text-slate-500">用岗位账号登录，解锁对应的智能体与数据</p>

          <label className="mt-6 block text-sm font-medium text-slate-700">
            账号
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ACCOUNTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setUsername(id)}
                className={`rounded-full px-2.5 py-1 text-xs ring-1 ${username === id ? 'bg-brand-50 font-semibold text-brand-700 ring-brand-300' : 'bg-white text-slate-600 ring-slate-200 hover:bg-slate-50'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="mt-4 block text-sm font-medium text-slate-700">
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button
            disabled={busy || !password}
            className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy && <Spinner />}
            登录
          </button>
        </form>
      </section>
    </div>
  );
}
