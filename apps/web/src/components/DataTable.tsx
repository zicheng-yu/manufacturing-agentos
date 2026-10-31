import type { TableArtifact } from '@agentos/shared';
import { cx } from '../ui.tsx';

const BAD = new Set(['缺料风险', '已逾期', '延迟', '停机', '严重', '未开单', 'A 致命', '淘汰', '告警']);
const WARN = new Set(['低于安全库存', '进行中', '处理中', '招聘中', '待复核', '警告', '关注', '观察']);
const GOOD = new Set(['正常', '已完成', '已结案', '运行', '已到岗', '在途', '已关闭', '优选']);
/** Material, equipment, order and task codes read better in a fixed-width face. */
const CODE = /^[A-Z]{1,6}(-[A-Z0-9]+)+$/;

function tone(value: string | number): string | undefined {
  if (typeof value !== 'string') return 'num text-[15px] text-slate-900';
  if (BAD.has(value)) return 'text-red-700 font-semibold';
  if (WARN.has(value)) return 'text-watch-ink font-medium';
  if (GOOD.has(value)) return 'text-green-800';
  if (CODE.test(value)) return 'font-mono text-xs text-slate-900';
  return undefined;
}

export function DataTable({ table, compact }: { table: TableArtifact; compact?: boolean }) {
  return (
    <div>
      <div className="overflow-x-auto">
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
            {table.rows.map((row, i) => (
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
      {table.note && <p className="px-3 py-2 text-[11px] text-slate-400">{table.note}</p>}
    </div>
  );
}
