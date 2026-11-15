import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { db } from '../config/database.js';
import { Task } from '../models/types.js';

function escapeXml(unsafe: string): string {
  return (unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getFontPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'server/assets/fonts/font.ttf'),
    path.resolve(process.cwd(), 'assets/fonts/font.ttf'),
    path.resolve('/home/calcury/app/clawbot-agent/server/assets/fonts/font.ttf'),
    path.resolve('/home/calcury/clawbot-agent/server/assets/fonts/font.ttf'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function renderSvgToPng(svg: string): Buffer {
  const fontFile = getFontPath();
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: fontFile ? [fontFile] : [],
      loadSystemFonts: true,
      defaultFontFamily: fontFile ? 'SimHei' : 'sans-serif',
    },
    fitTo: {
      mode: 'zoom',
      value: 1.5, // 1.5x retina clarity
    },
  });
  return resvg.render().asPng();
}

function getMondayOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  // Monday as first day of week (ISO-8601)
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getWeekNumber(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

interface CalendarWeekItem {
  timeStr: string;
  startTimeVal: number;
  type: 'external' | 'task';
  title: string;
  badge: string;
  badgeBg: string;
  badgeColor: string;
  borderColor: string;
  isCompleted?: boolean;
  subText: string;
}

/**
 * 1. Render modern "Full Week Schedule & Calendar" (完整周日历) PNG Image
 */
export async function renderWeekCalendarImage(userId: number): Promise<Buffer> {
  const now = new Date();
  const monday = getMondayOfWeek(now);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);

  const weekStartIso = monday.toISOString();
  const weekEndIso = sunday.toISOString();

  // 1. Fetch external events for the entire week
  const externalEvents = db.prepare(`
    SELECT title, start_time, end_time, is_all_day
    FROM external_events
    WHERE user_id = ? AND end_time >= ? AND start_time <= ?
    ORDER BY start_time ASC
  `).all(userId, weekStartIso, weekEndIso) as { title: string; start_time: string; end_time: string; is_all_day: number }[];

  // 2. Fetch scheduled tasks for the entire week
  const scheduledTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
      AND scheduled_end >= ?
      AND scheduled_start <= ?
    ORDER BY scheduled_start ASC
  `).all(userId, weekStartIso, weekEndIso) as Task[];

  const weekdaysZh = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekdaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const days: {
    index: number;
    date: Date;
    dayStart: Date;
    dayEnd: Date;
    weekdayZh: string;
    weekdayEn: string;
    dateStr: string;
    isToday: boolean;
    items: CalendarWeekItem[];
  }[] = [];

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 23, 59, 59, 999);
    const isToday =
      now.getFullYear() === dayDate.getFullYear() &&
      now.getMonth() === dayDate.getMonth() &&
      now.getDate() === dayDate.getDate();

    days.push({
      index: i,
      date: dayDate,
      dayStart,
      dayEnd,
      weekdayZh: weekdaysZh[i],
      weekdayEn: weekdaysEn[i],
      dateStr: `${String(dayDate.getMonth() + 1).padStart(2, '0')}/${String(dayDate.getDate()).padStart(2, '0')}`,
      isToday,
      items: [],
    });
  }

  let totalExternal = 0;
  let totalTasks = 0;
  let totalCompleted = 0;

  // Distribute external events into corresponding days
  for (const ext of externalEvents) {
    const sDate = new Date(ext.start_time);
    const eDate = new Date(ext.end_time);
    totalExternal++;

    for (const d of days) {
      if (eDate.getTime() >= d.dayStart.getTime() && sDate.getTime() <= d.dayEnd.getTime()) {
        const timeStr = ext.is_all_day
          ? '全天'
          : `${sDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}~${eDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

        d.items.push({
          timeStr,
          startTimeVal: sDate.getTime(),
          type: 'external',
          title: ext.title,
          badge: '外部',
          badgeBg: '#3b0764',
          badgeColor: '#c084fc',
          borderColor: '#8b5cf6',
          subText: '订阅日历同步',
        });
      }
    }
  }

  // Distribute scheduled tasks into corresponding days
  for (const t of scheduledTasks) {
    const sDate = new Date(t.scheduled_start!);
    const eDate = new Date(t.scheduled_end!);
    totalTasks++;
    const isCompleted = t.status === 'completed';
    if (isCompleted) totalCompleted++;

    for (const d of days) {
      if (eDate.getTime() >= d.dayStart.getTime() && sDate.getTime() <= d.dayEnd.getTime()) {
        const timeStr = `${sDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}~${eDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

        let badge = 'Schedule';
        let badgeBg = '#1e3a8a';
        let badgeColor = '#60a5fa';
        let borderColor = '#3b82f6';

        if (isCompleted) {
          badge = '已完成';
          badgeBg = '#064e3b';
          badgeColor = '#34d399';
          borderColor = '#10b981';
        } else {
          const imp = (t.importance ?? 5) >= 5;
          const urg = (t.urgency ?? 5) >= 5;
          if (imp && urg) {
            badge = 'Do First';
            badgeBg = '#4c0519';
            badgeColor = '#fb7185';
            borderColor = '#f43f5e';
          } else if (imp && !urg) {
            badge = 'Schedule';
            badgeBg = '#1e3a8a';
            badgeColor = '#60a5fa';
            borderColor = '#3b82f6';
          } else if (!imp && urg) {
            badge = 'Delegate';
            badgeBg = '#451a03';
            badgeColor = '#fbbf24';
            borderColor = '#f59e0b';
          } else {
            badge = 'Eliminate';
            badgeBg = '#111827';
            badgeColor = '#9ca3af';
            borderColor = '#6b7280';
          }
        }

        d.items.push({
          timeStr,
          startTimeVal: sDate.getTime(),
          type: 'task',
          title: t.title,
          badge,
          badgeBg,
          badgeColor,
          borderColor,
          isCompleted,
          subText: `${t.duration_minutes || 60}m · 智能排程`,
        });
      }
    }
  }

  // Sort each day's items
  for (const d of days) {
    d.items.sort((a, b) => a.startTimeVal - b.startTimeVal);
  }

  const maxItems = Math.max(...days.map((d) => d.items.length), 3);
  const columnWidth = 166;
  const columnGap = 10;
  const leftMargin = 27;
  const headerBannerHeight = 110;
  const dayHeaderHeight = 54;
  const itemCardHeight = 66;
  const itemCardGap = 8;
  const contentHeight = maxItems * (itemCardHeight + itemCardGap) + 16;
  const footerHeight = 44;

  const width = 1280;
  const height = 24 + headerBannerHeight + 16 + dayHeaderHeight + 10 + contentHeight + footerHeight;

  const weekNum = getWeekNumber(now);
  const weekRangeTitle = `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 – ${sunday.getMonth() + 1}月${sunday.getDate()}日 (第${weekNum}周)`;

  // Generate SVG for columns
  let columnsSvg = '';
  const colY = 24 + headerBannerHeight + 16;

  days.forEach((day, idx) => {
    const colX = leftMargin + idx * (columnWidth + columnGap);

    // Day Header
    const headerBg = day.isToday ? 'url(#todayHeaderGrad)' : '#1e293b';
    const headerStroke = day.isToday ? '#60a5fa' : '#334155';
    const headerStrokeW = day.isToday ? 1.5 : 1;
    const weekdayColor = day.isToday ? '#ffffff' : '#f1f5f9';
    const dateColor = day.isToday ? '#bfdbfe' : '#94a3b8';

    columnsSvg += `
      <!-- Column ${idx} Header: ${day.weekdayZh} -->
      <g transform="translate(${colX}, ${colY})">
        <rect width="${columnWidth}" height="${dayHeaderHeight}" rx="12" fill="${headerBg}" stroke="${headerStroke}" stroke-width="${headerStrokeW}"/>
        <text x="14" y="24" fill="${weekdayColor}" font-size="14" font-weight="bold">${day.weekdayZh}</text>
        <text x="14" y="42" fill="${dateColor}" font-size="11" font-weight="500">${day.dateStr} ${day.weekdayEn}</text>
        ${
          day.isToday
            ? `
          <rect x="${columnWidth - 52}" y="12" width="40" height="20" rx="6" fill="#1d4ed8"/>
          <text x="${columnWidth - 32}" y="26" fill="#ffffff" font-size="10" font-weight="bold" text-anchor="middle">今日</text>
        `
            : ''
        }
      </g>
    `;

    // Column items
    const itemsY = colY + dayHeaderHeight + 10;
    if (day.items.length === 0) {
      columnsSvg += `
        <g transform="translate(${colX}, ${itemsY})">
          <rect width="${columnWidth}" height="${Math.min(contentHeight - 16, 120)}" rx="10" fill="#0f172a" opacity="0.4" stroke="#1e293b" stroke-dasharray="4,4"/>
          <text x="${columnWidth / 2}" y="52" fill="#64748b" font-size="11" text-anchor="middle">暂无排程</text>
          <text x="${columnWidth / 2}" y="70" fill="#475569" font-size="9.5" text-anchor="middle">休息 / 自由时间</text>
        </g>
      `;
    } else {
      day.items.forEach((item, itemIdx) => {
        const itemY = itemsY + itemIdx * (itemCardHeight + itemCardGap);
        const titleColor = item.isCompleted ? '#64748b' : '#f8fafc';
        const textDecor = item.isCompleted ? 'text-decoration="line-through"' : '';
        const shortTitle = item.title.length > 11 ? item.title.slice(0, 10) + '…' : item.title;

        columnsSvg += `
          <g transform="translate(${colX}, ${itemY})">
            <!-- Item Card -->
            <rect width="${columnWidth}" height="${itemCardHeight}" rx="10" fill="#1e293b" stroke="#334155" stroke-width="1"/>
            
            <!-- Left accent color line -->
            <rect x="0" y="0" width="4" height="${itemCardHeight}" rx="2" fill="${item.borderColor}"/>
            
            <!-- Time badge -->
            <rect x="8" y="7" width="80" height="18" rx="5" fill="#0f172a"/>
            <text x="48" y="19.5" fill="#38bdf8" font-size="9" font-weight="bold" font-family="monospace" text-anchor="middle">${escapeXml(item.timeStr)}</text>
            
            <!-- Category badge -->
            <rect x="92" y="7" width="${columnWidth - 100}" height="18" rx="5" fill="${item.badgeBg}"/>
            <text x="${92 + (columnWidth - 100) / 2}" y="19.5" fill="${item.badgeColor}" font-size="8.5" font-weight="bold" text-anchor="middle">${escapeXml(item.badge)}</text>
            
            <!-- Title -->
            <text x="8" y="42" fill="${titleColor}" font-size="11" font-weight="600" ${textDecor}>${escapeXml(shortTitle)}</text>
            
            <!-- SubText / Duration -->
            <text x="8" y="56" fill="#94a3b8" font-size="9.5">${escapeXml(item.subText)}</text>
          </g>
        `;
      });
    }
  });

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#1e3a8a"/>
          <stop offset="50%" stop-color="#2563eb"/>
          <stop offset="100%" stop-color="#4338ca"/>
        </linearGradient>
        <linearGradient id="todayHeaderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#2563eb"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
        <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#0b0f19"/>
          <stop offset="50%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#020617"/>
        </linearGradient>
      </defs>

      <!-- Main Canvas Background -->
      <rect width="${width}" height="${height}" rx="24" fill="url(#cardGrad)"/>

      <!-- Header Banner -->
      <g transform="translate(${leftMargin}, 24)">
        <rect width="${width - leftMargin * 2}" height="${headerBannerHeight}" rx="18" fill="url(#headerGrad)"/>
        
        <!-- Logo / Title -->
        <text x="24" y="42" fill="#ffffff" font-size="21" font-weight="bold" letter-spacing="0.5">📅 完整周智能日历 (Weekly Schedule)</text>
        <text x="24" y="74" fill="#dbeafe" font-size="14" font-weight="500">${escapeXml(weekRangeTitle)}</text>
        
        <!-- Right stats chips -->
        <g transform="translate(${width - leftMargin * 2 - 470}, 30)">
          <!-- External -->
          <rect x="0" y="0" width="140" height="42" rx="10" fill="#000000" opacity="0.22"/>
          <text x="70" y="26" fill="#e0e7ff" font-size="12" font-weight="bold" text-anchor="middle">外部日程 ${totalExternal} 项</text>
          
          <!-- Scheduled -->
          <rect x="150" y="0" width="140" height="42" rx="10" fill="#000000" opacity="0.22"/>
          <text x="220" y="26" fill="#e0e7ff" font-size="12" font-weight="bold" text-anchor="middle">智能排程 ${totalTasks} 项</text>
          
          <!-- Completed -->
          <rect x="300" y="0" width="140" height="42" rx="10" fill="#000000" opacity="0.22"/>
          <text x="370" y="26" fill="#a7f3d0" font-size="12" font-weight="bold" text-anchor="middle">已完成 ${totalCompleted} 项</text>
        </g>
      </g>

      <!-- 7 Days Columns -->
      ${columnsSvg}

      <!-- Footer Info -->
      <g transform="translate(${leftMargin}, ${height - 24})">
        <text x="8" y="0" fill="#64748b" font-size="11.5">✨ 由 Clawbot 智能排程引擎生成 · 自动同步外部日历并完成全周自适应排布</text>
        <text x="${width - leftMargin * 2 - 8}" y="0" fill="#64748b" font-size="11.5" text-anchor="end">${now.toLocaleString('zh-CN', { hour12: false })} 实时更新</text>
      </g>
    </svg>
  `;

  return renderSvgToPng(svg);
}

/**
 * Compatibility alias: renderCalendarImage defaults to renderWeekCalendarImage
 */
export const renderCalendarImage = renderWeekCalendarImage;

/**
 * 2. Render Google Tasks Style "Todo List" PNG Image
 */
export async function renderTodoListImage(userId: number): Promise<Buffer> {
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
    ORDER BY 
      CASE status 
        WHEN 'in_progress' THEN 1 
        WHEN 'scheduled' THEN 2 
        WHEN 'pending' THEN 3 
        WHEN 'completed' THEN 4 
      END ASC,
      urgency DESC,
      scheduled_start ASC
    LIMIT 12
  `).all(userId) as Task[];

  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length;
  const scheduledCount = tasks.filter((t) => t.status === 'scheduled').length;
  const completedCount = tasks.filter((t) => t.status === 'completed').length;

  const width = 800;
  const itemHeight = 74;
  const headerHeight = 170;
  const footerHeight = 70;
  const totalTasks = Math.max(tasks.length, 1);
  const height = headerHeight + totalTasks * itemHeight + footerHeight;

  let tasksSvg = '';

  if (tasks.length === 0) {
    tasksSvg = `
      <g transform="translate(40, ${headerHeight + 20})">
        <rect width="720" height="90" rx="16" fill="#1e293b" stroke="#334155" stroke-width="1"/>
        <text x="360" y="45" fill="#94a3b8" font-size="16" text-anchor="middle" font-weight="500">待办清单空空如也，真棒！</text>
        <text x="360" y="70" fill="#64748b" font-size="13" text-anchor="middle">发送“帮我安排任务...”可立即规划新任务</text>
      </g>
    `;
  } else {
    tasks.forEach((t, idx) => {
      const y = headerHeight + idx * itemHeight;
      const isCompleted = t.status === 'completed';
      const isInProgress = t.status === 'in_progress';

      // Priority color & badge
      let pColor = '#3b82f6';
      let pLabel = '普通 P3';
      if (t.urgency >= 5 || t.importance >= 5) {
        pColor = '#ef4444';
        pLabel = '紧急 P1';
      } else if (t.urgency >= 4 || t.importance >= 4) {
        pColor = '#f59e0b';
        pLabel = '加急 P2';
      }

      const checkFill = isCompleted ? '#10b981' : '#334155';
      const checkStroke = isCompleted ? '#10b981' : '#64748b';
      const titleColor = isCompleted ? '#64748b' : '#f8fafc';
      const titleDecor = isCompleted ? 'text-decoration="line-through"' : '';

      // Scheduled time or DDL
      let timeText = `耗时 ${t.duration_minutes} 分钟`;
      if (t.scheduled_start && t.scheduled_end) {
        const sTime = new Date(t.scheduled_start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const eTime = new Date(t.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        timeText += ` · 安排: ${sTime}-${eTime}`;
      }
      if (t.deadline) {
        const dDate = new Date(t.deadline);
        timeText += ` · 截止: ${dDate.getMonth() + 1}/${dDate.getDate()} ${dDate.getHours()}:${String(dDate.getMinutes()).padStart(2, '0')}`;
      }

      tasksSvg += `
        <g transform="translate(40, ${y})">
          <!-- Card background -->
          <rect width="720" height="62" rx="14" fill="${isInProgress ? '#1e293b' : '#172033'}" stroke="${isInProgress ? '#3b82f6' : '#334155'}" stroke-width="${isInProgress ? 1.5 : 1}"/>
          
          <!-- Checkbox circle -->
          <circle cx="32" cy="31" r="12" fill="${checkFill}" stroke="${checkStroke}" stroke-width="2"/>
          ${isCompleted ? '<path d="M26 31 L30 35 L38 27" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>' : ''}
          
          <!-- Priority pill -->
          <rect x="58" y="19" width="60" height="24" rx="6" fill="${pColor}" opacity="0.2"/>
          <text x="88" y="36" fill="${pColor}" font-size="11" font-weight="bold" text-anchor="middle">${pLabel}</text>
          
          <!-- Title -->
          <text x="130" y="33" fill="${titleColor}" font-size="15" font-weight="600" ${titleDecor}>${escapeXml(t.title.length > 25 ? t.title.slice(0, 25) + '...' : t.title)}</text>
          
          <!-- Meta details -->
          <text x="130" y="50" fill="#94a3b8" font-size="11">${escapeXml(timeText)}</text>
          
          <!-- Right status tag -->
          <text x="700" y="36" fill="${isInProgress ? '#60a5fa' : isCompleted ? '#10b981' : '#94a3b8'}" font-size="12" font-weight="500" text-anchor="end">
            ${isInProgress ? '⚡ 进行中' : isCompleted ? '✅ 已打勾' : '🕒 已规划'}
          </text>
        </g>
      `;
    });
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="todoHeaderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0284c7"/>
          <stop offset="50%" stop-color="#0ea5e9"/>
          <stop offset="100%" stop-color="#38bdf8"/>
        </linearGradient>
        <linearGradient id="todoBgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#090d16"/>
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="${width}" height="${height}" rx="24" fill="url(#todoBgGrad)"/>

      <!-- Header -->
      <g transform="translate(40, 30)">
        <rect width="720" height="110" rx="20" fill="url(#todoHeaderGrad)"/>
        <text x="30" y="45" fill="#ffffff" font-size="22" font-weight="bold">📝 待办任务清单 (Todo List)</text>
        <text x="30" y="80" fill="#f0f9ff" font-size="15" font-weight="500">进行中 ${inProgressCount} · 已规划 ${scheduledCount} · 已完成 ${completedCount}</text>
        
        <rect x="520" y="35" width="170" height="40" rx="12" fill="#ffffff" opacity="0.2"/>
        <text x="605" y="60" fill="#ffffff" font-size="14" font-weight="bold" text-anchor="middle">共 ${tasks.length} 项任务</text>
      </g>

      <!-- Task items -->
      ${tasksSvg}

      <!-- Footer -->
      <g transform="translate(40, ${height - 40})">
        <text x="20" y="16" fill="#64748b" font-size="12">💡 微信回复“安排任务 [内容]”即刻智能规划 · 回复“完成任务 [名称]”打勾完成</text>
        <text x="700" y="16" fill="#64748b" font-size="12" text-anchor="end">Clawbot Tasks</text>
      </g>
    </svg>
  `;

  return renderSvgToPng(svg);
}
