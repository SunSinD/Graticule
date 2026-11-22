import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Dict } from '../i18n';

export const ZOOM_MIN = 50;
export const ZOOM_STEP = 10;

interface Props {
  readonly tx: Dict;
  readonly value: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
}

export function clampZoom(value: number, max: number): number {
  return Math.min(max, Math.max(ZOOM_MIN, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
}

export function ZoomControl({ tx, value, max, onChange }: Props) {
  return (
    <div className="zoom" role="group" aria-label={tx.zoom}>
      <button type="button" className="btn chip" disabled={value === 100} onClick={() => onChange(100)}>
        {tx.zoomReset}
      </button>
      <input
        type="range"
        min={ZOOM_MIN}
        max={max}
        step={ZOOM_STEP}
        value={value}
        aria-label={tx.zoom}
        title={tx.zoomHint}
        onChange={(e) => onChange(clampZoom(Number(e.target.value), max))}
      />
      <span className="num small zoom-value">{value}%</span>
    </div>
  );
}

export function useCtrlWheelZoom(
  ref: RefObject<HTMLElement | null>,
  value: number,
  max: number,
  onChange: (value: number) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const next = clampZoom(value + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), max);
      if (next === value) return;
      const rect = el.getBoundingClientRect();
      const fx = (el.scrollLeft + e.clientX - rect.left) / Math.max(1, el.scrollWidth);
      const fy = (el.scrollTop + e.clientY - rect.top) / Math.max(1, el.scrollHeight);
      onChange(next);
      requestAnimationFrame(() => {
        el.scrollLeft = fx * el.scrollWidth - (e.clientX - rect.left);
        el.scrollTop = fy * el.scrollHeight - (e.clientY - rect.top);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, value, max, onChange]);
}

export function svgRatio(svg: string, fallback: number): number {
  const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  if (!m) return fallback;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : fallback;
}
