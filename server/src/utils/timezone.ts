export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

export function isValidTimeZone(tz?: string | null): tz is string {
  if (!tz || typeof tz !== 'string' || !tz.trim()) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveAccountTimezone(tz?: string | null): string {
  return isValidTimeZone(tz) ? tz.trim() : DEFAULT_TIMEZONE;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const getNum = (type: string): number => {
    const val = parts.find(p => p.type === type)?.value || '0';
    return Number(val);
  };
  const hour = getNum('hour');
  return {
    year: getNum('year'),
    month: getNum('month'),
    day: getNum('day'),
    hour: hour === 24 ? 0 : hour,
    minute: getNum('minute'),
    second: getNum('second'),
  };
}

/**
 * Format a Date into YYYY-MM-DD in the account's timezone.
 */
export function getAccountLocalDateKey(date: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  const tz = resolveAccountTimezone(timeZone);
  const p = getZonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Format a Date into HH:mm in the account's timezone.
 */
export function getAccountLocalTimeHm(date: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  const tz = resolveAccountTimezone(timeZone);
  const p = getZonedParts(date, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Convert a wall-clock date+time in a given IANA timezone to a UTC Date.
 * Uses iterative offset resolution so DST / regional offsets are accurate.
 */
export function zonedWallClockToUtc(
  dateKey: string,
  hh: number,
  mm: number,
  ss: number = 0,
  ms: number = 0,
  timeZone: string = DEFAULT_TIMEZONE
): Date {
  const tz = resolveAccountTimezone(timeZone);
  const [y, m, d] = dateKey.split('-').map(Number);
  const targetUtcAsIfLocal = Date.UTC(y, m - 1, d, hh, mm, ss, ms);

  // Estimate offset at targetUtcAsIfLocal, then refine once
  let guess = new Date(targetUtcAsIfLocal);
  for (let i = 0; i < 2; i++) {
    const p = getZonedParts(guess, tz);
    const actualAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, ms);
    const diff = targetUtcAsIfLocal - actualAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

/**
 * Return UTC Date boundaries [start, end] for an account local date YYYY-MM-DD.
 */
export function getAccountDayBoundsUtc(dateKey: string, timeZone: string = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  const start = zonedWallClockToUtc(dateKey, 0, 0, 0, 0, timeZone);
  const end = zonedWallClockToUtc(dateKey, 23, 59, 59, 999, timeZone);
  return { start, end };
}

/**
 * Parse a deadline or timestamp string under the account's timezone:
 * - YYYY-MM-DD -> 23:59:59 in account timezone -> UTC Date
 * - YYYY-MM-DDTHH:mm(:ss)? (no offset) -> interpreted in account timezone -> UTC Date
 * - ISO with Z or ±HH:MM -> parsed directly
 */
export function parseAccountDateOrIso(raw?: string | null, timeZone: string = DEFAULT_TIMEZONE): Date | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tz = resolveAccountTimezone(timeZone);

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return zonedWallClockToUtc(trimmed, 23, 59, 59, 0, tz);
  }

  const localDtMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (localDtMatch) {
    const [, datePart, hStr, mStr, sStr] = localDtMatch;
    return zonedWallClockToUtc(datePart, Number(hStr), Number(mStr), Number(sStr || '0'), 0, tz);
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeAccountDeadlineIso(raw?: string | null, timeZone: string = DEFAULT_TIMEZONE): string | null {
  const d = parseAccountDateOrIso(raw, timeZone);
  return d ? d.toISOString() : null;
}

export function addDaysToDateKey(dateKey: string, offsetDays: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function formatInAccountTz(
  isoOrDate: string | Date,
  timeZone: string = DEFAULT_TIMEZONE,
  options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
): string {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { timeZone: resolveAccountTimezone(timeZone), ...options });
}

export function formatTimeInAccountTz(isoOrDate: string | Date, timeZone: string = DEFAULT_TIMEZONE): string {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', {
    timeZone: resolveAccountTimezone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
