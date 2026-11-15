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

interface TimedCalendarSegment {
  id: string;
  kind: 'external' | 'task';
  title: string;
  start: string; // ISO
  end: string;   // ISO
  isCompleted?: boolean;
  color: string;
  bg: string;
  border: string;
  timeColor: string;
  titleColor: string;
  badge: string;
  badgeColor: string;
  durationMinutes: number;
}

interface PositionedSegment {
  item: TimedCalendarSegment;
  column: number;
  columns: number;
}

// Overlap detection and multi-column greedy layout (matching CalendarView.tsx)
function layoutDaySegments(items: TimedCalendarSegment[]): PositionedSegment[] {
  const sorted = [...items].sort(
    (a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime() ||
      new Date(a.end).getTime() - new Date(b.end).getTime()
  );

  const result: PositionedSegment[] = [];
  let cluster: TimedCalendarSegment[] = [];
  let clusterEnd = 0;

  const flush = () => {
    if (cluster.length === 0) return;
    const columnEnds: number[] = [];
    const placed: Array<{ item: TimedCalendarSegment; column: number }> = [];

    for (const item of cluster) {
      const start = new Date(item.start).getTime();
      const end = new Date(item.end).getTime();
      let col = columnEnds.findIndex((val) => val <= start);
      if (col === -1) {
        col = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[col] = end;
      }
      placed.push({ item, column: col });
    }

    const columns = Math.max(1, columnEnds.length);
    for (const entry of placed) {
      result.push({ ...entry, columns });
    }
    cluster = [];
    clusterEnd = 0;
  };

  for (const item of sorted) {
    const start = new Date(item.start).getTime();
    const end = new Date(item.end).getTime();
    if (cluster.length > 0 && start >= clusterEnd) {
      flush();
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return result;
}

function segmentRange(
  start: string,
  end: string,
  dayStart: string,
  dayEnd: string
): { start: string; end: string } | null {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const ds = new Date(dayStart).getTime();
  const de = new Date(dayEnd).getTime();
  if (s >= de || e <= ds) return null;
  return {
    start: new Date(Math.max(s, ds)).toISOString(),
    end: new Date(Math.min(e, de)).toISOString(),
  };
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 1. Render modern "Full Week Schedule & Calendar" (完整周日历) Light-Mode PNG Image
 * Matching Web UI CalendarView.tsx 24-Hour Time Grid
 */
export async function renderWeekCalendarImage(userId: number): Promise<Buffer> {
  const now = new Date();
  const monday = getMondayOfWeek(now);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999);

  // Calendar starts at 07:00 of Monday, goes to 07:00 of next Monday (24h daily grid starting at 07:00)
  const CALENDAR_START_HOUR = 7;
  const CALENDAR_END_HOUR = 24;
  const REST_END_HOUR = 7;
  const GRID_HOURS = CALENDAR_END_HOUR - CALENDAR_START_HOUR + REST_END_HOUR; // 24 hours
  const HOUR_HEIGHT = 40; // Pixels per hour

  const searchStartIso = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0).toISOString();
  const searchEndIso = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 23, 59, 59, 999).toISOString();

  // 1. Fetch external events
  const externalEvents = db.prepare(`
    SELECT title, start_time, end_time, is_all_day, subscription_id
    FROM external_events
    WHERE user_id = ? AND end_time >= ? AND start_time <= ?
    ORDER BY start_time ASC
  `).all(userId, searchStartIso, searchEndIso) as {
    title: string;
    start_time: string;
    end_time: string;
    is_all_day: number;
    subscription_id?: number | null;
  }[];

  // 2. Fetch tasks
  const scheduledTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
      AND scheduled_end >= ?
      AND scheduled_start <= ?
    ORDER BY scheduled_start ASC
  `).all(userId, searchStartIso, searchEndIso) as Task[];

  const weekdaysZh = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekdaysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  interface DayScheduleData {
    index: number;
    date: Date;
    dayDateStr: string;
    weekdayZh: string;
    weekdayEn: string;
    isToday: boolean;
    windowStart: Date;
    windowEnd: Date;
    windowStartMs: number;
    allDay: Array<{ id: string; title: string; color: string; bg: string; text: string }>;
    timed: PositionedSegment[];
  }

  const days: DayScheduleData[] = [];
  let totalExternal = 0;
  let totalTasks = 0;
  let totalCompleted = 0;
  let hasAnyAllDay = false;

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const windowStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), CALENDAR_START_HOUR, 0, 0, 0);
    const windowEnd = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1, CALENDAR_START_HOUR, 0, 0, 0);
    const isToday =
      now.getFullYear() === dayDate.getFullYear() &&
      now.getMonth() === dayDate.getMonth() &&
      now.getDate() === dayDate.getDate();

    const wStartIso = windowStart.toISOString();
    const wEndIso = windowEnd.toISOString();

    const dayAllDay: DayScheduleData['allDay'] = [];
    const dayTimed: TimedCalendarSegment[] = [];

    // Process External Events for this day
    for (const ev of externalEvents) {
      if (ev.is_all_day) {
        const evStart = new Date(ev.start_time).getTime();
        const evEnd = new Date(ev.end_time).getTime();
        const dStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0, 0).getTime();
        const dEnd = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 23, 59, 59).getTime();

        if (evEnd >= dStart && evStart <= dEnd) {
          dayAllDay.push({
            id: `ext-allday-${ev.title}-${i}`,
            title: ev.title,
            color: '#0284c7',
            bg: '#e0f2fe',
            text: '#0369a1',
          });
          hasAnyAllDay = true;
          if (i === 0) totalExternal++;
        }
      } else {
        const range = segmentRange(ev.start_time, ev.end_time, wStartIso, wEndIso);
        if (range) {
          totalExternal++;
          const dur = Math.max(15, (new Date(range.end).getTime() - new Date(range.start).getTime()) / 60000);
          dayTimed.push({
            id: `ext-${ev.title}-${range.start}`,
            kind: 'external',
            title: ev.title,
            start: range.start,
            end: range.end,
            durationMinutes: dur,
            color: '#0284c7',
            bg: '#f0f9ff',
            border: '#bae6fd',
            timeColor: '#0369a1',
            titleColor: '#0c4a6e',
            badge: '外部日程',
            badgeColor: '#0284c7',
          });
        }
      }
    }

    // Process Scheduled Tasks for this day
    for (const t of scheduledTasks) {
      let blocks: { start: string; end: string; partIndex?: number; totalParts?: number }[] = [];
      if (t.schedule_blocks) {
        try {
          blocks = typeof t.schedule_blocks === 'string' ? JSON.parse(t.schedule_blocks) : t.schedule_blocks;
        } catch {}
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        if (t.scheduled_start && t.scheduled_end) {
          blocks = [{ start: t.scheduled_start, end: t.scheduled_end }];
        }
      }

      const isCompleted = t.status === 'completed';
      if (isCompleted && i === 0) totalCompleted++;

      blocks.forEach((b, bIdx) => {
        const range = segmentRange(b.start, b.end, wStartIso, wEndIso);
        if (range) {
          totalTasks++;
          const dur = Math.max(15, (new Date(range.end).getTime() - new Date(range.start).getTime()) / 60000);
          const partSuffix = b.totalParts && b.totalParts > 1 ? ` (${b.partIndex || bIdx + 1}/${b.totalParts})` : '';

          // Quadrant coloring matching Web UI CalendarView
          let color = '#3b82f6';
          let bg = '#eff6ff';
          let border = '#bfdbfe';
          let timeColor = '#1d4ed8';
          let titleColor = '#1e3a8a';
          let badge = 'Schedule';
          let badgeColor = '#3b82f6';

          if (isCompleted) {
            color = '#10b981';
            bg = '#ecfdf5';
            border = '#a7f3d0';
            timeColor = '#047857';
            titleColor = '#065f46';
            badge = '已完成';
            badgeColor = '#10b981';
          } else {
            const imp = (t.importance ?? 5) >= 5;
            const urg = (t.urgency ?? 5) >= 5;
            if (imp && urg) {
              color = '#ef4444';
              bg = '#fef2f2';
              border = '#fecaca';
              timeColor = '#b91c1c';
              titleColor = '#7f1d1d';
              badge = 'Do First';
              badgeColor = '#ef4444';
            } else if (imp && !urg) {
              color = '#3b82f6';
              bg = '#eff6ff';
              border = '#bfdbfe';
              timeColor = '#1d4ed8';
              titleColor = '#1e3a8a';
              badge = 'Schedule';
              badgeColor = '#3b82f6';
            } else if (!imp && urg) {
              color = '#f59e0b';
              bg = '#fffbeb';
              border = '#fde68a';
              timeColor = '#b45309';
              titleColor = '#78350f';
              badge = 'Delegate';
              badgeColor = '#f59e0b';
            } else {
              color = '#9ca3af';
              bg = '#f9fafb';
              border = '#e5e7eb';
              timeColor = '#4b5563';
              titleColor = '#1f2937';
              badge = 'Eliminate';
              badgeColor = '#9ca3af';
            }
          }

          dayTimed.push({
            id: `task-${t.id}-${bIdx}-${range.start}`,
            kind: 'task',
            title: `${t.title}${partSuffix}`,
            start: range.start,
            end: range.end,
            isCompleted,
            durationMinutes: dur,
            color,
            bg,
            border,
            timeColor,
            titleColor,
            badge,
            badgeColor,
          });
        }
      });
    }

    days.push({
      index: i,
      date: dayDate,
      dayDateStr: `${dayDate.getMonth() + 1}/${dayDate.getDate()}`,
      weekdayZh: weekdaysZh[i],
      weekdayEn: weekdaysEn[i],
      isToday,
      windowStart,
      windowEnd,
      windowStartMs: windowStart.getTime(),
      allDay: dayAllDay,
      timed: layoutDaySegments(dayTimed),
    });
  }

  // Dimension calculations
  const width = 1280;
  const paddingX = 24;
  const paddingY = 20;
  const containerW = width - paddingX * 2; // 1232px
  const timeAxisW = 54;
  const dayColW = Math.floor((containerW - timeAxisW) / 7); // 168px
  const gridW = timeAxisW + dayColW * 7; // 1230px
  const gridLeft = paddingX + (containerW - gridW) / 2; // centered inside container

  const headerH = 72;
  const dayHeaderH = 48;
  const allDayH = hasAnyAllDay ? 32 : 0;
  const gridH = GRID_HOURS * HOUR_HEIGHT; // 24 * 40 = 960px
  const restTopY = (CALENDAR_END_HOUR - CALENDAR_START_HOUR) * HOUR_HEIGHT; // 17 * 40 = 680px
  const restH = REST_END_HOUR * HOUR_HEIGHT; // 7 * 40 = 280px
  const footerH = 44;

  const height = paddingY * 2 + headerH + dayHeaderH + allDayH + gridH + footerH;

  const weekNum = getWeekNumber(now);
  const weekRangeTitle = `${monday.getFullYear()}年${monday.getMonth() + 1}月${monday.getDate()}日 – ${sunday.getMonth() + 1}月${sunday.getDate()}日 (第${weekNum}周)`;

  // Generate SVG parts
  let dayHeadersSvg = '';
  let allDaySvg = '';
  let dayColumnsSvg = '';
  let clipPathsSvg = '';

  const dayHeaderY = paddingY + headerH;
  const allDayY = dayHeaderY + dayHeaderH;
  const gridTopY = allDayY + allDayH;

  // 1. Time axis column headers & background
  dayHeadersSvg += `
    <!-- Top-left corner time axis header -->
    <rect x="${gridLeft}" y="${dayHeaderY}" width="${timeAxisW}" height="${dayHeaderH}" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1"/>
    <text x="${gridLeft + timeAxisW / 2}" y="${dayHeaderY + 28}" text-anchor="middle" font-size="11" font-weight="bold" fill="#64748b">时段</text>
  `;

  if (hasAnyAllDay) {
    allDaySvg += `
      <!-- All day row header -->
      <rect x="${gridLeft}" y="${allDayY}" width="${timeAxisW}" height="${allDayH}" fill="#f1f5f9" stroke="#e2e8f0" stroke-width="1"/>
      <text x="${gridLeft + timeAxisW / 2}" y="${allDayY + 20}" text-anchor="middle" font-size="10" font-weight="bold" fill="#64748b">全天</text>
    `;
  }

  // 2. 7 Days columns headers and grids
  days.forEach((d) => {
    const colX = gridLeft + timeAxisW + d.index * dayColW;

    // Day Header
    const headerBg = d.isToday ? '#eff6ff' : '#ffffff';
    const headerBorder = d.isToday ? '#93c5fd' : '#e2e8f0';
    const weekdayFill = d.isToday ? '#2563eb' : '#64748b';
    const dateFill = d.isToday ? '#1d4ed8' : '#0f172a';

    dayHeadersSvg += `
      <g transform="translate(${colX}, ${dayHeaderY})">
        <rect width="${dayColW}" height="${dayHeaderH}" fill="${headerBg}" stroke="${headerBorder}" stroke-width="${d.isToday ? 1.5 : 1}"/>
        <text x="${dayColW / 2}" y="20" text-anchor="middle" font-size="11.5" font-weight="bold" fill="${weekdayFill}">
          ${d.weekdayZh} ${d.isToday ? '· 今日' : ''}
        </text>
        <text x="${dayColW / 2}" y="38" text-anchor="middle" font-size="13" font-weight="bold" font-family="monospace" fill="${dateFill}">
          ${d.dayDateStr}
        </text>
      </g>
    `;

    // All Day Row for this day
    if (hasAnyAllDay) {
      allDaySvg += `
        <rect x="${colX}" y="${allDayY}" width="${dayColW}" height="${allDayH}" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
      `;
      if (d.allDay.length > 0) {
        d.allDay.forEach((ad, adIdx) => {
          const pillW = dayColW - 8;
          const pillX = colX + 4;
          const pillY = allDayY + 4 + adIdx * 24;
          allDaySvg += `
            <rect x="${pillX}" y="${pillY}" width="${pillW}" height="22" rx="4" fill="${ad.bg}" stroke="${ad.color}" stroke-width="1"/>
            <text x="${pillX + 6}" y="${pillY + 15}" font-size="10" font-weight="bold" fill="${ad.text}">
              ${escapeXml(ad.title.length > 11 ? ad.title.slice(0, 10) + '…' : ad.title)}
            </text>
          `;
        });
      }
    }

    // Day Column Grid Body
    let itemsSvg = '';
    d.timed.forEach((pos, itemIdx) => {
      const seg = pos.item;
      const minutesIntoGrid = Math.max(0, (new Date(seg.start).getTime() - d.windowStartMs) / 60000);
      const durMinutes = seg.durationMinutes;

      const top = gridTopY + (minutesIntoGrid / 60) * HOUR_HEIGHT;
      const height = Math.max(22, (durMinutes / 60) * HOUR_HEIGHT);
      const colWidth = (dayColW - 6) / pos.columns;
      const left = colX + 3 + pos.column * colWidth;
      const cardW = colWidth - 2;

      const clipId = `clip-${d.index}-${itemIdx}`;
      clipPathsSvg += `
        <clipPath id="${clipId}">
          <rect x="${left}" y="${top}" width="${cardW}" height="${height}" rx="5"/>
        </clipPath>
      `;

      const timeRange = `${formatTime(seg.start)} - ${formatTime(seg.end)}`;
      const shortTitle = seg.title.length > 12 ? seg.title.slice(0, 11) + '…' : seg.title;

      itemsSvg += `
        <!-- Card: ${escapeXml(seg.title)} -->
        <g clip-path="url(#${clipId})">
          <rect x="${left}" y="${top}" width="${cardW}" height="${height}" rx="5" fill="${seg.bg}" stroke="${seg.border}" stroke-width="1"/>
          <!-- Left accent line -->
          <rect x="${left}" y="${top}" width="3.5" height="${height}" rx="1.5" fill="${seg.color}"/>
          
          <!-- Content -->
          ${
            height < 34
              ? `
            <text x="${left + 7}" y="${top + 14}" font-size="9" font-family="monospace" font-weight="bold" fill="${seg.timeColor}">${formatTime(seg.start)}</text>
            <text x="${left + 38}" y="${top + 14}" font-size="10" font-weight="bold" fill="${seg.titleColor}">${escapeXml(shortTitle)}</text>
          `
              : height < 50
              ? `
            <text x="${left + 7}" y="${top + 13}" font-size="8.5" font-family="monospace" font-weight="bold" fill="${seg.timeColor}">${timeRange}</text>
            <text x="${left + 7}" y="${top + 28}" font-size="10.5" font-weight="bold" fill="${seg.titleColor}">${escapeXml(shortTitle)}</text>
          `
              : `
            <text x="${left + 7}" y="${top + 13}" font-size="8.5" font-family="monospace" font-weight="bold" fill="${seg.timeColor}">${timeRange}</text>
            <text x="${left + 7}" y="${top + 28}" font-size="10.5" font-weight="bold" fill="${seg.titleColor}">${escapeXml(shortTitle)}</text>
            <rect x="${left + 7}" y="${top + 34}" width="54" height="15" rx="3" fill="#ffffff" fill-opacity="0.8"/>
            <text x="${left + 10}" y="${top + 45}" font-size="8.5" font-weight="bold" fill="${seg.badgeColor}">${escapeXml(seg.badge)}</text>
          `
          }
        </g>
      `;
    });

    // Today current time indicator
    let todayLineSvg = '';
    if (d.isToday) {
      const currentMinutes = ((now.getHours() - CALENDAR_START_HOUR + 24) % 24) * 60 + now.getMinutes();
      const currentY = gridTopY + (currentMinutes / 60) * HOUR_HEIGHT;
      if (currentY >= gridTopY && currentY <= gridTopY + gridH) {
        todayLineSvg = `
          <!-- Current Time Line -->
          <line x1="${colX}" y1="${currentY}" x2="${colX + dayColW}" y2="${currentY}" stroke="#ef4444" stroke-width="2"/>
          <circle cx="${colX + 4}" cy="${currentY}" r="3.5" fill="#ef4444"/>
        `;
      }
    }

    dayColumnsSvg += `
      <!-- Column: ${d.weekdayZh} -->
      <g>
        <!-- Column Background -->
        <rect x="${colX}" y="${gridTopY}" width="${dayColW}" height="${gridH}" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
        
        <!-- Rest Band (00:00 - 07:00) -->
        <rect x="${colX}" y="${gridTopY + restTopY}" width="${dayColW}" height="${restH}" fill="url(#restHatch)"/>
        
        <!-- Hourly divider lines -->
        ${Array.from({ length: GRID_HOURS }, (_, hIdx) => {
          const lineY = gridTopY + hIdx * HOUR_HEIGHT;
          const isRestLine = hIdx === (CALENDAR_END_HOUR - CALENDAR_START_HOUR);
          return `<line x1="${colX}" y1="${lineY}" x2="${colX + dayColW}" y2="${lineY}" stroke="${isRestLine ? '#cbd5e1' : '#f1f5f9'}" stroke-width="${isRestLine ? 1.5 : 1}" ${isRestLine ? 'stroke-dasharray="4,3"' : ''}/>`;
        }).join('')}
        
        <!-- Cards -->
        ${itemsSvg}
        
        <!-- Today Line -->
        ${todayLineSvg}
      </g>
    `;
  });

  // 3. Time Axis labels
  let timeAxisSvg = '';
  // Daytime hours 07:00 to 24:00
  for (let h = CALENDAR_START_HOUR; h <= CALENDAR_END_HOUR; h++) {
    const y = gridTopY + (h - CALENDAR_START_HOUR) * HOUR_HEIGHT;
    const isEnd = h === CALENDAR_END_HOUR;
    timeAxisSvg += `
      <text x="${gridLeft + timeAxisW - 8}" y="${y + 4}" text-anchor="end" font-size="10" font-family="monospace" font-weight="${isEnd ? 'bold' : 'normal'}" fill="${isEnd ? '#334155' : '#94a3b8'}">
        ${formatHour(h)}
      </text>
    `;
  }
  // Rest hours 01:00 to 06:00
  for (let h = 1; h < REST_END_HOUR; h++) {
    const y = gridTopY + restTopY + h * HOUR_HEIGHT;
    timeAxisSvg += `
      <text x="${gridLeft + timeAxisW - 8}" y="${y + 4}" text-anchor="end" font-size="9" font-family="monospace" fill="#cbd5e1">
        ${formatHour(h)}
      </text>
    `;
  }

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Rest hours diagonal pattern -->
        <pattern id="restHatch" width="10" height="10" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="10" stroke="#e2e8f0" stroke-width="1.2" opacity="0.6"/>
        </pattern>
        ${clipPathsSvg}
      </defs>

      <!-- Overall Canvas Background -->
      <rect width="${width}" height="${height}" fill="#f8fafc"/>

      <!-- Main Card Container (White) -->
      <rect x="${paddingX}" y="${paddingY}" width="${containerW}" height="${height - paddingY * 2}" rx="16" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.5"/>

      <!-- Top Toolbar -->
      <g transform="translate(${gridLeft}, ${paddingY + 14})">
        <!-- Calendar Icon & Title -->
        <rect x="0" y="2" width="36" height="36" rx="10" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1"/>
        <text x="18" y="25" text-anchor="middle" font-size="18">📅</text>
        
        <text x="46" y="20" font-size="17" font-weight="bold" fill="#0f172a">日历日程 · 智能周排程</text>
        <text x="46" y="38" font-size="12.5" font-weight="500" fill="#64748b">${escapeXml(weekRangeTitle)}</text>

        <!-- Right Stats Chips -->
        <g transform="translate(${gridW - 410}, 4)">
          <!-- External chip -->
          <rect x="0" y="0" width="126" height="32" rx="8" fill="#f0f9ff" stroke="#bae6fd" stroke-width="1"/>
          <circle cx="16" cy="16" r="4" fill="#0284c7"/>
          <text x="26" y="20" font-size="11" font-weight="bold" fill="#0369a1">外部日程 ${totalExternal}</text>

          <!-- Tasks chip -->
          <rect x="136" y="0" width="126" height="32" rx="8" fill="#eff6ff" stroke="#bfdbfe" stroke-width="1"/>
          <circle cx="152" cy="16" r="4" fill="#3b82f6"/>
          <text x="162" y="20" font-size="11" font-weight="bold" fill="#1d4ed8">智能排程 ${totalTasks}</text>

          <!-- Completed chip -->
          <rect x="272" y="0" width="126" height="32" rx="8" fill="#ecfdf5" stroke="#a7f3d0" stroke-width="1"/>
          <circle cx="288" cy="16" r="4" fill="#10b981"/>
          <text x="298" y="20" font-size="11" font-weight="bold" fill="#047857">已完成 ${totalCompleted}</text>
        </g>
      </g>

      <!-- Day Headers Row -->
      ${dayHeadersSvg}

      <!-- All-Day Row (if any) -->
      ${allDaySvg}

      <!-- Time Axis Background & Labels -->
      <g>
        <rect x="${gridLeft}" y="${gridTopY}" width="${timeAxisW}" height="${gridH}" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>
        ${timeAxisSvg}
      </g>

      <!-- 7 Days Grid Columns -->
      ${dayColumnsSvg}

      <!-- Rest Zone Label at bottom right -->
      <text x="${gridLeft + timeAxisW + 10}" y="${gridTopY + restTopY + 16}" font-size="9.5" font-weight="bold" fill="#94a3b8">
        🌙 夜间休息时段 (00:00 - 07:00)
      </text>

      <!-- Footer Bar -->
      <g transform="translate(${gridLeft}, ${gridTopY + gridH + 26})">
        <text x="4" y="0" font-size="10.5" fill="#94a3b8">
          ✨ Clawbot 智能排程引擎 · 亮色日程视图 · 24小时自适应时间网格
        </text>
        <text x="${gridW - 4}" y="0" text-anchor="end" font-size="10.5" font-family="monospace" fill="#94a3b8">
          ${now.toLocaleDateString('zh-CN')} ${now.toLocaleTimeString('zh-CN', { hour12: false })} 生成
        </text>
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
