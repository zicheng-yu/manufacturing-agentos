import { DOMAINS, ROLE_LABELS } from '@agentos/shared';
import { Activity, Bot, LayoutDashboard, LogOut, UserCog, type LucideIcon } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useSession } from '../session.tsx';
import { cx, DOMAIN_ICONS, scopeLabel } from '../ui.tsx';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export function Layout() {
  const { session, catalog, live, logout } = useSession();
  const location = useLocation();
  if (!session || !catalog) return null;
  const executive = session.account.role === 'executive';

  const main: NavItem[] = [
    { to: '/', label: '经营驾驶舱', icon: LayoutDashboard },
    { to: '/agents', label: '智能体工作台', icon: Bot },
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
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
          isActive ? 'bg-white/12 font-medium text-white' : 'text-slate-300 hover:bg-white/6 hover:text-white',
        )
      }
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );

  const llm = catalog.llm.mode === 'llm' ? catalog.llm.model : '离线规则模式';

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col bg-ink-900 text-white md:w-56">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src="/favicon.svg" alt="" className="size-8" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">{session.company.shortName} AgentOS</div>
            <div className="text-[11px] text-slate-400">{session.company.tagline}</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-visible">
          {main.map(link)}
          <div className="hidden px-3 pt-4 pb-1 text-[11px] tracking-wider text-slate-500 md:block">业务模块</div>
          {modules.map(link)}
          <div className="hidden px-3 pt-4 pb-1 text-[11px] tracking-wider text-slate-500 md:block">系统</div>
          {system.map(link)}
        </nav>
        <div className="hidden border-t border-white/10 px-4 py-3 text-xs md:block">
          <div className="font-medium">{session.account.displayName}</div>
          <div className="text-slate-400">{ROLE_LABELS[session.account.role]}</div>
          <button onClick={() => void logout()} className="mt-2 inline-flex items-center gap-1 text-slate-400 hover:text-white">
            <LogOut className="size-3.5" />
            退出登录
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-200 bg-white px-4 py-2.5 md:px-6">
          <div className="min-w-0 flex-1 truncate text-sm text-slate-500">
            <span className="hidden sm:inline">{session.company.name}</span>
          </div>
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-200" title={session.company.demoNotice}>
            演示数据
          </span>
          <span className="text-[11px] text-slate-500" title="当前模型">
            模型：{llm}
          </span>
          <span className={cx('inline-flex items-center gap-1.5 text-[11px]', live ? 'text-emerald-600' : 'text-slate-400')}>
            <span className={cx('size-2 rounded-full', live ? 'animate-pulse bg-emerald-500' : 'bg-slate-300')} />
            {live ? '实时连接' : '未连接'}
          </span>
          <button onClick={() => void logout()} className="text-[11px] text-slate-500 hover:text-slate-800 md:hidden">
            退出
          </button>
        </header>
        <main key={location.pathname.split('/')[1]} className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
