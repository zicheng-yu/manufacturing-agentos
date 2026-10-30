import { DOMAIN_LABELS, type Domain, type Level, type Severity } from '@agentos/shared';
import { Boxes, Briefcase, ShieldCheck, Truck, Users, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export const DOMAIN_ICONS: Record<Domain | 'executive', LucideIcon> = {
  supply: Truck,
  quality: ShieldCheck,
  logistics: Boxes,
  hr: Users,
  executive: Briefcase,
};

export function scopeLabel(scope: Domain | 'executive'): string {
  return scope === 'executive' ? '经营决策' : DOMAIN_LABELS[scope];
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const LEVEL_STYLE: Record<Level, { label: string; className: string; dot: string }> = {
  normal: { label: '正常', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-500' },
  watch: { label: '关注', className: 'bg-amber-50 text-amber-700 ring-amber-200', dot: 'bg-amber-500' },
  alert: { label: '告警', className: 'bg-red-50 text-red-700 ring-red-200', dot: 'bg-red-500' },
};

export function LevelPill({ level }: { level: Level }) {
  const s = LEVEL_STYLE[level];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1', s.className)}>
      <span className={cx('size-1.5 rounded-full', s.dot, level === 'alert' && 'animate-pulse')} />
      {s.label}
    </span>
  );
}

const SEVERITY_STYLE: Record<Severity, { label: string; className: string }> = {
  info: { label: '提示', className: 'bg-slate-100 text-slate-600' },
  warn: { label: '警告', className: 'bg-amber-100 text-amber-800' },
  critical: { label: '严重', className: 'bg-red-100 text-red-700' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return <span className={cx('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', s.className)}>{s.label}</span>;
}

export function DomainTag({ domain }: { domain: Domain | 'executive' }) {
  const Icon = DOMAIN_ICONS[domain];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
      <Icon className="size-3" />
      {scopeLabel(domain)}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-slate-400">{children}</p>;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const CHANNEL_LABELS: Record<string, string> = {
  agent: '智能体',
  bridge: '仿真事件桥',
  replay: '演示回放',
  seed: '历史记录',
  manual: '手工录入',
};
