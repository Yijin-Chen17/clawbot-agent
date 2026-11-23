import type { LLMExtractionResult } from '../models/types.js';

export function resolveFixedTaskTime(parsed: Partial<LLMExtractionResult>, pending: Partial<LLMExtractionResult> = {}) {
  const start = parsed.fixed_start || pending.fixed_start || null;
  const end = parsed.fixed_end || pending.fixed_end || null;
  const duration = Number(parsed.duration_minutes || parsed.estimatedMinutes || pending.duration_minutes || pending.estimatedMinutes || 0);
  const startMs = start ? new Date(start).getTime() : NaN;
  const endMs = end ? new Date(end).getTime() : NaN;
  const fixed = Boolean(parsed.is_fixed || pending.is_fixed || (start && end));
  if (!fixed || !Number.isFinite(startMs)) return { fixed: false, start: null, end: null, duration: duration || null };
  const resolvedEnd = Number.isFinite(endMs) ? endMs : duration > 0 ? startMs + duration * 60000 : NaN;
  if (!Number.isFinite(resolvedEnd) || resolvedEnd <= startMs) return { fixed: true, start, end: null, duration: duration || null };
  return { fixed: true, start, end: new Date(resolvedEnd).toISOString(), duration: Math.round((resolvedEnd - startMs) / 60000) };
}
