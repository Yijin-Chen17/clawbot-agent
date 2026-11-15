import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import {
  ShieldCheck,
  Trash2,
  Clock,
  Check,
  AlertCircle,
  Ban,
  Mail,
  UserCheck,
} from 'lucide-react';

interface ManagedUser {
  id: number;
  username: string;
  email?: string;
  role: 'user' | 'admin';
  status: 'pending' | 'approved' | 'rejected' | 'banned';
  task_count: number;
  subscription_count: number;
  created_at: string;
}

export const AdminUsersView: React.FC<{ onRefreshCount?: () => void }> = ({ onRefreshCount }) => {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'approved' | 'banned' | 'pending'>('all');

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/users');
      setUsers(res.data.users);
      if (onRefreshCount) onRefreshCount();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleBan = async (id: number, username: string) => {
    if (!window.confirm(`确定要封禁用户「${username}」吗？封禁后该用户将无法登录系统。`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/ban`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '封禁操作失败');
    }
  };

  const handleUnban = async (id: number, username: string) => {
    if (!window.confirm(`确定要解封用户「${username}」吗？`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/unban`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '解封操作失败');
    }
  };

  const handleApprove = async (id: number) => {
    try {
      const res = await api.put(`/admin/users/${id}/approve`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '操作失败');
    }
  };

  const handleToggleRole = async (id: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    if (!window.confirm(`确定将该用户的角色切换为「${newRole}」吗？`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/role`, { role: newRole });
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '修改角色失败');
    }
  };

  const handleDelete = async (id: number, username: string) => {
    if (!window.confirm(`确定要彻底删除用户「${username}」吗？其所有待办日程、配置数据将被彻底清空且不可恢复！`)) return;
    try {
      await api.delete(`/admin/users/${id}`);
      alert('用户已成功删除');
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '删除失败');
    }
  };

  const filteredUsers = users.filter((u) => {
    if (filter === 'all') return true;
    return u.status === filter;
  });

  const bannedCount = users.filter((u) => u.status === 'banned').length;
  const approvedCount = users.filter((u) => u.status === 'approved').length;
  const pendingCount = users.filter((u) => u.status === 'pending').length;

  return (
    <div className="w-full max-w-5xl mx-auto flex-1 min-h-0 flex flex-col space-y-4 overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <span>用户账号与安全管理</span>
            {bannedCount > 0 && (
              <span className="bg-rose-500 text-white text-xs px-2.5 py-0.5 rounded-full font-semibold">
                {bannedCount} 已封禁
              </span>
            )}
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
            查看已注册用户邮箱、管理账号权限状态、支持快捷封禁、解封或彻底删除用户数据
          </p>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {[
            { key: 'all', label: `全部 (${users.length})` },
            { key: 'approved', label: `正常 (${approvedCount})` },
            { key: 'banned', label: `已封禁 (${bannedCount})` },
            ...(pendingCount > 0 ? [{ key: 'pending', label: `待审核 (${pendingCount})` }] : []),
          ].map((item) => (
            <button
              key={item.key}
              onClick={() => setFilter(item.key as any)}
              className={`px-3.5 py-1.5 rounded-full text-xs font-medium shrink-0 transition cursor-pointer ${
                filter === item.key
                  ? 'bg-blue-600 text-white dark:bg-blue-500 shadow-xs'
                  : 'bg-white dark:bg-[#1e1f20] text-gray-600 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Surface Card Container */}
      <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl overflow-hidden flex flex-col shadow-2xs">
        {/* Desktop Table View */}
        <div className="hidden sm:block flex-1 min-h-0 overflow-y-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-[#f8fafd] dark:bg-[#28292a] text-gray-500 dark:text-neutral-400 font-semibold sticky top-0 border-b border-gray-200 dark:border-neutral-800 z-10">
              <tr>
                <th className="px-5 py-3.5">账号 / 注册邮箱</th>
                <th className="px-5 py-3.5">角色权限</th>
                <th className="px-5 py-3.5">账号状态</th>
                <th className="px-5 py-3.5">任务 / 订阅</th>
                <th className="px-5 py-3.5">注册时间</th>
                <th className="px-5 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-neutral-800/80">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400 text-xs">
                    暂无符合条件的用户
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  const isRootAdmin = u.role === 'admin' && u.username === 'admin';

                  return (
                    <tr
                      key={u.id}
                      className="hover:bg-gray-50/50 dark:hover:bg-neutral-800/40 transition"
                    >
                      <td className="px-5 py-4">
                        <div className="flex flex-col">
                          <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                            <span>{u.username}</span>
                            {isSelf && (
                              <span className="text-[10px] bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 px-1.5 py-0.2 rounded-full border border-blue-200 dark:border-blue-800">
                                当前账号
                              </span>
                            )}
                          </div>
                          {u.email ? (
                            <span className="text-[11px] text-gray-500 dark:text-neutral-400 font-mono flex items-center gap-1 mt-0.5">
                              <Mail className="w-3 h-3 text-gray-400" />
                              {u.email}
                            </span>
                          ) : (
                            <span className="text-[11px] text-gray-400 dark:text-neutral-500 font-mono mt-0.5">
                              UID: #{u.id}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="px-5 py-4">
                        <button
                          onClick={() => handleToggleRole(u.id, u.role)}
                          disabled={isSelf || isRootAdmin}
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition ${
                            u.role === 'admin'
                              ? 'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                              : 'bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-300'
                          } ${isSelf || isRootAdmin ? 'cursor-default opacity-80' : 'cursor-pointer hover:opacity-80'}`}
                          title={isSelf ? '不能修改自身角色' : '点击切换角色权限'}
                        >
                          <ShieldCheck className="w-3 h-3" />
                          {u.role === 'admin' ? '系统管理员' : '普通用户'}
                        </button>
                      </td>

                      <td className="px-5 py-4">
                        {u.status === 'approved' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                            <Check className="w-3 h-3" />
                            正常
                          </span>
                        )}
                        {u.status === 'banned' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                            <Ban className="w-3 h-3" />
                            已封禁
                          </span>
                        )}
                        {u.status === 'pending' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                            <Clock className="w-3 h-3" />
                            待审核
                          </span>
                        )}
                        {u.status === 'rejected' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-400">
                            <AlertCircle className="w-3 h-3" />
                            已拒绝
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-4 text-gray-600 dark:text-neutral-400">
                        <span>{u.task_count} 条待办</span>
                        <span className="text-gray-300 dark:text-neutral-600 mx-1.5">/</span>
                        <span>{u.subscription_count} 订阅</span>
                      </td>

                      <td className="px-5 py-4 text-gray-400 dark:text-neutral-500 font-mono text-[11px]">
                        {new Date(u.created_at).toLocaleDateString('zh-CN')}
                      </td>

                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {u.status === 'pending' && (
                            <button
                              onClick={() => handleApprove(u.id)}
                              className="px-3.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-full shadow-xs transition cursor-pointer"
                            >
                              放行
                            </button>
                          )}

                          {u.status === 'banned' && !isSelf && (
                            <button
                              onClick={() => handleUnban(u.id, u.username)}
                              className="px-3 py-1 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 text-emerald-700 dark:text-emerald-300 font-medium rounded-full border border-emerald-200 dark:border-emerald-800 transition cursor-pointer flex items-center gap-1"
                            >
                              <UserCheck className="w-3 h-3" />
                              解封
                            </button>
                          )}

                          {u.status === 'approved' && !isSelf && !isRootAdmin && (
                            <button
                              onClick={() => handleBan(u.id, u.username)}
                              className="px-3 py-1 bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 text-rose-700 dark:text-rose-300 font-medium rounded-full border border-rose-200 dark:border-rose-800 transition cursor-pointer flex items-center gap-1"
                            >
                              <Ban className="w-3 h-3" />
                              封禁
                            </button>
                          )}

                          {!isSelf && !isRootAdmin && (
                            <button
                              onClick={() => handleDelete(u.id, u.username)}
                              className="p-1.5 text-gray-400 dark:text-neutral-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-full transition cursor-pointer"
                              title="彻底删除用户"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Mobile Cards View */}
        <div className="sm:hidden divide-y divide-gray-100 dark:divide-neutral-800 overflow-y-auto">
          {filteredUsers.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-xs">暂无用户</div>
          ) : (
            filteredUsers.map((u) => {
              const isSelf = u.id === currentUser?.id;
              const isRootAdmin = u.role === 'admin' && u.username === 'admin';

              return (
                <div key={u.id} className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-gray-900 dark:text-gray-100 text-sm flex items-center gap-1.5">
                        <span>{u.username}</span>
                        {isSelf && (
                          <span className="text-[10px] bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 px-1.5 py-0.2 rounded-full">
                            自己
                          </span>
                        )}
                      </div>
                      {u.email && (
                        <span className="text-[11px] text-gray-500 dark:text-neutral-400 font-mono block">
                          {u.email}
                        </span>
                      )}
                    </div>

                    {u.status === 'approved' && (
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">
                        正常
                      </span>
                    )}
                    {u.status === 'banned' && (
                      <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300">
                        已封禁
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400">
                    <span>{u.role === 'admin' ? '系统管理员' : '普通用户'}</span>
                    <span>{u.task_count} 任务 · {u.subscription_count} 订阅</span>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-neutral-800/80">
                    {u.status === 'banned' && !isSelf && (
                      <button
                        onClick={() => handleUnban(u.id, u.username)}
                        className="px-3 py-1 bg-emerald-600 text-white rounded-full text-xs font-medium"
                      >
                        解封
                      </button>
                    )}
                    {u.status === 'approved' && !isSelf && !isRootAdmin && (
                      <button
                        onClick={() => handleBan(u.id, u.username)}
                        className="px-3 py-1 bg-rose-50 dark:bg-rose-950/50 text-rose-600 rounded-full text-xs font-medium border border-rose-200"
                      >
                        封禁
                      </button>
                    )}
                    {!isSelf && !isRootAdmin && (
                      <button
                        onClick={() => handleDelete(u.id, u.username)}
                        className="p-1.5 text-gray-400 hover:text-rose-600 rounded-full"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
