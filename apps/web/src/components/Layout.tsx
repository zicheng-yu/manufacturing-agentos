import { DOMAINS, ROLE_LABELS } from '@agentos/shared';
import { Activity, BookOpen, Bot, Handshake, LayoutDashboard, LogOut, UserCog, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useSession } from '../session.tsx';
import { cx, DOMAIN_ICONS, scopeLabel } from '../ui.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

/** Wall-clock for the live demo, China time like the shop floor. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const text = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
  return <span className="hidden font-mono text-xs text-slate-900 tabular-nums lg:inline">{text.replace('/', '-')}</span>;
}

export function Layout() {
  const { session, catalog, live, logout } = useSession();
  const location = useLocation();
  if (!session || !catalog) return null;
  const executive = session.account.role === 'executive';

  const main: NavItem[] = [
    { to: '/', label: '经营驾驶舱', icon: LayoutDashboard },
    { to: '/agents', label: '智能体工作台', icon: Bot },
    { to: '/cases', label: '协作事项', icon: Handshake },
    { to: '/employee-service', label: '公司制度助手', icon: BookOpen },
  ];
  const modules: NavItem[] = DOMAINS.filter((d) => session.domains.includes(d)).map((d) => ({
    to: `/m/${d}`,
    label: scopeLabel(d),
    icon: DOMAIN_ICONS[d],
  }));
  const system: NavItem[] = [
    { to: '/events', label: '事件中心', icon: Activity },
    ...(executive ? [{ to: '/accounts', label: '账号与权限', icon: UserCog }] : []),
  ];

  const link = (item: NavItem) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        cx(
          'flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
          isActive ? 'bg-slate-300/60 font-semibold text-slate-900' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );

  const llm = catalog.llm.mode === 'llm' ? catalog.llm.model : '离线规则模式';

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col md:flex-row">
      <aside className="flex min-h-0 min-w-0 shrink-0 flex-col border-b border-slate-200 bg-white text-slate-900 md:w-54 md:border-r md:border-b-0">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
            <span className="num text-[22px] font-bold">D</span>
          </span>
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-bold">{session.company.shortName} AgentOS</div>
            <div className="font-mono text-[10px] tracking-[0.08em] text-slate-400">MANUFACTURING · OS</div>
          </div>
        </div>
        <nav aria-label="主导航" className="flex min-h-0 min-w-0 gap-0.5 overflow-x-auto px-2.5 pb-2 md:flex-1 md:flex-col md:overflow-x-hidden md:overflow-y-auto">
          {main.map(link)}
          <div className="hidden px-2.5 pt-4 pb-1 font-mono text-[10px] tracking-[0.12em] text-slate-400 md:block">业务模块 · MODULES</div>
          {modules.map(link)}
          <div className="hidden px-2.5 pt-4 pb-1 font-mono text-[10px] tracking-[0.12em] text-slate-400 md:block">系统 · SYSTEM</div>
          {system.map(link)}
        </nav>
        <div className="hidden items-center gap-2.5 border-t border-slate-200 px-4 py-3 md:flex">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[13px] font-bold text-slate-700">{session.account.displayName.slice(0, 1)}</span>
          <div className="min-w-0 flex-1 text-xs leading-tight">
            <div className="font-semibold text-slate-900">{session.account.displayName}</div>
            <div className="text-slate-500">{ROLE_LABELS[session.account.role]}</div>
          </div>
          <button onClick={() => void logout()} aria-label="退出登录" title="退出登录" className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-slate-200 bg-white px-4 py-3 md:px-7">
          <div className="min-w-0 flex-1 truncate text-[13px] text-slate-600">
            <span className="hidden sm:inline">{session.company.name}</span>
          </div>
          <span className="rounded-full border border-watch-line bg-watch-soft px-2.5 py-0.5 text-xs text-watch-ink" title={session.company.demoNotice}>
            演示数据
          </span>
          <span className="hidden max-w-56 truncate font-mono text-xs text-slate-600 lg:inline" title={`当前模型：${llm}`}>
            MODEL · {llm}
          </span>
          <span className={cx('inline-flex items-center gap-1.5 text-xs', live ? 'text-green-700' : 'text-slate-500')}>
            <span className={cx('size-2 rounded-full ring-[3px]', live ? 'bg-green-600 ring-green-600/20' : 'bg-slate-300 ring-transparent')} />
            {live ? '实时连接' : '未连接'}
          </span>
          <Clock />
          <button onClick={() => void logout()} className="text-[11px] text-slate-500 hover:text-slate-800 md:hidden">
            退出
          </button>
        </header>
        <main key={location.pathname.split('/')[1]} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
