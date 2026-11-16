import axios from 'axios';
import { Task, UserSettings } from '../models/types.js';
import { sendWeixinTextMessage } from './weixinGateway.js';

export const templates = {
  /**
   * 当任务关键字段缺失时，向用户索取补充信息的模板
   */
  askMissingFields: (
    title: string,
    missing: {
      duration: boolean;
      deadline: boolean;
      urgency: boolean;
      importance: boolean;
    }
  ) => {
    const list: string[] = [];
    if (missing.duration) {
      list.push(`• 预计耗时多少分钟？`);
    }
    if (missing.deadline) {
      list.push(`• 截止时间 (DDL)？`);
    }
    if (missing.importance) {
      list.push(`• 重要程度 (0-10分)？`);
    }

    return `📝 任务「${title}」需补充：\n` + list.join('\n');
  },

  /**
   * 日程规划成功提醒 (精简直观，去除冗长提示与说教)
   */
  scheduleSuccess: (
    title: string,
    startStr: string,
    endStr: string,
    duration: number,
    urgency: number,
    importance: number
  ) => {
    const qName =
      importance >= 5
        ? urgency >= 5
          ? 'Q1 重要且紧急'
          : 'Q2 重要不紧急'
        : urgency >= 5
        ? 'Q3 紧急不重要'
        : 'Q4 不重要不紧急';

    return (
      `📅 已排定「${title}」\n` +
      `• 时间：${startStr} ~ ${endStr} (${duration}分钟)\n` +
      `• 象限：${qName}`
    );
  },

  /**
   * 排程未找到合适空隙的提醒
   */
  scheduleFailed: (title: string, duration: number, reason: string) => {
    return `⚠️ 任务「${title}」(${duration}分钟) 暂无法排入：${reason}`;
  },

  /**
   * 提前完成模板
   */
  taskCompleted: (title: string) => {
    return `✅ 任务「${title}」已完成`;
  },

  /**
   * 延长时长模板
   */
  taskExtended: (title: string, extendMinutes: number, newEndStr: string) => {
    return `⏱️ 任务「${title}」已延长 ${extendMinutes} 分钟 (至 ${newEndStr})`;
  },

  /**
   * 重新安排模板
   */
  taskRescheduled: (title: string, newStartStr: string, newEndStr: string) => {
    return `🔄 任务「${title}」已重排至 ${newStartStr} ~ ${newEndStr}`;
  },

  /**
   * 开始前提醒模板
   */
  reminderBeforeStart: (title: string, startStr: string, endStr: string, minutes: number) => {
    return `🔔「${title}」将在 ${minutes} 分钟后开始 (${startStr} ~ ${endStr})`;
  },

  /**
   * 结束前核对询问模板
   */
  reminderBeforeEnd: (title: string, minutes: number) => {
    return `⏰「${title}」预计还有约 ${minutes} 分钟结束。已完成请回复「已完成」，需延时回复「延长XX分钟」。`;
  },

  /**
   * 每日日程概览
   */
  scheduleQueryList: (tasks: Task[], dateStr: string) => {
    if (tasks.length === 0) {
      return `📅 ${dateStr} 暂无排程中的待办任务`;
    }

    const lines = tasks.map((t, i) => {
      const s = t.scheduled_start ? new Date(t.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
      const e = t.scheduled_end ? new Date(t.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
      const statusIcon = t.status === 'completed' ? '✅' : '📌';
      return `${i + 1}. ${statusIcon} [${s}-${e}] ${t.title} (${t.duration_minutes}m)`;
    });

    return `📅 ${dateStr} 待办：\n` + lines.join('\n');
  },
};

/**
 * Send message out to WeChat via Weixin iLink or custom Clawbot Gateway API
 */
export async function sendClawbotMessage(settings: UserSettings, message: string): Promise<boolean> {
  // 1. If paired via OpenClaw / Tencent Weixin iLink, send directly to user
  if (settings.weixin_connected && settings.weixin_bot_token && settings.weixin_user_id) {
    const baseUrl = settings.weixin_base_url || 'https://ilinkai.weixin.qq.com';
    const res = await sendWeixinTextMessage(
      baseUrl,
      settings.weixin_bot_token,
      settings.weixin_bot_id || '',
      settings.weixin_user_id,
      message,
      settings.weixin_context_token
    );
    if (res.success) return true;
  }

  // 2. Fallback to custom Clawbot outbound webhook URL if configured
  if (!settings.clawbot_outbound_url) {
    console.log('[Clawbot Outbound Mock] (未配置 outbound_url，直接打印至控制台):');
    console.log(message);
    return true;
  }

  try {
    const payload = {
      to: settings.clawbot_to_wxid || undefined,
      content: message,
      text: message,
      message: message,
      key: settings.clawbot_outbound_key || undefined,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (settings.clawbot_outbound_key) {
      headers['Authorization'] = `Bearer ${settings.clawbot_outbound_key}`;
    }

    await axios.post(settings.clawbot_outbound_url, payload, {
      headers,
      timeout: 8000,
    });
    return true;
  } catch (err: any) {
    console.error('[Clawbot Outbound Error]:', err.message);
    return false;
  }
}
