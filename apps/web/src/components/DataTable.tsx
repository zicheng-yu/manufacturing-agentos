import type { TableArtifact } from '@agentos/shared';
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui.tsx';

const BAD = new Set(['缺料风险', '已逾期', '延迟', '停机', '严重', '未开单', 'A 致命', '淘汰', '告警']);
const WARN = new Set(['低于安全库存', '进行中', '处理中', '招聘中', '待复核', '警告', '关注', '观察']);
const GOOD = new Set(['正常', '已完成', '已结案', '运行', '已到岗', '在途', '已关闭', '优选']);
/** Material, equipment, order and task codes read better in a fixed-width face. */
const CODE = /^[A-Z]{1,6}(-[A-Z0-9]+)+$/;

function tone(value: string | number): string | undefined {
  if (typeof value !== 'string') return 'num text-[15px] text-slate-900';
  if (BAD.has(value)) return 'text-alert-ink font-semibold';
  if (WARN.has(value)) return 'text-watch-ink font-medium';
  if (GOOD.has(value)) return 'text-green-800';
  if (CODE.test(value)) return 'font-mono text-xs text-slate-900';
  return undefined;
}

/** Past this many rows a table is folded, so the handful that matter are not buried among the normal ones. */
const FOLD_AFTER = 14;
const FOLDED_SHOWS = 12;

/** 0 = a row with a failing status, 1 = a row to watch, 2 = nothing flagged. */
function urgency(row: (string | number)[]): number {
  if (row.some((cell) => typeof cell === 'string' && BAD.has(cell))) return 0;
  if (row.some((cell) => typeof cell === 'string' && WARN.has(cell))) return 1;
  return 2;
}

export function DataTable({ table, compact }: { table: TableArtifact; compact?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const foldable = table.rows.length > FOLD_AFTER;
  // Flagged rows go first, in their original order; the same order is kept whether folded or not.
  const ordered = foldable ? table.rows.map((row, i) => ({ row, i })).sort((a, b) => urgency(a.row) - urgency(b.row) || a.i - b.i).map((x) => x.row) : table.rows;
  const flagged = foldable ? table.rows.filter((row) => urgency(row) < 2).length : 0;
  const shown = foldable && !expanded ? ordered.slice(0, Math.max(FOLDED_SHOWS, Math.min(flagged, 30))) : ordered;
  useEffect(() => {
    const element = viewport.current!;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [table]);
  return (
    <div className="min-w-0 max-w-full">
      {overflowing && <p className="px-3 py-1.5 text-[11px] text-slate-500">左右滚动查看完整表格</p>}
      <div ref={viewport} className="max-w-full overflow-x-auto" tabIndex={overflowing ? 0 : undefined} aria-label={overflowing ? `${table.title}，可横向滚动查看全部列` : table.title}>
        <table className="w-full min-w-max text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
              {table.columns.map((column) => (
                <th key={column} className={cx('font-semibold whitespace-nowrap', compact ? 'px-2 py-1.5' : 'px-3 py-2')}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className={cx(
                      'align-top text-slate-700',
                      compact ? 'px-2 py-1.5' : 'px-3 py-2',
                      String(cell).length > 24 ? 'max-w-80 min-w-48 whitespace-normal' : 'whitespace-nowrap',
                      tone(cell),
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {foldable && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <span>
            共 {table.rows.length} 行{flagged ? `，有风险或需关注的 ${flagged} 行已排在前面` : ''}
            {!expanded && shown.length < table.rows.length ? `；其余 ${table.rows.length - shown.length} 行已收起` : ''}
          </span>
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)} className="font-medium text-brand-700 hover:underline">
            {expanded ? '收起' : '展开全部'}
          </button>
        </div>
      )}
      {table.note && <p className="px-3 py-2 text-[11px] text-slate-500">{table.note}</p>}
    </div>
  );
}
