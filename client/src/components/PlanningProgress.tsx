import React from 'react';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

export interface PlanningState {
  title: string;
  status: 'working' | 'success' | 'error';
  detail?: string;
  single?: boolean;
}

export const PlanningProgress: React.FC<{ state: PlanningState; onClose: () => void }> = ({ state, onClose }) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-live="polite" aria-label={state.title}>
    <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#202124] p-6 shadow-2xl text-slate-900 dark:text-slate-100">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
          {state.status === 'working' ? <Loader2 className="h-5 w-5 animate-spin" /> : state.status === 'success' ? <CheckCircle2 className="h-5 w-5" /> : <AlertCircle className="h-5 w-5 text-rose-500" />}
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{state.title}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-neutral-400">{state.status === 'working' ? '正在计算，请稍候' : state.detail}</p>
        </div>
      </div>
      {state.status === 'working' && (
        <div className="mt-6 space-y-3 rounded-2xl bg-slate-50 dark:bg-neutral-800/60 px-4 py-4 text-xs text-slate-600 dark:text-neutral-300">
          <p>读取可用时间与已有日程</p>
          <p>比较任务优先级、截止压力与分段</p>
          <p>{state.single ? '寻找合适的空闲时段' : '计算全部任务的安排并保存'}</p>
          <p className="text-[11px] text-slate-400 dark:text-neutral-500">计算内容 · 当前步骤由服务器统一处理</p>
        </div>
      )}
      {state.status !== 'working' && <button type="button" onClick={onClose} className="mt-6 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-700">完成</button>}
    </div>
  </div>
);
