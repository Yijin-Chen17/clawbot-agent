import React, { useState, useMemo } from 'react';
import { useTheme } from '../context/ThemeContext';
import { TrendingUp, Calendar, Zap, DollarSign } from 'lucide-react';

export interface DailyHistoryPoint {
  label: string;
  date: string;
  cost_cny: number;
  tokens: number;
  requests: number;
}

interface CostCurveChartProps {
  data?: {
    '1d': DailyHistoryPoint[];
    '7d': DailyHistoryPoint[];
    '30d': DailyHistoryPoint[];
  };
  loading?: boolean;
}

export const CostCurveChart: React.FC<CostCurveChartProps> = ({ data, loading }) => {
  const { t } = useTheme();
  const [range, setRange] = useState<'1d' | '7d' | '30d'>('7d');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const points: DailyHistoryPoint[] = useMemo(() => {
    if (!data || !data[range]) return [];
    return data[range];
  }, [data, range]);

  // 计算所选范围内的统计数据
  const stats = useMemo(() => {
    const totalCost = points.reduce((acc, p) => acc + (p.cost_cny || 0), 0);
    const totalTokens = points.reduce((acc, p) => acc + (p.tokens || 0), 0);
    const totalRequests = points.reduce((acc, p) => acc + (p.requests || 0), 0);
    const maxCost = Math.max(...points.map((p) => p.cost_cny || 0), 0);
    return { totalCost, totalTokens, totalRequests, maxCost };
  }, [points]);

  // SVG 绘图坐标计算 (viewBox 0 0 640 180)
  const chartWidth = 640;
  const chartHeight = 180;
  const padding = { top: 20, right: 30, bottom: 35, left: 55 };
  const graphWidth = chartWidth - padding.left - padding.right;
  const graphHeight = chartHeight - padding.top - padding.bottom;

  // Y轴最大值向上取整适度预留
  const yMax = useMemo(() => {
    if (stats.maxCost <= 0) return 0.01;
    // 放大 15% 留出顶部余量
    const raw = stats.maxCost * 1.15;
    return raw < 0.001 ? 0.001 : Number(raw.toFixed(4));
  }, [stats.maxCost]);

  // 映射各点到 SVG 坐标
  const coordinates = useMemo(() => {
    if (points.length === 0) return [];
    const step = points.length > 1 ? graphWidth / (points.length - 1) : graphWidth / 2;
    return points.map((p, idx) => {
      const x = padding.left + (points.length > 1 ? idx * step : graphWidth / 2);
      const ratio = Math.min(1, Math.max(0, p.cost_cny / yMax));
      const y = padding.top + graphHeight - ratio * graphHeight;
      return { x, y, point: p, index: idx };
    });
  }, [points, graphWidth, graphHeight, padding.left, padding.top, yMax]);

  // 生成平滑贝塞尔曲线或折线路径
  const { linePath, areaPath } = useMemo(() => {
    if (coordinates.length === 0) return { linePath: '', areaPath: '' };

    if (coordinates.length === 1) {
      const pt = coordinates[0];
      const line = `M ${pt.x - 20} ${pt.y} L ${pt.x + 20} ${pt.y}`;
      const area = `M ${pt.x - 20} ${padding.top + graphHeight} L ${pt.x - 20} ${pt.y} L ${pt.x + 20} ${pt.y} L ${pt.x + 20} ${padding.top + graphHeight} Z`;
      return { linePath: line, areaPath: area };
    }

    // 平滑三次贝塞尔曲线
    let d = `M ${coordinates[0].x} ${coordinates[0].y}`;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const curr = coordinates[i];
      const next = coordinates[i + 1];
      const cpX = (curr.x + next.x) / 2;
      d += ` C ${cpX} ${curr.y}, ${cpX} ${next.y}, ${next.x} ${next.y}`;
    }

    const baselineY = padding.top + graphHeight;
    const area = `${d} L ${coordinates[coordinates.length - 1].x} ${baselineY} L ${coordinates[0].x} ${baselineY} Z`;
    return { linePath: d, areaPath: area };
  }, [coordinates, padding.top, graphHeight]);

  // X 轴标签抽样 (避免 30 天密集遮挡)
  const xLabels = useMemo(() => {
    if (coordinates.length === 0) return [];
    if (range === '1d') {
      // 24小时：每隔 3 小时显示一个
      return coordinates.filter((_, idx) => idx % 3 === 0 || idx === coordinates.length - 1);
    }
    if (range === '7d') {
      // 7天：全部显示
      return coordinates;
    }
    // 30天：每隔 5 天显示一个
    return coordinates.filter((_, idx) => idx % 5 === 0 || idx === coordinates.length - 1);
  }, [coordinates, range]);

  const activePoint = hoverIndex !== null && coordinates[hoverIndex] ? coordinates[hoverIndex] : null;

  // Tooltip 智能防遮挡动态定位计算 (根据点在视口内的位置自适应翻转和位移)
  const tooltipStyle = useMemo(() => {
    if (!activePoint) return null;

    const xPct = (activePoint.x / chartWidth) * 100;
    const yPct = (activePoint.y / chartHeight) * 100;

    // 横向：若在最左侧 (< 24%) 向右展开；若在最右侧 (> 76%) 向左展开；否则水平居中
    let translateX = '-50%';
    if (xPct < 24) translateX = '0%';
    else if (xPct > 76) translateX = '-100%';

    // 纵向：若靠近顶部 (< 45%)，提示框显示在节点下方，避免被上层卡片外部遮挡；否则显示在节点上方
    const isNearTop = yPct < 45;
    const translateY = isNearTop ? '12px' : 'calc(-100% - 12px)';

    return {
      left: `${xPct}%`,
      top: `${yPct}%`,
      transform: `translate(${translateX}, ${translateY})`,
    };
  }, [activePoint, chartWidth, chartHeight]);

  return (
    <div className="rounded-2xl border border-gray-200/90 dark:border-neutral-800 bg-white dark:bg-[#1e1f20] p-4 sm:p-5 shadow-2xs space-y-4">
      {/* 顶栏：图表标题与范围快速切换胶囊 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
              <span>{t('llm.curve_title')}</span>
            </h4>
          </div>
        </div>

        {/* 1天 / 7天 / 30天 切换器 */}
        <div className="flex items-center p-0.5 rounded-xl bg-gray-100 dark:bg-neutral-800 text-xs font-medium self-start sm:self-auto border border-gray-200/50 dark:border-neutral-700/60">
          <button
            type="button"
            onClick={() => {
              setRange('1d');
              setHoverIndex(null);
            }}
            className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
              range === '1d'
                ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-bold shadow-2xs'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
            }`}
          >
            {t('llm.range_1d')}
          </button>
          <button
            type="button"
            onClick={() => {
              setRange('7d');
              setHoverIndex(null);
            }}
            className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
              range === '7d'
                ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-bold shadow-2xs'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
            }`}
          >
            {t('llm.range_7d')}
          </button>
          <button
            type="button"
            onClick={() => {
              setRange('30d');
              setHoverIndex(null);
            }}
            className={`px-3 py-1 rounded-lg transition-all cursor-pointer ${
              range === '30d'
                ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-bold shadow-2xs'
                : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
            }`}
          >
            {t('llm.range_30d')}
          </button>
        </div>
      </div>

      {/* 选定周期概览摘要 */}
      <div className="grid grid-cols-3 gap-3 p-3 rounded-xl bg-gray-50/70 dark:bg-neutral-800/40 border border-gray-100 dark:border-neutral-800/80">
        <div>
          <span className="text-[11px] text-gray-500 dark:text-neutral-400 flex items-center gap-1">
            <DollarSign className="w-3 h-3 text-emerald-500" />
            <span>{t('llm.period_total')}</span>
          </span>
          <div className="text-base font-bold font-mono text-gray-900 dark:text-gray-100 mt-0.5">
            ¥{stats.totalCost.toFixed(4)}
          </div>
        </div>
        <div>
          <span className="text-[11px] text-gray-500 dark:text-neutral-400 flex items-center gap-1">
            <Zap className="w-3 h-3 text-blue-500" />
            <span>{t('llm.total_tokens')}</span>
          </span>
          <div className="text-base font-bold font-mono text-blue-600 dark:text-blue-400 mt-0.5">
            {stats.totalTokens.toLocaleString()}
          </div>
        </div>
        <div>
          <span className="text-[11px] text-gray-500 dark:text-neutral-400 flex items-center gap-1">
            <Calendar className="w-3 h-3 text-purple-500" />
            <span>{t('llm.total_requests')}</span>
          </span>
          <div className="text-base font-bold font-mono text-purple-600 dark:text-purple-400 mt-0.5">
            {stats.totalRequests}
          </div>
        </div>
      </div>

      {/* SVG 曲线画布 */}
      <div className="relative w-full overflow-visible select-none">
        {loading ? (
          <div className="h-44 flex items-center justify-center text-xs text-gray-400">
            <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent mr-2" />
            {t('common.loading')}
          </div>
        ) : (
          <div className="relative w-full overflow-visible">
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-44 overflow-visible"
              preserveAspectRatio="none"
              onMouseLeave={() => setHoverIndex(null)}
            >
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.28" />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Y 轴横向网格参考线 (4条) */}
              {[0, 0.33, 0.66, 1].map((ratio) => {
                const y = padding.top + graphHeight * (1 - ratio);
                const value = (yMax * ratio).toFixed(4);
                return (
                  <g key={ratio}>
                    <line
                      x1={padding.left}
                      y1={y}
                      x2={chartWidth - padding.right}
                      y2={y}
                      stroke="currentColor"
                      strokeDasharray="3 3"
                      className="text-gray-200 dark:text-neutral-800"
                      strokeWidth="1"
                    />
                    <text
                      x={padding.left - 6}
                      y={y + 3}
                      textAnchor="end"
                      className="text-[9px] font-mono fill-gray-400 dark:fill-neutral-500"
                    >
                      ¥{value}
                    </text>
                  </g>
                );
              })}

              {/* 垂直参考准线 (Crosshair) */}
              {activePoint && (
                <line
                  x1={activePoint.x}
                  y1={padding.top}
                  x2={activePoint.x}
                  y2={padding.top + graphHeight}
                  stroke="#3b82f6"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                  className="opacity-60 pointer-events-none"
                />
              )}

              {/* 面积填充 */}
              {areaPath && (
                <path d={areaPath} fill="url(#costGradient)" className="transition-all duration-300" />
              )}

              {/* 折线/曲线 */}
              {linePath && (
                <path
                  d={linePath}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="transition-all duration-300 drop-shadow-xs"
                />
              )}

              {/* 数据节点与触控区 */}
              {coordinates.map((pt, idx) => (
                <g key={idx}>
                  {/* 点上的小圆圈 */}
                  <circle
                    cx={pt.x}
                    cy={pt.y}
                    r={hoverIndex === idx ? 5 : pt.point.cost_cny > 0 ? 3 : 2}
                    className={`transition-all duration-150 ${
                      hoverIndex === idx
                        ? 'fill-blue-600 stroke-white dark:stroke-[#1e1f20] stroke-2'
                        : pt.point.cost_cny > 0
                        ? 'fill-blue-500'
                        : 'fill-gray-300 dark:fill-neutral-700'
                    }`}
                  />
                  {/* 扩大鼠标悬停命中检测区域 */}
                  <rect
                    x={pt.x - (graphWidth / coordinates.length) / 2}
                    y={padding.top}
                    width={graphWidth / coordinates.length}
                    height={graphHeight}
                    fill="transparent"
                    className="cursor-pointer"
                    onMouseEnter={() => setHoverIndex(idx)}
                  />
                </g>
              ))}

              {/* X 轴标签 */}
              {xLabels.map((lbl, idx) => (
                <text
                  key={idx}
                  x={lbl.x}
                  y={chartHeight - 10}
                  textAnchor="middle"
                  className="text-[10px] font-mono fill-gray-500 dark:fill-neutral-400"
                >
                  {lbl.point.label}
                </text>
              ))}
            </svg>

            {/* 鼠标悬停时的浮层提示 Tooltip (带防遮挡动态反向锚定) */}
            {activePoint && tooltipStyle && (
              <div
                className="pointer-events-none absolute z-30 px-3 py-2 bg-gray-900/95 dark:bg-neutral-900/95 text-white rounded-xl shadow-xl backdrop-blur-md text-xs font-mono space-y-1 border border-gray-700/80 transition-all duration-75 min-w-[130px] whitespace-nowrap"
                style={tooltipStyle}
              >
                <div className="text-[11px] font-bold text-gray-300 flex items-center justify-between gap-3 border-b border-gray-800 pb-1">
                  <span>{activePoint.point.date || activePoint.point.label}</span>
                  <span className="text-amber-400 font-semibold">{activePoint.point.requests} 次调用</span>
                </div>
                <div className="text-emerald-400 font-bold text-sm">
                  ¥{activePoint.point.cost_cny.toFixed(4)}
                </div>
                <div className="text-[10px] text-gray-400">
                  {activePoint.point.tokens.toLocaleString()} Tokens
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
