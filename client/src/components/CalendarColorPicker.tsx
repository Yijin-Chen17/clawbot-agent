import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../context/ThemeContext';
import { Check, X, RotateCcw, Palette } from 'lucide-react';

export const PRESET_CALENDAR_COLORS = [
  { hex: '#2563EB', key: 'calendar.color_blue', name: '经典蓝' },
  { hex: '#10B981', key: 'calendar.color_green', name: '翡翠绿' },
  { hex: '#F59E0B', key: 'calendar.color_amber', name: '琥珀黄' },
  { hex: '#EF4444', key: 'calendar.color_red', name: '番茄红' },
  { hex: '#8E24AA', key: 'calendar.color_purple', name: '葡萄紫' },
];

interface CalendarColorPickerProps {
  color: string;
  name: string;
  onChange: (color: string) => void;
  onReset?: () => void;
  children?: React.ReactNode;
}

export const CalendarColorPicker: React.FC<CalendarColorPickerProps> = ({
  color,
  name,
  onChange,
  onReset,
  children,
}) => {
  const { t } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [customHex, setCustomHex] = useState(color);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync customHex when color prop changes
  useEffect(() => {
    setCustomHex(color);
  }, [color]);

  // Calculate popover positioning
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const popoverWidth = 220;
      const popoverHeight = onReset ? 240 : 200;

      // Position horizontally: prefer right side of the trigger
      let left = rect.right + 10;
      if (left + popoverWidth > window.innerWidth - 12) {
        // If overflowing right edge, place to the left or align with trigger
        left = Math.max(12, rect.left - popoverWidth - 10);
        if (left < 12) {
          left = Math.max(12, window.innerWidth - popoverWidth - 12);
        }
      }

      // Position vertically: align near the top of trigger, clamped within window
      let top = rect.top - 12;
      if (top + popoverHeight > window.innerHeight - 12) {
        top = Math.max(12, window.innerHeight - popoverHeight - 12);
      }
      if (top < 12) top = 12;

      setPopoverPosition({ top, left });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, onReset]);

  // Click outside and Escape key handler
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectPreset = (hex: string) => {
    onChange(hex);
    setIsOpen(false);
  };

  const handleApplyCustom = (e: React.FormEvent) => {
    e.preventDefault();
    let formatted = customHex.trim();
    if (!formatted.startsWith('#')) formatted = `#${formatted}`;
    if (/^#[0-9a-fA-F]{6}$/.test(formatted)) {
      onChange(formatted);
      setIsOpen(false);
    }
  };

  const popover = isOpen
    ? createPortal(
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            top: `${popoverPosition.top}px`,
            left: `${popoverPosition.left}px`,
            zIndex: 99999,
          }}
          className="w-54 bg-white dark:bg-[#252627] rounded-2xl shadow-2xl border border-gray-200/90 dark:border-neutral-700/80 p-3 space-y-2.5 animate-fadeIn text-xs select-none backdrop-blur-md"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-gray-100 dark:border-neutral-800">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-3.5 h-3.5 rounded-full shrink-0 shadow-2xs ring-1 ring-black/10 dark:ring-white/20"
                style={{ backgroundColor: color }}
              />
              <span className="font-semibold text-gray-800 dark:text-gray-100 truncate text-[11px]" title={name}>
                {name}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-neutral-200 rounded-lg hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Palette Color Grid (5 cols x 4 rows) */}
          <div>
            <div className="text-[10px] font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider mb-2">
              {t('calendar.preset_colors', '预设颜色')}
            </div>
            <div className="grid grid-cols-5 gap-2 justify-items-center">
              {PRESET_CALENDAR_COLORS.map((preset) => {
                const isSelected = preset.hex.toLowerCase() === color.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    onClick={() => handleSelectPreset(preset.hex)}
                    className="w-6.5 h-6.5 rounded-full flex items-center justify-center cursor-pointer transition-all hover:scale-120 hover:shadow-md ring-1 ring-black/5 dark:ring-white/10 relative group"
                    style={{ backgroundColor: preset.hex }}
                    title={t(preset.key, preset.name)}
                  >
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 text-white drop-shadow stroke-[2.5]" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom Color Input */}
          <div className="pt-2 border-t border-gray-100 dark:border-neutral-800 space-y-2">
            <div className="text-[10px] font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider">
              {t('calendar.custom_color', '自定义颜色')}
            </div>
            <form onSubmit={handleApplyCustom} className="flex items-center gap-2">
              <label
                className="w-7 h-7 rounded-lg overflow-hidden shrink-0 cursor-pointer border border-gray-200 dark:border-neutral-700 flex items-center justify-center hover:scale-105 transition shadow-2xs relative"
                style={{ backgroundColor: customHex }}
                title={t('calendar.custom_color', '选择自定义颜色')}
              >
                <input
                  type="color"
                  value={customHex.startsWith('#') && customHex.length === 7 ? customHex : '#3b82f6'}
                  onChange={(e) => setCustomHex(e.target.value)}
                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                />
                <Palette className="w-3.5 h-3.5 text-white/80 drop-shadow pointer-events-none" />
              </label>
              <input
                type="text"
                value={customHex}
                onChange={(e) => setCustomHex(e.target.value)}
                placeholder="#3B82F6"
                maxLength={7}
                className="flex-1 min-w-0 px-2 py-1 bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg text-xs font-mono text-gray-800 dark:text-neutral-200 uppercase focus:outline-hidden focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={!/^#[0-9a-fA-F]{6}$/.test(customHex)}
                className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg text-[11px] font-medium transition cursor-pointer shrink-0"
              >
                {t('calendar.confirm_color', '确定')}
              </button>
            </form>
          </div>

          {/* Reset to Default */}
          {onReset && (
            <div className="pt-2 border-t border-gray-100 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => {
                  onReset();
                  setIsOpen(false);
                }}
                className="w-full flex items-center justify-center gap-1.5 py-1 text-gray-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800/60 rounded-lg transition text-[11px] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{t('calendar.reset_color', '恢复默认颜色')}</span>
              </button>
            </div>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <div
        ref={triggerRef}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className="inline-flex items-center cursor-pointer"
      >
        {children ? (
          children
        ) : (
          <button
            type="button"
            className="w-4.5 h-4.5 rounded-full ring-2 ring-white dark:ring-[#1e1f20] shadow-2xs transition-colors cursor-pointer relative group flex items-center justify-center shrink-0"
            style={{ backgroundColor: color }}
            title={`修改【${name}】颜色`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-white/80 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
          </button>
        )}
      </div>
      {popover}
    </>
  );
};
