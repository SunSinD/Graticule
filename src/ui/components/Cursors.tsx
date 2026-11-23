import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ChannelId, ExtractionResult, Locale, PlotCursors } from '../../core/types';
import type { WaveformFrame } from '../../core/export/svg';
import { formatEng } from '../i18n';
import type { Dict } from '../i18n';
import type { ChannelLabels } from '../history';

type Key = 'x1' | 'x2' | 'y1' | 'y2';

const KEYS: readonly Key[] = ['x1', 'x2', 'y1', 'y2'];
const COINCIDENT = 1e-12;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Reads a value that is zero up to float noise, such as the plot center, as exactly zero. */
export function snapZero(v: number, span: number): number {
  return Math.abs(v) <= COINCIDENT * Math.abs(span) ? 0 : v;
}

/** Time at a cursor position, with the plot center reading 0 s instead of a float leftover. */
export function cursorTime(frame: WaveformFrame, fraction: number): number {
  return snapZero(frame.timeAt(clamp01(fraction)), frame.timeAt(1) - frame.timeAt(0));
}

/** Voltage at a cursor position, with the zero line reading 0 V instead of a float leftover. */
export function cursorVolt(frame: WaveformFrame, channel: ChannelId, fraction: number): number | null {
  const v = frame.voltAt(channel, clamp01(fraction));
  if (v === null) return null;
  const top = frame.voltAt(channel, 0);
  const bottom = frame.voltAt(channel, 1);
  return top === null || bottom === null ? v : snapZero(v, top - bottom);
}

export function enabledChannels(result: ExtractionResult): ChannelId[] {
  return result.traces.filter((t) => t.settings.enabled).map((t) => t.channel);
}

/** Keeps the saved cursor positions and makes sure the channel is still shown. */
export function resolveCursors(result: ExtractionResult, saved: PlotCursors | null | undefined): PlotCursors {
  const channels = enabledChannels(result);
  const base = saved ?? { x1: 0.25, x2: 0.75, y1: 0.25, y2: 0.75, channel: channels[0] ?? 'C1' };
  const channel = channels.includes(base.channel) ? base.channel : channels[0] ?? base.channel;
  return channel === base.channel ? base : { ...base, channel };
}

interface OverlayProps {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly frame: WaveformFrame;
  readonly cursors: PlotCursors;
  readonly onChange: (cursors: PlotCursors) => void;
}

export function CursorOverlay({ tx, locale, frame, cursors, onChange }: OverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Key | null>(null);
  const { x0, y0, x1, y1, plotW, plotH, width, height } = frame;
  const valueText = (key: Key): string =>
    key[0] === 'x'
      ? formatEng(cursorTime(frame, cursors[key]), 's', locale, { sig: 4, trim: true })
      : formatEng(cursorVolt(frame, cursors.channel, cursors[key]), 'V', locale, { sig: 4, trim: true });

  const fraction = (key: Key, clientX: number, clientY: number): number => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return cursors[key];
    const scale = Math.min(r.width / width, r.height / height);
    const offX = (r.width - width * scale) / 2;
    const offY = (r.height - height * scale) / 2;
    if (key[0] === 'x') return clamp01(((clientX - r.left - offX) / scale - x0) / plotW);
    return clamp01(((clientY - r.top - offY) / scale - y0) / plotH);
  };

  const start = (key: Key) => (e: ReactPointerEvent<SVGGElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = key;
  };
  const move = (e: ReactPointerEvent<SVGGElement>) => {
    const key = drag.current;
    if (!key) return;
    onChange({ ...cursors, [key]: fraction(key, e.clientX, e.clientY) });
  };
  const end = (e: ReactPointerEvent<SVGGElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const keys = (key: Key) => (e: ReactKeyboardEvent<SVGGElement>) => {
    const step = e.shiftKey ? 0.05 : 0.005;
    const horizontal = key[0] === 'x';
    let delta = 0;
    if (horizontal && e.key === 'ArrowLeft') delta = -step;
    else if (horizontal && e.key === 'ArrowRight') delta = step;
    else if (!horizontal && e.key === 'ArrowUp') delta = -step;
    else if (!horizontal && e.key === 'ArrowDown') delta = step;
    else if (e.key === 'Home') delta = -1;
    else if (e.key === 'End') delta = 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onChange({ ...cursors, [key]: clamp01(cursors[key] + delta) });
  };

  return (
    <svg
      ref={svgRef}
      className="cursor-layer"
      data-testid="cursor-layer"
      viewBox={`0 0 ${width} ${height}`}
      role="group"
      aria-label={tx.cursors}
    >
      {KEYS.map((key, i) => {
        const vertical = key[0] === 'x';
        const f = clamp01(cursors[key]);
        const pos = vertical ? x0 + f * plotW : y0 + f * plotH;
        const label = key.toUpperCase();
        const [ax, ay, bx, by] = vertical ? [pos, y0, pos, y1] : [x0, pos, x1, pos];
        return (
          <g
            key={key}
            className={`cursor ${vertical ? 'vx' : 'hy'}`}
            tabIndex={0}
            role="slider"
            aria-label={label}
            aria-orientation={vertical ? 'horizontal' : 'vertical'}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(f * 100)}
            aria-valuetext={valueText(key)}
            onPointerDown={start(key)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={keys(key)}
          >
            <line className="cursor-hit" x1={ax} y1={ay} x2={bx} y2={by} />
            <line className="cursor-line" x1={ax} y1={ay} x2={bx} y2={by} strokeDasharray={vertical ? '6 4' : '1.5 3'} />
            {vertical ? (
              <text x={pos + (f > 0.94 ? -4 : 4)} y={y0 + 12 + (i % 2) * 12} textAnchor={f > 0.94 ? 'end' : 'start'}>
                {label}
              </text>
            ) : (
              <text x={x1 - 4 - (i % 2) * 22} y={Math.max(y0 + 11, pos - 4)} textAnchor="end">
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

interface ReadoutProps {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly result: ExtractionResult;
  readonly frame: WaveformFrame;
  readonly cursors: PlotCursors;
  readonly labels: ChannelLabels | undefined;
  readonly onChange: (cursors: PlotCursors) => void;
}

export function CursorReadout({ tx, locale, result, frame, cursors, labels, onChange }: ReadoutProps) {
  const fmt = (v: number | null, unit: string) => formatEng(v, unit, locale, { sig: 4, trim: true });
  const t1 = cursorTime(frame, cursors.x1);
  const t2 = cursorTime(frame, cursors.x2);
  // Coincident cursors read as exactly zero, never a float leftover like 2e-7 ps.
  const sameX = Math.abs(clamp01(cursors.x2) - clamp01(cursors.x1)) <= COINCIDENT;
  const sameY = Math.abs(clamp01(cursors.y2) - clamp01(cursors.y1)) <= COINCIDENT;
  const rawDt = Math.abs(t2 - t1);
  const dt = sameX || rawDt <= COINCIDENT * Math.max(Math.abs(t1), Math.abs(t2)) ? 0 : rawDt;
  const v1 = cursorVolt(frame, cursors.channel, cursors.y1);
  const v2 = cursorVolt(frame, cursors.channel, cursors.y2);
  const rawDv = v1 === null || v2 === null ? null : Math.abs(v2 - v1);
  const dv = rawDv === null ? null : sameY || rawDv <= COINCIDENT * Math.max(Math.abs(v1!), Math.abs(v2!)) ? 0 : rawDv;
  const period = result.measurements.find((m) => m.channel === cursors.channel)?.periodSec ?? null;
  const phase = period && period > 0 && Number.isFinite(period) ? ((((dt / period) * 360) % 360) + 360) % 360 : null;
  const channels = enabledChannels(result);
  const items: readonly (readonly [string, string])[] = [
    ['X1', fmt(t1, 's')],
    ['X2', fmt(t2, 's')],
    ['Δt', fmt(dt, 's')],
    ['1/Δt', fmt(dt > 0 ? 1 / dt : null, 'Hz')],
    ['Y1', fmt(v1, 'V')],
    ['Y2', fmt(v2, 'V')],
    ['ΔV', fmt(dv, 'V')],
    ...(phase !== null ? ([['φ', formatEng(phase, '°', locale)]] as const) : []),
  ];
  return (
    <div className="cursor-bar" data-testid="cursor-readout" aria-live="polite">
      {channels.length >= 2 && (
        <select
          className="cursor-ch"
          aria-label={tx.cursorChannel}
          value={cursors.channel}
          onChange={(e) => onChange({ ...cursors, channel: e.target.value as ChannelId })}
        >
          {channels.map((ch) => (
            <option key={ch} value={ch}>
              {labels?.[ch]?.trim() || ch}
            </option>
          ))}
        </select>
      )}
      {items.map(([k, v]) => (
        <span key={k} className="cursor-item">
          <span className="k">{k}</span>
          <span className="v num">{v}</span>
        </span>
      ))}
    </div>
  );
}
