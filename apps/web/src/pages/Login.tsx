import { Boxes, ShieldCheck, Truck, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSession } from '../session.tsx';
import { Spinner } from '../ui.tsx';

const PILLARS = [
  { icon: Truck, title: '供应链', text: '寻源比价、库存补货' },
  { icon: ShieldCheck, title: '品质', text: '客诉受理、8D 改善' },
  { icon: Boxes, title: '智能物流', text: '料箱识别、抓取码垛' },
  { icon: Users, title: 'HR', text: '员工服务、组织健康' },
];

const ACCOUNTS = [
  ['chairman', '董事长'],
  ['supply', '供应链经理'],
  ['quality', '品质经理'],
  ['logistics', '物流主管'],
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
      <section className="relative hidden overflow-hidden bg-ink-900 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -top-32 -right-32 size-96 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 size-96 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10" />
          <div>
            <div className="text-lg font-semibold">达智汇 AgentOS</div>
            <div className="text-xs text-slate-400">制造业智能体操作系统</div>
          </div>
        </div>
        <div className="relative">
          <h1 className="text-3xl leading-tight font-semibold">
            一线发生的每一件事，
            <br />
            自动汇总到经理与董事长面前
          </h1>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300">
            按身份解锁岗位智能体与数据；事件沿「一线 → 经理信号 → 董事长态势」上卷，跨部门的关联一眼可见。
          </p>
          <div className="mt-8 grid max-w-lg grid-cols-2 gap-3">
            {PILLARS.map((p) => (
              <div key={p.title} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p.icon className="size-5 text-sky-300" />
                <div className="mt-2 text-sm font-medium">{p.title}</div>
                <div className="text-xs text-slate-400">{p.text}</div>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-500">系统内业务数据均为演示数据</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <img src="/favicon.svg" alt="" className="size-9" />
            <div className="text-lg font-semibold">达智汇 AgentOS</div>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">登录</h2>
          <p className="mt-1 text-sm text-slate-500">用岗位账号登录，解锁对应的智能体与数据</p>

          <label className="mt-6 block text-sm font-medium text-slate-700">
            账号
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ACCOUNTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setUsername(id)}
                className={`rounded-full px-2.5 py-0.5 text-xs ring-1 ${username === id ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'text-slate-500 ring-slate-200 hover:bg-slate-50'}`}
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
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </label>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button
            disabled={busy || !password}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy && <Spinner />}
            登录
          </button>
        </form>
      </section>
    </div>
  );
}
