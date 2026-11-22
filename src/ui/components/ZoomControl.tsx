import { useEffect, useRef } from 'react';
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

function clampSmooth(value: number, max: number): number {
  return Math.min(max, Math.max(ZOOM_MIN, Math.round(value)));
}

export function ZoomControl({ tx, value, max, onChange }: Props) {
  return (
    <div className="zoom" role="group" aria-label={tx.zoom}>
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
      <button
        type="button"
        className="btn chip num zoom-value"
        aria-label={tx.zoomReset}
        title={tx.zoomReset}
        onClick={() => onChange(100)}
      >
        {value}%
      </button>
    </div>
  );
}

function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}

export function useCtrlWheelZoom(
  ref: RefObject<HTMLElement | null>,
  value: number,
  max: number,
  onChange: (value: number) => void,
): void {
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const current = latest.current;
      const delta = Math.max(-240, Math.min(240, wheelPixels(e)));
      const next = clampSmooth(current * Math.exp(-delta * 0.0015), max);
      if (next === current) return;
      const rect = el.getBoundingClientRect();
      const fx = (el.scrollLeft + e.clientX - rect.left) / Math.max(1, el.scrollWidth);
      const fy = (el.scrollTop + e.clientY - rect.top) / Math.max(1, el.scrollHeight);
      latest.current = next;
      onChange(next);
      requestAnimationFrame(() => {
        el.scrollLeft = fx * el.scrollWidth - (e.clientX - rect.left);
        el.scrollTop = fy * el.scrollHeight - (e.clientY - rect.top);
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, max, onChange]);
}

export function svgRatio(svg: string, fallback: number): number {
  const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  if (!m) return fallback;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : fallback;
}
