import { ROLE_LABELS, type Account } from '@agentos/shared';
import { useApi } from '../api.ts';
import { useSession } from '../session.tsx';
import { Card, scopeLabel, Spinner, timeAgo } from '../ui.tsx';

export function Accounts() {
  const { data } = useApi<(Account & { conversations: number })[]>('/api/accounts');
  const { session } = useSession();
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">账号与权限</h1>
        <p className="text-sm text-slate-500">用什么身份登录，就解锁什么模块、智能体与事件；董事长可见全部</p>
      </div>
      <Card>
        {!data ? (
          <div className="flex justify-center p-8 text-slate-400"><Spinner /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                  <th className="px-4 py-2 font-medium">账号</th>
                  <th className="px-4 py-2 font-medium">姓名</th>
                  <th className="px-4 py-2 font-medium">角色</th>
                  <th className="px-4 py-2 font-medium">可见模块</th>
                  <th className="px-4 py-2 font-medium">对话</th>
                  <th className="px-4 py-2 font-medium">最近登录</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{a.username}</td>
                    <td className="px-4 py-2.5 text-slate-800">{a.displayName}</td>
                    <td className="px-4 py-2.5 text-slate-600">{ROLE_LABELS[a.role]}</td>
                    <td className="px-4 py-2.5 text-slate-600">
                      {a.role === 'executive' ? '全部模块' : scopeLabel(a.role.replace('_mgr', '') as never)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 tabular-nums">{a.conversations}</td>
                    <td className="px-4 py-2.5 text-slate-500">{a.lastLoginAt ? timeAgo(a.lastLoginAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-slate-400">{session?.company.demoNotice}</p>
    </div>
  );
}
