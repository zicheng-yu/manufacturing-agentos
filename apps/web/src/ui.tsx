import { DOMAIN_LABELS, type Domain, type Level, type Severity } from '@agentos/shared';
import { Boxes, Briefcase, Factory, HardHat, ShieldCheck, Truck, Users, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

export const DOMAIN_ICONS: Record<Domain | 'executive', LucideIcon> = {
  production: Factory,
  supply: Truck,
  quality: ShieldCheck,
  logistics: Boxes,
  hr: Users,
  ehs: HardHat,
  executive: Briefcase,
};

export function scopeLabel(scope: Domain | 'executive'): string {
  return scope === 'executive' ? '经营决策' : DOMAIN_LABELS[scope];
}

/** Readings: thousands separators for big counts, strings as they are. */
export function reading(value: string | number): string {
  return typeof value === 'number' && Math.abs(value) >= 10000 ? value.toLocaleString('en-US') : String(value);
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx('rounded-[10px] border border-slate-200 bg-white', className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Numbered section rule: "01 全局态势 SITUATION ———". */
export function Section({ no, title, en, action, children, className }: { no: string; title: string; en: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('space-y-3.5', className)}>
      <div className="flex items-center gap-3">
        <span className="num text-[22px] leading-none font-bold text-brand-600">{no}</span>
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        <span className="hidden font-mono text-[11px] tracking-[0.14em] text-slate-500 sm:inline">{en}</span>
        <span className="h-px flex-1 bg-slate-300" />
        {action}
      </div>
      {children}
    </section>
  );
}

/** A site photo over the striped placeholder, which stays visible when the photo is missing. */
export function Photo({ src, alt, className, children }: { src: string; alt: string; className?: string; children?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('photo-slot relative overflow-hidden', className)}>
      {!failed && <img src={src} alt={alt} onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
      {children}
    </div>
  );
}

// Alert and watch differ in lightness too (dark red with white text, pale amber with dark text), not only in hue.
const LEVEL_STYLE: Record<Level, { label: string; className: string }> = {
  normal: { label: '正常', className: 'bg-green-100 text-green-900' },
  watch: { label: '关注', className: 'bg-watch text-watch-ink' },
  alert: { label: '告警', className: 'bg-alert text-white' },
};

export function LevelPill({ level }: { level: Level }) {
  const s = LEVEL_STYLE[level];
  return <span className={cx('inline-flex shrink-0 items-center rounded px-2 py-0.5 text-xs font-semibold', s.className)}>{s.label}</span>;
}

/** Running / backlog / alert lamp. */
export function Lamp({ level, className }: { level: Level; className?: string }) {
  const color = { normal: 'bg-green-600 ring-green-600/20', watch: 'bg-amber-600 ring-amber-600/20', alert: 'bg-red-600 ring-red-600/20' }[level];
  return <span className={cx('inline-block size-2 shrink-0 rounded-full ring-[3px]', color, level === 'alert' && 'animate-pulse', className)} />;
}

const SEVERITY_STYLE: Record<Severity, { label: string; className: string }> = {
  info: { label: '提示', className: 'bg-slate-100 text-slate-600' },
  warn: { label: '警告', className: 'bg-watch text-watch-ink' },
  critical: { label: '严重', className: 'bg-alert text-white' },
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity];
  return <span className={cx('shrink-0 self-start rounded px-1.5 py-0.5 text-[11px] font-semibold', s.className)}>{s.label}</span>;
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
