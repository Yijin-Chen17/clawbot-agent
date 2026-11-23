import React, { useState } from 'react';
import type { TaskItem } from '../types/task';
import { QUADRANTS_CONFIG } from '../constants/quadrants';
import { api } from '../api/client';
import { X, Download, Upload, Copy, Check, RotateCcw, FileText } from 'lucide-react';

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: TaskItem[];
  onImport: (data: unknown, mode?: 'merge' | 'replace') => Promise<{
    importedCount?: number;
    skippedCount?: number;
    failedCount?: number;
  }>;
  onClearAll: () => Promise<void>;
}

export const BackupModal: React.FC<BackupModalProps> = ({
  isOpen,
  onClose,
  tasks,
  onImport,
  onClearAll,
}) => {
  const { t, language } = useTheme();
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');
  const [importJsonText, setImportJsonText] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [copiedType, setCopiedType] = useState<'json' | 'markdown' | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [previewInfo, setPreviewInfo] = useState<{ total: number; newCount: number; duplicateCount: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const generateMarkdown = () => {
    let md = `# ${t('backup.md_title', '艾森豪威尔四象限待办清单')}\n\n${t('backup.export_time', '导出时间')}：${new Date().toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}\n\n`;

    const grouped: Record<string, TaskItem[]> = {
      q1: tasks.filter((t) => t.isImportant && t.isUrgent),
      q2: tasks.filter((t) => t.isImportant && !t.isUrgent),
      q3: tasks.filter((t) => !t.isImportant && t.isUrgent),
      q4: tasks.filter((t) => !t.isImportant && !t.isUrgent),
    };

    (['q1', 'q2', 'q3', 'q4'] as const).forEach((qid) => {
      const meta = QUADRANTS_CONFIG[qid];
      const list = grouped[qid];
      const qTitle = language === 'en' ? meta.englishName : meta.name;
      const qAction = language === 'en' ? (meta.action.split('(')[1]?.replace(')', '') || meta.action) : meta.action;
      md += `### ${qTitle} (${qAction})\n`;
      if (list.length === 0) {
        md += `_${t('backup.no_items', '暂无事项')}_\n\n`;
      } else {
        list.forEach((t) => {
          const check = t.isCompleted ? '[x]' : '[ ]';
          const due = t.dueDate ? ` 📅 ${t.dueDate}` : '';
          const tags = t.tags && t.tags.length > 0 ? ` 🏷️ ${t.tags.map((tg) => `#${tg}`).join(' ')}` : '';
          md += `- ${check} ${t.title}${due}${tags}\n`;
          if (t.description) {
            md += `  > ${t.description.replace(/\n/g, '\n  > ')}\n`;
          }
        });
        md += `\n`;
      }
    });

    return md;
  };

  const handleCopy = async (text: string, type: 'json' | 'markdown') => {
    if (type === 'json') {
      try {
        const res = await api.get('/tasks/backup');
        navigator.clipboard.writeText(JSON.stringify(res.data, null, 2));
      } catch {
        navigator.clipboard.writeText(text);
      }
    } else {
      navigator.clipboard.writeText(text);
    }
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const handleDownloadJson = async () => {
    let exportData: unknown = tasks;
    try {
      const res = await api.get('/tasks/backup');
      exportData = res.data;
    } catch {}
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `clawbot_backup_${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const parseImportPayload = (rawText: string) => {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed) && !(parsed && typeof parsed === 'object' && Array.isArray(parsed.tasks))) {
      throw new Error('导入数据必须是任务数组或版本化备份对象');
    }
    return parsed;
  };

  const handlePreview = async (rawText: string, mode: 'merge' | 'replace') => {
    setImportError(null);
    setPreviewInfo(null);
    try {
      const parsed = parseImportPayload(rawText);
      const res = await api.post('/tasks/backup/preview', { data: parsed, mode });
      setPreviewInfo({
        total: res.data.total,
        newCount: res.data.newCount,
        duplicateCount: res.data.duplicateCount,
      });
    } catch (err: any) {
      setImportError(err.response?.data?.error || err.message || 'JSON 解析失败，请检查格式');
    }
  };

  const handleImportSubmit = async () => {
    setImportError(null);
    setSubmitting(true);
    try {
      const parsed = parseImportPayload(importJsonText);
      const result = await onImport(parsed, importMode);
      const imp = result?.importedCount ?? 0;
      const skip = result?.skippedCount ?? 0;
      const fail = result?.failedCount ?? 0;
      alert(`导入完成：新增 ${imp} 项，跳过重复 ${skip} 项${fail > 0 ? `，失败 ${fail} 项` : ''}。`);
      onClose();
    } catch (err: any) {
      setImportError(err.response?.data?.error || err.message || '导入失败，请检查格式或重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string;
        setImportJsonText(content);
        await handlePreview(content, importMode);
      } catch {
        setImportError('文件读取失败或不是合法 JSON');
      }
    };
    reader.readAsText(file);
  };

  const handleClear = async () => {
    setSubmitting(true);
    try {
      await onClearAll();
    } catch (err: any) {
      alert(err.response?.data?.error || '清空失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 shadow-2xl overflow-hidden transition-all animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-neutral-800">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {t('backup.title', '数据备份、导入与导出')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex border-b border-gray-100 dark:border-neutral-800 px-6 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('export')}
            className={`pb-3 text-xs font-semibold border-b-2 mr-6 transition-all cursor-pointer ${
              activeTab === 'export'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            {t('backup.tab_export', '导出与分享')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('import')}
            className={`pb-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
              activeTab === 'import'
                ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-neutral-400 dark:hover:text-neutral-200'
            }`}
          >
            {t('backup.tab_import', '导入与恢复')}
          </button>
        </div>

        <div className="p-6">
          {activeTab === 'export' ? (
            <div className="space-y-4">
              <div className="p-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-800/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Download className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-xs font-bold text-gray-900 dark:text-gray-100">
                      导出版本化完整备份 (JSON v2)
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopy(JSON.stringify(tasks, null, 2), 'json')}
                      className="px-3 py-1.5 rounded-full border border-gray-200 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 inline-flex items-center gap-1 cursor-pointer"
                    >
                      {copiedType === 'json' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedType === 'json' ? t('common.copied', '已复制') : t('backup.copy_json', '复制 JSON')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadJson}
                      className="px-3.5 py-1.5 rounded-full bg-blue-600 text-xs font-semibold text-white hover:bg-blue-700 inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" /> {t('backup.download_file', '下载文件')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-gray-50/50 dark:bg-neutral-800/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <div>
                      <span className="text-xs font-bold text-gray-900 dark:text-gray-100">
                        {t('backup.export_md', '导出为 Markdown 清单')}
                      </span>
                      <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                        {t('backup.export_md_desc', '适合粘贴至周报、Notion 或个人笔记软件')}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(generateMarkdown(), 'markdown')}
                    className="px-3.5 py-1.5 rounded-full border border-gray-200 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 inline-flex items-center gap-1 cursor-pointer"
                  >
                    {copiedType === 'markdown' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                    <span>{copiedType === 'markdown' ? t('common.copied', '已复制') : t('backup.copy_md', '复制 Markdown')}</span>
                  </button>
                </div>
              </div>

              <div className="pt-2 flex items-center justify-between">
                <span className="text-xs text-gray-400 dark:text-neutral-500">
                  {t('backup.total_tasks', '当前待办总数：')}{tasks.length} {t('common.items', '项')}
                </span>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleClear}
                  className="text-xs text-rose-600 hover:text-rose-700 dark:text-rose-400 inline-flex items-center gap-1 cursor-pointer disabled:opacity-40"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>{t('backup.clear_all', '清空所有待办')}</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4 text-xs">
                <span className="font-semibold text-gray-700 dark:text-neutral-300">导入模式：</span>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={importMode === 'merge'}
                    onChange={() => {
                      setImportMode('merge');
                      if (importJsonText.trim()) handlePreview(importJsonText, 'merge');
                    }}
                  />
                  <span>合并去重（保留现有）</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    checked={importMode === 'replace'}
                    onChange={() => {
                      setImportMode('replace');
                      if (importJsonText.trim()) handlePreview(importJsonText, 'replace');
                    }}
                  />
                  <span>覆盖替换</span>
                </label>
              </div>

              <div>
                <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-gray-200 dark:border-neutral-700 rounded-xl cursor-pointer hover:border-blue-500 hover:bg-gray-50 dark:hover:bg-neutral-800/50 transition-colors">
                  <Upload className="h-6 w-6 text-gray-400 mb-1" />
                  <span className="text-xs font-medium text-gray-700 dark:text-neutral-300">
                    点击上传 JSON 备份文件（将先预览变更）
                  </span>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1">
                  {t('backup.paste_json', '或直接粘贴 JSON 文本')}
                </label>
                <textarea
                  rows={4}
                  value={importJsonText}
                  onChange={(e) => {
                    setImportJsonText(e.target.value);
                    setPreviewInfo(null);
                  }}
                  placeholder='{ "schemaVersion": 2, "tasks": [ ... ] }'
                  className="w-full rounded-xl border border-gray-300 bg-white p-3 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100 font-mono"
                />
              </div>

              {previewInfo && (
                <div className="text-xs text-blue-700 bg-blue-50 dark:text-blue-200 dark:bg-blue-950/40 p-2.5 rounded-lg border border-blue-200 dark:border-blue-900">
                  预览：共 {previewInfo.total} 项 · 将导入 {previewInfo.newCount} 项 · 跳过重复 {previewInfo.duplicateCount} 项
                </div>
              )}

              {importError && (
                <div className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/40 p-2.5 rounded-lg border border-rose-200 dark:border-rose-900">
                  {importError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={!importJsonText.trim() || submitting}
                  onClick={() => handlePreview(importJsonText, importMode)}
                  className="px-3.5 py-2 rounded-full text-xs font-semibold border border-gray-300 dark:border-neutral-700 text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-40 cursor-pointer"
                >
                  预览变更
                </button>
                <button
                  type="button"
                  onClick={handleImportSubmit}
                  disabled={!importJsonText.trim() || submitting}
                  className="px-4 py-2 rounded-full text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 cursor-pointer"
                >
                  {submitting ? '导入中...' : '确认导入数据'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
