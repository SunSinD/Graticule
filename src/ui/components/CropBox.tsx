import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Rect } from '../../core/types';

type Corner = 'tl' | 'tr' | 'bl' | 'br' | 'move';

interface Props {
  readonly rect: Rect;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly hDivs: number;
  readonly vDivs: number;
  readonly onChange: (rect: Rect) => void;
}

interface Drag {
  readonly corner: Corner;
  readonly startX: number;
  readonly startY: number;
  readonly rect: Rect;
}

const MIN = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function CropBox({ rect, imageWidth, imageHeight, hDivs, vDivs, onChange }: Props) {
  const drag = useRef<Drag | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const toImage = (clientX: number, clientY: number): { x: number; y: number } => {
    const stage = boxRef.current?.parentElement?.getBoundingClientRect();
    if (!stage || stage.width === 0 || stage.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - stage.left) / stage.width) * imageWidth,
      y: ((clientY - stage.top) / stage.height) * imageHeight,
    };
  };

  const start = (corner: Corner) => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    drag.current = { corner, startX: p.x, startY: p.y, rect };
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e.clientX, e.clientY);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    const r = d.rect;
    let left = r.x;
    let top = r.y;
    let right = r.x + r.width;
    let bottom = r.y + r.height;
    if (d.corner === 'move') {
      const nx = clamp(r.x + dx, 0, imageWidth - r.width);
      const ny = clamp(r.y + dy, 0, imageHeight - r.height);
      onChange({ x: Math.round(nx), y: Math.round(ny), width: r.width, height: r.height });
      return;
    }
    if (d.corner === 'tl' || d.corner === 'bl') left = clamp(r.x + dx, 0, right - MIN);
    if (d.corner === 'tr' || d.corner === 'br') right = clamp(right + dx, left + MIN, imageWidth);
    if (d.corner === 'tl' || d.corner === 'tr') top = clamp(r.y + dy, 0, bottom - MIN);
    if (d.corner === 'bl' || d.corner === 'br') bottom = clamp(bottom + dy, top + MIN, imageHeight);
    onChange({
      x: Math.round(left),
      y: Math.round(top),
      width: Math.max(1, Math.round(right - left)),
      height: Math.max(1, Math.round(bottom - top)),
    });
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const pct = (v: number, of: number): string => `${(v / Math.max(1, of)) * 100}%`;
  const vLines = Array.from({ length: Math.max(0, hDivs - 1) }, (_, i) => (i + 1) / hDivs);
  const hLines = Array.from({ length: Math.max(0, vDivs - 1) }, (_, i) => (i + 1) / vDivs);

  return (
    <div
      ref={boxRef}
      className="crop-box"
      data-testid="crop-box"
      style={{
        left: pct(rect.x, imageWidth),
        top: pct(rect.y, imageHeight),
        width: pct(rect.width, imageWidth),
        height: pct(rect.height, imageHeight),
      }}
      onPointerDown={start('move')}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {vLines.map((f) => (
        <span key={`v${f}`} className="crop-line v" style={{ left: `${f * 100}%` }} />
      ))}
      {hLines.map((f) => (
        <span key={`h${f}`} className="crop-line h" style={{ top: `${f * 100}%` }} />
      ))}
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <span
          key={c}
          className={`crop-handle ${c}`}
          role="presentation"
          onPointerDown={start(c)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
    </div>
  );
}
