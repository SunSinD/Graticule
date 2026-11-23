import { useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Point, Quad, Rect } from '../../core/types';
import { projectRectToQuad } from '../../core/deskew';
import type { Dict } from '../i18n';

type Corner = 'tl' | 'tr' | 'bl' | 'br';
type Grip = Corner | 'move';

const CORNERS: readonly Corner[] = ['tl', 'tr', 'br', 'bl'];
const MIN = 4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function arrowDelta(e: ReactKeyboardEvent): { dx: number; dy: number } | null {
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') return { dx: -step, dy: 0 };
  if (e.key === 'ArrowRight') return { dx: step, dy: 0 };
  if (e.key === 'ArrowUp') return { dx: 0, dy: -step };
  if (e.key === 'ArrowDown') return { dx: 0, dy: step };
  return null;
}

interface Common {
  readonly tx: Dict;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly hDivs: number;
  readonly vDivs: number;
  readonly onApply: () => void;
  readonly onCancel: () => void;
}

function useStageMapping(imageWidth: number, imageHeight: number) {
  const ref = useRef<HTMLDivElement>(null);
  const toImage = (clientX: number, clientY: number): Point => {
    const stage = ref.current?.parentElement?.getBoundingClientRect();
    if (!stage || stage.width === 0 || stage.height === 0) return { x: 0, y: 0 };
    return {
      x: ((clientX - stage.left) / stage.width) * imageWidth,
      y: ((clientY - stage.top) / stage.height) * imageHeight,
    };
  };
  return { ref, toImage };
}

/**
 * A crop corner moves in two directions, so it is a slider whose value text gives both positions.
 * The keys are described once, in a hidden note every handle points to.
 */
function handleProps(label: string, p: Point, w: number, hintId: string) {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  return {
    role: 'slider',
    tabIndex: 0,
    'aria-label': label,
    'aria-describedby': hintId,
    'aria-valuemin': 0,
    'aria-valuemax': Math.max(0, Math.round(w)),
    'aria-valuenow': x,
    'aria-valuetext': `x ${x}, y ${y}`,
  } as const;
}

function cornerPoint(r: Rect, c: Corner): Point {
  return {
    x: c === 'tl' || c === 'bl' ? r.x : r.x + r.width,
    y: c === 'tl' || c === 'tr' ? r.y : r.y + r.height,
  };
}

function commonKeys(e: ReactKeyboardEvent, onApply: () => void, onCancel: () => void): boolean {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    onApply();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    onCancel();
    return true;
  }
  return false;
}

/* Rectangle */

interface RectProps extends Common {
  readonly rect: Rect;
  readonly onChange: (rect: Rect) => void;
}

function moveRect(grip: Grip, r: Rect, dx: number, dy: number, w: number, h: number): Rect {
  if (grip === 'move') {
    return {
      x: Math.round(clamp(r.x + dx, 0, w - r.width)),
      y: Math.round(clamp(r.y + dy, 0, h - r.height)),
      width: r.width,
      height: r.height,
    };
  }
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (grip === 'tl' || grip === 'bl') left = clamp(r.x + dx, 0, right - MIN);
  if (grip === 'tr' || grip === 'br') right = clamp(right + dx, left + MIN, w);
  if (grip === 'tl' || grip === 'tr') top = clamp(r.y + dy, 0, bottom - MIN);
  if (grip === 'bl' || grip === 'br') bottom = clamp(bottom + dy, top + MIN, h);
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
}

export function CropBox({ tx, rect, imageWidth, imageHeight, hDivs, vDivs, onChange, onApply, onCancel }: RectProps) {
  const drag = useRef<{ grip: Grip; start: Point; rect: Rect } | null>(null);
  const { ref, toImage } = useStageMapping(imageWidth, imageHeight);
  const hintId = useId();

  const start = (grip: Grip) => (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { grip, start: toImage(e.clientX, e.clientY), rect };
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e.clientX, e.clientY);
    onChange(moveRect(d.grip, d.rect, p.x - d.start.x, p.y - d.start.y, imageWidth, imageHeight));
  };

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const keys = (grip: Grip) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (commonKeys(e, onApply, onCancel)) return;
    const d = arrowDelta(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    onChange(moveRect(grip, rect, d.dx, d.dy, imageWidth, imageHeight));
  };

  const pct = (v: number, of: number): string => `${(v / Math.max(1, of)) * 100}%`;
  const vLines = Array.from({ length: Math.max(0, hDivs - 1) }, (_, i) => (i + 1) / hDivs);
  const hLines = Array.from({ length: Math.max(0, vDivs - 1) }, (_, i) => (i + 1) / vDivs);

  return (
    <div
      ref={ref}
      className="crop-box"
      data-testid="crop-box"
      role="group"
      tabIndex={0}
      aria-label={tx.cropBox}
      aria-describedby={hintId}
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
      onKeyDown={keys('move')}
    >
      {vLines.map((f) => (
        <span key={`v${f}`} className="crop-line v" style={{ left: `${f * 100}%` }} />
      ))}
      {hLines.map((f) => (
        <span key={`h${f}`} className="crop-line h" style={{ top: `${f * 100}%` }} />
      ))}
      <span id={hintId} className="sr-only">
        {tx.cornerKeys}
      </span>
      {CORNERS.map((c) => (
        <span
          key={c}
          className={`crop-handle ${c}`}
          {...handleProps(tx.corners[c]!, cornerPoint(rect, c), imageWidth, hintId)}
          onPointerDown={start(c)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={keys(c)}
        />
      ))}
    </div>
  );
}

/* Four corners */

interface QuadProps extends Common {
  readonly quad: Quad;
  readonly valid: boolean;
  readonly onChange: (quad: Quad) => void;
}

function setCorner(quad: Quad, index: number, p: Point): Quad {
  const out = [...quad] as Point[];
  out[index] = p;
  return out as unknown as Quad;
}

function shiftQuad(quad: Quad, dx: number, dy: number, w: number, h: number): Quad {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const sx = clamp(dx, -Math.min(...xs), w - Math.max(...xs));
  const sy = clamp(dy, -Math.min(...ys), h - Math.max(...ys));
  return quad.map((p) => ({ x: Math.round(p.x + sx), y: Math.round(p.y + sy) })) as unknown as Quad;
}

export function QuadBox({ tx, quad, valid, imageWidth, imageHeight, hDivs, vDivs, onChange, onApply, onCancel }: QuadProps) {
  const drag = useRef<{ grip: number | 'move'; start: Point; quad: Quad } | null>(null);
  const { ref, toImage } = useStageMapping(imageWidth, imageHeight);
  const w = imageWidth;
  const h = imageHeight;
  const hintId = useId();

  const start = (grip: number | 'move') => (e: ReactPointerEvent<Element>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { grip, start: toImage(e.clientX, e.clientY), quad };
  };

  const move = (e: ReactPointerEvent<Element>) => {
    const d = drag.current;
    if (!d) return;
    const p = toImage(e.clientX, e.clientY);
    if (d.grip === 'move') {
      onChange(shiftQuad(d.quad, p.x - d.start.x, p.y - d.start.y, w, h));
      return;
    }
    const base = d.quad[d.grip]!;
    const next = {
      x: Math.round(clamp(base.x + p.x - d.start.x, 0, w)),
      y: Math.round(clamp(base.y + p.y - d.start.y, 0, h)),
    };
    onChange(setCorner(d.quad, d.grip, next));
  };

  const end = (e: ReactPointerEvent<Element>) => {
    drag.current = null;
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  };

  const keys = (index: number) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (commonKeys(e, onApply, onCancel)) return;
    const d = arrowDelta(e);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const p = quad[index]!;
    onChange(setCorner(quad, index, { x: clamp(p.x + d.dx, 0, w), y: clamp(p.y + d.dy, 0, h) }));
  };

  const pts = quad.map((p) => `${p.x} ${p.y}`).join(' ');
  const lines: { key: string; a: Point; b: Point }[] = [];
  if (valid) {
    const size = { width: hDivs + 1, height: vDivs + 1 };
    for (let i = 1; i < hDivs; i++) {
      lines.push({ key: `v${i}`, a: projectRectToQuad({ x: i, y: 0 }, quad, size), b: projectRectToQuad({ x: i, y: vDivs }, quad, size) });
    }
    for (let j = 1; j < vDivs; j++) {
      lines.push({ key: `h${j}`, a: projectRectToQuad({ x: 0, y: j }, quad, size), b: projectRectToQuad({ x: hDivs, y: j }, quad, size) });
    }
  }

  return (
    <div ref={ref} className="quad-box" data-testid="quad-box">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon
          className="quad-area"
          points={pts}
          onPointerDown={start('move')}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
        {lines.map((l) => (
          <line key={l.key} className="quad-line" x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />
        ))}
        <polygon className="quad-edge outer" points={pts} />
        <polygon className={`quad-edge${valid ? '' : ' bad'}`} points={pts} />
      </svg>
      <span id={hintId} className="sr-only">
        {tx.cornerKeys}
      </span>
      {quad.map((p, i) => (
        <span
          key={CORNERS[i]}
          className="crop-handle"
          {...handleProps(tx.corners[CORNERS[i]!]!, p, w, hintId)}
          style={{ left: `${(p.x / Math.max(1, w)) * 100}%`, top: `${(p.y / Math.max(1, h)) * 100}%` }}
          onPointerDown={start(i)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={keys(i)}
        />
      ))}
    </div>
  );
}
