import type { GapStatus, TraceSample } from '../types.js';

export interface TracePoint {
  readonly xPx: number;
  readonly yPx: number;
}

export interface TraceGap {
  readonly x0: number;
  readonly x1: number;
  readonly kind: Exclude<GapStatus, 'ok'>;
}

export interface SplitTrace {
  readonly segments: readonly (readonly TracePoint[])[];
  readonly gaps: readonly TraceGap[];
  readonly step: number;
}

function gapKind(sample: TraceSample): Exclude<GapStatus, 'ok'> {
  return sample.status === 'ok' ? 'unresolved' : sample.status;
}

function isGood(sample: TraceSample): boolean {
  return sample.status === 'ok' && sample.yPx !== null && Number.isFinite(sample.yPx) && Number.isFinite(sample.xPx);
}

function medianStep(sorted: readonly TraceSample[]): number {
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (!a || !b) continue;
    const d = b.xPx - a.xPx;
    if (d > 0) steps.push(d);
  }
  if (steps.length === 0) return 1;
  steps.sort((p, q) => p - q);
  return steps[Math.floor(steps.length / 2)] ?? 1;
}

/**
 * Splits a trace into drawable runs of trustworthy samples.
 * A run is broken at every non ok sample and at every column jump,
 * so a renderer can never connect a line across missing data.
 */
export function splitTrace(samples: readonly TraceSample[]): SplitTrace {
  const sorted = samples.filter((s) => Number.isFinite(s.xPx)).slice().sort((a, b) => a.xPx - b.xPx);
  const step = medianStep(sorted);
  const maxStep = Math.max(1.5, step * 2.5);
  const segments: TracePoint[][] = [];
  const gaps: TraceGap[] = [];
  let seg: TracePoint[] = [];
  let open: { x0: number; x1: number; kind: Exclude<GapStatus, 'ok'> } | null = null;
  let prevX: number | null = null;

  const flushSeg = (): void => {
    if (seg.length > 0) segments.push(seg);
    seg = [];
  };
  const closeGap = (): void => {
    if (open) gaps.push({ x0: open.x0, x1: open.x1, kind: open.kind });
    open = null;
  };

  for (const s of sorted) {
    if (prevX !== null && s.xPx - prevX > maxStep) {
      flushSeg();
      if (open && open.kind === 'unresolved') {
        open.x1 = s.xPx;
      } else {
        closeGap();
        open = { x0: prevX, x1: s.xPx, kind: 'unresolved' };
      }
    }
    if (isGood(s) && s.yPx !== null) {
      closeGap();
      seg.push({ xPx: s.xPx, yPx: s.yPx });
    } else {
      flushSeg();
      const kind = gapKind(s);
      if (open && open.kind === kind) {
        open.x1 = s.xPx;
      } else {
        closeGap();
        open = { x0: s.xPx, x1: s.xPx, kind };
      }
    }
    prevX = s.xPx;
  }
  flushSeg();
  closeGap();
  return { segments, gaps, step };
}

export function summarizeGaps(gaps: readonly TraceGap[]): Partial<Record<Exclude<GapStatus, 'ok'>, number>> {
  const out: Partial<Record<Exclude<GapStatus, 'ok'>, number>> = {};
  for (const g of gaps) out[g.kind] = (out[g.kind] ?? 0) + 1;
  return out;
}
