import type {
  BodePoint,
  BodeResult,
  ChannelId,
  ChannelTrace,
  ExtractionResult,
  GapStatus,
  Locale,
  PlotCursors,
  PlotTheme,
  SvgExportOptions,
} from '../types.js';
import { projectRectToQuad } from '../deskew.js';
import { GRATICULE_VERSION, formatEng, localizeDecimal, trimTrailingZeros } from './format.js';
import { GAP_LABELS, SVG_TEXT } from './labels.js';
import { splitTrace } from './trace-geometry.js';
import type { TraceGap } from './trace-geometry.js';

interface PlotPalette {
  readonly ink: string;
  readonly paper: string;
  readonly grid: string;
  readonly gridMinor: string;
  readonly muted: string;
  readonly soft: string;
}

const PALETTES: Readonly<Record<PlotTheme, PlotPalette>> = {
  light: {
    ink: '#000000',
    paper: '#ffffff',
    grid: '#d4d4d4',
    gridMinor: '#e5e5e5',
    muted: '#737373',
    soft: '#a3a3a3',
  },
  dark: {
    ink: '#fafafa',
    paper: '#0a0a0a',
    grid: '#404040',
    gridMinor: '#262626',
    muted: '#a3a3a3',
    soft: '#737373',
  },
};

const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const MINUS = '−';

interface LineStyle {
  readonly width: number;
  readonly dash: string | null;
}

export const CHANNEL_LINE_STYLES: Readonly<Record<ChannelId, LineStyle>> = {
  C1: { width: 1.6, dash: null },
  C2: { width: 1.6, dash: '6 3' },
  C3: { width: 1.6, dash: '1.5 2.5' },
  C4: { width: 1.6, dash: '7 3 1.5 3' },
};

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function n(value: number): string {
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
}

function svgMinus(text: string): string {
  return text.replace(/^-/, MINUS);
}

function strokeAttrs(channel: ChannelId, ink: string): string {
  const s = CHANNEL_LINE_STYLES[channel];
  const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : '';
  return `stroke="${ink}" stroke-width="${s.width}"${dash} stroke-linecap="butt" stroke-linejoin="round" fill="none"`;
}

function text(
  x: number,
  y: number,
  content: string,
  opts: { anchor?: 'start' | 'middle' | 'end'; size?: number; mono?: boolean; fill?: string; weight?: number } = {},
  defaultFill = '#000000',
): string {
  const anchor = opts.anchor ?? 'start';
  const size = opts.size ?? 11;
  const family = opts.mono ? MONO : SANS;
  const fill = opts.fill ?? defaultFill;
  const weight = opts.weight ? ` font-weight="${opts.weight}"` : '';
  const nums = opts.mono ? ' style="font-variant-numeric: tabular-nums"' : '';
  return `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" font-family="${family}" font-size="${size}" fill="${fill}"${weight}${nums}>${escapeXml(content)}</text>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1, dash: string | null = null): string {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${width}"${d}/>`;
}

function svgOpen(width: number, height: number, label: string, paper: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${paper}"/>`,
  ].join('');
}

interface LinearFit {
  readonly a: number;
  readonly b: number;
}

function timeFit(result: ExtractionResult): LinearFit {
  const g = result.detection.grid;
  const spd = result.timebase.secPerDiv;
  const b = spd / Math.max(1e-9, g.pxPerHDiv);
  return { a: result.timebase.triggerOffsetSec - g.centerX * b, b };
}

function voltFit(trace: ChannelTrace, pxPerVDiv: number): LinearFit {
  const st = trace.settings;
  const b = -st.voltsPerDiv / Math.max(1e-9, pxPerVDiv);
  return { a: -b * st.zeroY, b };
}

function niceDiv(value: number, locale: Locale, unit: string): string {
  return formatEng(value, unit, locale, { sig: 3, trim: true });
}

const GAP_ORDER: readonly Exclude<GapStatus, 'ok'>[] = [
  'clipped_high',
  'clipped_low',
  'masked_cursor',
  'masked_overlay',
  'overlap_ambiguous',
  'unresolved',
];

export interface WaveformFrame {
  readonly width: number;
  readonly height: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly plotW: number;
  readonly plotH: number;
  timeAt(fraction: number): number;
  voltAt(channel: ChannelId, fraction: number): number | null;
}

function waveformLayout(result: ExtractionResult, options: SvgExportOptions) {
  const grid = result.detection.grid;
  const traces = result.traces.filter(tr => tr.settings.enabled);
  const width = Math.round(options.width ?? 960);
  const x0 = 76;
  const y0 = 56;
  const plotW = width - x0 - (traces.length > 1 ? 76 : 28);
  const plotH = plotW / Math.max(1, grid.hDivs) * Math.max(1, grid.vDivs);
  const laneGap = 5;
  const lanesH = traces.length * laneGap + 6;
  const axisLabelH = options.cursors ? 52 : 34;
  const legendRowH = 18;
  const legendH = options.showLegend === false ? 0 : 16 + (traces.length + 2) * legendRowH + 30;
  const height = Math.round(options.height ?? y0 + plotH + lanesH + axisLabelH + legendH + 12);
  const tf = timeFit(result);
  const fits = new Map(traces.map(trace => [trace.channel, voltFit(trace, grid.pxPerVDiv)]));
  const frame: WaveformFrame = {
    width, height, x0, y0, x1: x0 + plotW, y1: y0 + plotH, plotW, plotH,
    timeAt: fraction => tf.a + tf.b * (grid.left + fraction * grid.width),
    voltAt(channel, fraction) {
      const fit = fits.get(channel);
      return fit ? fit.a + fit.b * (grid.top + fraction * grid.height) : null;
    },
  };
  return { frame, traces, laneGap, lanesH, axisLabelH, legendRowH };
}

export function waveformFrame(result: ExtractionResult, options: SvgExportOptions = {}): WaveformFrame {
  return waveformLayout(result, options).frame;
}

function cursorMarkup(frame: WaveformFrame, cursors: PlotCursors, locale: Locale, pal: PlotPalette, readoutY: number): string {
  const { x0, y0, x1, y1, plotW, plotH } = frame;
  const clamp = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const xs = [clamp(cursors.x1), clamp(cursors.x2)];
  const ys = [clamp(cursors.y1), clamp(cursors.y2)];
  const lines = ['<g aria-label="X1 / X2 / Y1 / Y2">'];
  for (const [i, fraction] of xs.entries()) {
    const x = x0 + fraction * plotW;
    lines.push(line(x, y0, x, y1, pal.muted, 1, '5 3'));
    lines.push(text(x, y0 + 12 + i * 11, `X${i + 1}`, { anchor: fraction > 0.96 ? 'end' : 'start', mono: true, size: 10 }, pal.ink));
  }
  for (const [i, fraction] of ys.entries()) {
    const y = y0 + fraction * plotH;
    lines.push(line(x0, y, x1, y, pal.muted, 1, '1 3'));
    lines.push(text(x1 - 3 - i * 18, Math.max(y0 + 11, y - 3), `Y${i + 1}`, { anchor: 'end', mono: true, size: 10 }, pal.ink));
  }
  const dt = Math.abs(frame.timeAt(xs[1]!) - frame.timeAt(xs[0]!));
  const va = frame.voltAt(cursors.channel, ys[0]!);
  const vb = frame.voltAt(cursors.channel, ys[1]!);
  const dv = va === null || vb === null ? null : Math.abs(vb - va);
  const format = (value: number | null, unit: string) => formatEng(value, unit, locale, { sig: 4, trim: true });
  lines.push(text(x0, readoutY, `Δt ${format(dt, 's')}   1/Δt ${format(dt > 0 ? 1 / dt : null, 'Hz')}   ΔV ${format(dv, 'V')}`, { mono: true }, pal.ink));
  return lines.join('') + '</g>';
}

export function renderWaveformSvg(result: ExtractionResult, options: SvgExportOptions = {}): string {
  const pal = PALETTES[options.theme ?? 'light'];
  const locale: Locale = options.locale ?? 'en';
  const t = SVG_TEXT[locale];
  const showGrid = options.showGrid ?? true;
  const showLegend = options.showLegend ?? true;
  const grid = result.detection.grid;
  const hDivs = Math.max(1, grid.hDivs);
  const vDivs = Math.max(1, grid.vDivs);
  const { frame, traces, laneGap, lanesH, axisLabelH, legendRowH } = waveformLayout(result, options);
  const { width, height, x0, y0, x1, y1, plotW, plotH } = frame;
  const divPx = plotW / hDivs;
  const channelLabel = (id: ChannelId) => options.channelLabels?.[id]?.trim() || id;
  const gw = Math.max(1e-9, grid.width);
  const gh = Math.max(1e-9, grid.height);
  const mapX = (px: number): number => x0 + ((px - grid.left) / gw) * plotW;
  const mapY = (py: number): number => y0 + ((py - grid.top) / gh) * plotH;

  const title = options.title ?? result.fileName;
  const out: string[] = [svgOpen(width, height, title, pal.paper)];
  out.push(text(x0, 24, title, { size: 14, weight: 600 }, pal.ink));
  out.push(
    text(x1, 24, `${result.detection.profileName}`, { anchor: 'end', size: 11, fill: pal.muted }, pal.ink),
  );
  out.push(
    text(x0, options.channelLabels ? 38 : 42, `${t.timePerDiv} ${niceDiv(result.timebase.secPerDiv, locale, 's')}`, { size: 11, mono: true }, pal.ink),
  );

  if (showGrid) {
    const g: string[] = [];
    for (let i = 1; i < hDivs; i++) g.push(line(x0 + i * divPx, y0, x0 + i * divPx, y1, pal.grid, 1));
    for (let j = 1; j < vDivs; j++) g.push(line(x0, y0 + j * divPx, x1, y0 + j * divPx, pal.grid, 1));
    const cx = x0 + (hDivs / 2) * divPx;
    const cy = y0 + (vDivs / 2) * divPx;
    const sub = divPx / 5;
    for (let k = 1; k < hDivs * 5; k++) {
      if (k % 5 === 0) continue;
      const xx = x0 + k * sub;
      g.push(line(xx, cy - 3, xx, cy + 3, pal.soft, 1));
    }
    for (let k = 1; k < vDivs * 5; k++) {
      if (k % 5 === 0) continue;
      const yy = y0 + k * sub;
      g.push(line(cx - 3, yy, cx + 3, yy, pal.soft, 1));
    }
    out.push(`<g aria-hidden="true">${g.join('')}</g>`);
  }
  out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${n(plotW)}" height="${n(plotH)}" fill="none" stroke="${pal.ink}" stroke-width="1"/>`);

  const ticks: string[] = [];
  for (let i = 0; i <= hDivs; i++) {
    const xx = x0 + i * divPx;
    ticks.push(line(xx, y1, xx, y1 + 4, pal.ink, 1));
    const tv = frame.timeAt(i / hDivs);
    const label = svgMinus(formatEng(Math.abs(tv) < Math.abs(result.timebase.secPerDiv) * 1e-6 ? 0 : tv, 's', locale, { sig: 3, trim: true }));
    if (i % 2 === 0 || hDivs <= 10) {
      ticks.push(text(xx, y1 + lanesH + 14, label, { anchor: 'middle', size: 10, mono: true }, pal.ink));
    }
  }
  const axisTraces = traces.slice(0, 2);
  axisTraces.forEach((tr, idx) => {
    const left = idx === 0;
    const ax = left ? x0 : x1;
    for (let j = 0; j <= vDivs; j++) {
      const yy = y0 + j * divPx;
      const v = frame.voltAt(tr.channel, j / vDivs)!;
      const clean = Math.abs(v) < tr.settings.voltsPerDiv * 1e-6 ? 0 : v;
      ticks.push(line(ax, yy, left ? ax - 4 : ax + 4, yy, pal.ink, 1));
      ticks.push(
        text(left ? ax - 7 : ax + 7, yy + 3.5, svgMinus(formatEng(clean, 'V', locale, { sig: 4, trim: true })), {
          anchor: left ? 'end' : 'start',
          size: 10,
          mono: true,
        }, pal.ink),
      );
    }
    if (Math.abs(tr.settings.offsetVolts) > tr.settings.voltsPerDiv * 1e-4 && tr.settings.zeroY >= grid.top && tr.settings.zeroY <= grid.bottom) {
      const zy = mapY(tr.settings.zeroY);
      const pts = left
        ? `${n(ax)},${n(zy)} ${n(ax - 5)},${n(zy - 3.5)} ${n(ax - 5)},${n(zy + 3.5)}`
        : `${n(ax)},${n(zy)} ${n(ax + 5)},${n(zy - 3.5)} ${n(ax + 5)},${n(zy + 3.5)}`;
      ticks.push(`<polygon points="${pts}" fill="${pal.ink}"/>`);
    }
    const label = channelLabel(tr.channel);
    ticks.push(label === tr.channel
      ? text(left ? ax - 7 : ax + 7, y0 - 8, label, { anchor: left ? 'end' : 'start', size: 10, weight: 600 }, pal.ink)
      : text(ax, y0 - 4, label, { anchor: left ? 'start' : 'end', size: 10, weight: 600 }, pal.ink));
  });
  out.push(`<g aria-label="axes">${ticks.join('')}</g>`);

  out.push(`<defs><clipPath id="plot-clip"><rect x="${n(x0)}" y="${n(y0)}" width="${n(plotW)}" height="${n(plotH)}"/></clipPath></defs>`);

  const gapCounts: Record<string, number> = {};
  traces.forEach((tr, idx) => {
    const split = splitTrace(tr.samples);
    const d = split.segments
      .map((seg) => {
        if (seg.length === 1) {
          const p = seg[0];
          if (!p) return '';
          const xx = mapX(p.xPx);
          return `M${n(xx - 0.6)} ${n(mapY(p.yPx))}L${n(xx + 0.6)} ${n(mapY(p.yPx))}`;
        }
        return seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(mapX(p.xPx))} ${n(mapY(p.yPx))}`).join('');
      })
      .join('');
    out.push(`<g aria-label="${escapeXml(channelLabel(tr.channel))} trace" clip-path="url(#plot-clip)">`);
    if (d) out.push(`<path d="${d}" ${strokeAttrs(tr.channel, pal.ink)}/>`);
    out.push(clipEdgeMarks(split.gaps, mapX, y0, y1, split.step, plotW / gw, pal.muted));
    out.push('</g>');
    const laneY = y1 + 6 + idx * laneGap;
    out.push(gapLane(split.gaps, mapX, laneY, split.step, plotW / gw, tr.channel, x0, x1, pal.muted));
    gapCounts[tr.channel] = split.gaps.length;
  });

  if (traces.length === 0) {
    out.push(text((x0 + x1) / 2, (y0 + y1) / 2, t.noChannels, { anchor: 'middle', size: 13, fill: pal.muted }, pal.ink));
  }
  if (options.cursors) out.push(cursorMarkup(frame, options.cursors, locale, pal, y1 + lanesH + 35));

  if (showLegend) {
    let ly = y1 + lanesH + axisLabelH + 10;
    const lg: string[] = [];
    for (const tr of traces) {
      const s = tr.settings;
      lg.push(`<line x1="${n(x0)}" y1="${n(ly - 4)}" x2="${n(x0 + 36)}" y2="${n(ly - 4)}" ${strokeAttrs(tr.channel, pal.ink)}/>`);
      const parts = [
        `${niceDiv(s.voltsPerDiv, locale, 'V')}/div`,
        `${t.offset} ${svgMinus(formatEng(s.offsetVolts, 'V', locale, { sig: 3, trim: true }))}`,
        `${t.probe} ${localizeDecimal(trimTrailingZeros(String(s.probeAttenuation)), locale)}x`,
      ];
      if (s.coupling !== 'UNKNOWN') parts.push(s.coupling);
      const gaps = gapCounts[tr.channel] ?? 0;
      const label = channelLabel(tr.channel);
      if (label === tr.channel) {
        lg.push(text(x0 + 46, ly, label, { size: 11, weight: 600 }, pal.ink));
        lg.push(text(x0 + 74, ly, parts.join('   '), { size: 11, mono: true }, pal.ink));
      } else {
        lg.push(text(x0 + 46, ly, `${label}   ${parts.join('   ')}`, { size: 11, mono: true }, pal.ink));
      }
      if (gaps > 0) lg.push(text(x1, ly, gapSummary(tr, locale), { anchor: 'end', size: 10, fill: pal.muted }, pal.ink));
      ly += legendRowH;
    }
    lg.push(
      text(x0, ly, `${t.timePerDiv} ${niceDiv(result.timebase.secPerDiv, locale, 's')}   ${t.trigger} ${svgMinus(formatEng(result.timebase.triggerOffsetSec, 's', locale, { sig: 3, trim: true }))}`, {
        size: 11,
        mono: true,
      }, pal.ink),
    );
    ly += legendRowH;
    lg.push(text(x0, ly, t.gapNote, { size: 10, fill: pal.muted }, pal.ink));
    ly += legendRowH;
    lg.push(text(x0, ly, `Graticule v${GRATICULE_VERSION}`, { size: 9, fill: pal.soft }, pal.ink));
    out.push(`<g aria-label="legend">${lg.join('')}</g>`);
  }

  out.push('</svg>');
  return out.join('');
}

function gapSummary(trace: ChannelTrace, locale: Locale): string {
  const labels = GAP_LABELS[locale];
  const counts: Partial<Record<GapStatus, number>> = {};
  for (const s of trace.samples) if (s.status !== 'ok') counts[s.status] = (counts[s.status] ?? 0) + 1;
  const parts: string[] = [];
  for (const kind of GAP_ORDER) {
    const c = counts[kind];
    if (c) parts.push(`${labels[kind]} ${c}`);
  }
  return parts.join(', ');
}

function gapSpan(g: TraceGap, mapX: (px: number) => number, step: number, scale: number): { a: number; b: number } {
  const half = Math.max(0.5, (step * scale) / 2);
  return { a: mapX(g.x0) - half, b: mapX(g.x1) + half };
}

function clipEdgeMarks(
  gaps: readonly TraceGap[],
  mapX: (px: number) => number,
  y0: number,
  y1: number,
  step: number,
  scale: number,
  muted: string,
): string {
  const out: string[] = [];
  for (const g of gaps) {
    if (g.kind !== 'clipped_high' && g.kind !== 'clipped_low') continue;
    const { a, b } = gapSpan(g, mapX, step, scale);
    const y = g.kind === 'clipped_high' ? y0 + 2 : y1 - 2;
    out.push(line(a, y, b, y, muted, 2, '1 2'));
  }
  return out.join('');
}

function gapLane(
  gaps: readonly TraceGap[],
  mapX: (px: number) => number,
  y: number,
  step: number,
  scale: number,
  channel: ChannelId,
  xMin: number,
  xMax: number,
  muted: string,
): string {
  if (gaps.length === 0) return '';
  const out: string[] = [`<g aria-label="${channel} gaps">`];
  for (const g of gaps) {
    const span = gapSpan(g, mapX, step, scale);
    const a = Math.max(xMin, span.a);
    const b = Math.min(xMax, span.b);
    if (b < a) continue;
    out.push(line(a, y, Math.max(b, a + 1), y, muted, 1.5, '1 1.5'));
    out.push(line(a, y - 1.5, a, y + 1.5, muted, 0.75));
    out.push(line(b, y - 1.5, b, y + 1.5, muted, 0.75));
  }
  out.push('</g>');
  return out.join('');
}

interface Range {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

function niceRange(values: readonly number[], fallback: Range, steps: readonly number[]): Range {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return fallback;
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < 1e-9) {
    const padding = Math.max(fallback.step, Math.abs(hi) * 0.02);
    lo = Math.max(-Number.MAX_VALUE, lo - padding);
    hi = Math.min(Number.MAX_VALUE, hi + padding);
  }
  const span = hi - lo;
  const step = steps.find(s => span / s <= 8) ?? (hi / 8 - lo / 8);
  return {
    min: Math.max(-Number.MAX_VALUE, Math.floor(lo / step) * step),
    max: Math.min(Number.MAX_VALUE, Math.ceil(hi / step) * step),
    step,
  };
}

function rangeFraction(value: number, range: Range): number {
  return (value / 2 - range.min / 2) / (range.max / 2 - range.min / 2);
}

function validFreq(p: BodePoint): p is BodePoint & { frequencyHz: number } {
  return p.frequencyHz !== null && Number.isFinite(p.frequencyHz) && p.frequencyHz > 0;
}

function finiteNum(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

export function renderBodeSvg(result: BodeResult, options: SvgExportOptions = {}): string {
  const pal = PALETTES[options.theme ?? 'light'];
  const locale: Locale = options.locale ?? 'en';
  const t = SVG_TEXT[locale];
  const width = Math.round(options.width ?? 960);
  const height = Math.round(options.height ?? 660);
  const marginL = 76;
  const marginR = 28;
  const marginT = 52;
  const panelGap = 44;
  const legendH = options.showLegend === false ? 0 : 58;
  const axisH = 30;
  const plotW = width - marginL - marginR;
  const panelH = (height - marginT - panelGap - axisH - legendH - 12) / 2;
  const x0 = marginL;
  const x1 = x0 + plotW;
  const gTop = marginT;
  const gBot = gTop + panelH;
  const pTop = gBot + panelGap;
  const pBot = pTop + panelH;

  const pts = result.points.filter(validFreq).slice().sort((a, b) => a.frequencyHz - b.frequencyHz);
  const freqs = pts.map((p) => p.frequencyHz);
  const cutoffs = [...new Set([result.cutoffLowHz ?? result.cutoffHz, result.cutoffHighHz ?? null])]
    .filter((frequency): frequency is number => finiteNum(frequency) && frequency > 0);
  freqs.push(...cutoffs);
  let dMin = freqs.length ? Math.floor(Math.log10(Math.min(...freqs))) : 1;
  let dMax = freqs.length ? Math.ceil(Math.log10(Math.max(...freqs))) : 5;
  if (dMax <= dMin) dMax = dMin + 1;
  const logSpan = dMax - dMin;
  const mapF = (f: number): number => x0 + ((Math.log10(f) - dMin) / logSpan) * plotW;

  const gains = pts.map((p) => p.gainDb).filter(finiteNum);
  if (finiteNum(result.cutoffTargetDb)) gains.push(result.cutoffTargetDb);
  const gR = niceRange(gains, { min: -40, max: 10, step: 10 }, [1, 2, 5, 10, 20, 30, 40]);
  const phases = pts.map((p) => p.phaseDeg).filter(finiteNum);
  const pR = niceRange(phases, { min: -180, max: 0, step: 45 }, [5, 10, 15, 30, 45, 90]);
  const mapG = (v: number): number => gBot - rangeFraction(v, gR) * panelH;
  const mapP = (v: number): number => pBot - rangeFraction(v, pR) * panelH;

  const title = options.title ?? 'Bode';
  const out: string[] = [svgOpen(width, height, title, pal.paper)];
  out.push(text(x0, 26, title, { size: 14, weight: 600 }, pal.ink));
  out.push(
    text(x1, 26, `${t.input} ${result.inputChannel}   ${t.output} ${result.outputChannel}   ${t.accepted} ${result.acceptedCount}   ${t.rejected} ${result.rejectedCount}`, {
      anchor: 'end',
      size: 11,
      mono: true,
      fill: pal.muted,
    }, pal.ink),
  );

  const decadeGrid = (top: number, bot: number): string => {
    const g: string[] = [];
    for (let d = dMin; d <= dMax; d++) {
      const xx = mapF(10 ** d);
      if (d > dMin && d < dMax) g.push(line(xx, top, xx, bot, pal.grid, 1));
      if (d < dMax) {
        for (let m = 2; m <= 9; m++) {
          const xm = mapF(m * 10 ** d);
          g.push(line(xm, top, xm, bot, pal.gridMinor, 1));
        }
      }
    }
    return g.join('');
  };

  const panel = (
    label: string,
    axisTitle: string,
    top: number,
    bot: number,
    range: Range,
    map: (v: number) => number,
    pick: (p: BodePoint) => number | null,
    wrapPhase = false,
  ): string => {
    const g: string[] = [`<g aria-label="${escapeXml(label)}">`];
    g.push(`<rect x="${n(x0)}" y="${n(top)}" width="${n(plotW)}" height="${n(bot - top)}" fill="${pal.paper}"/>`);
    if (options.showGrid !== false) g.push(decadeGrid(top, bot));
    for (let i = 0; i <= 10; i++) {
      const v = (range.min / 2 + i * (range.step / 2)) * 2;
      if (v > range.max + range.step * 1e-6 || !Number.isFinite(v)) break;
      const yy = map(v);
      if (options.showGrid !== false && v > range.min && v < range.max) g.push(line(x0, yy, x1, yy, pal.grid, 1));
      g.push(line(x0 - 4, yy, x0, yy, pal.ink, 1));
      const lbl = `${svgMinus(localizeDecimal(trimTrailingZeros(v.toFixed(2)), locale))}`;
      g.push(text(x0 - 7, yy + 3.5, lbl, { anchor: 'end', size: 10, mono: true }, pal.ink));
    }
    g.push(`<rect x="${n(x0)}" y="${n(top)}" width="${n(plotW)}" height="${n(bot - top)}" fill="none" stroke="${pal.ink}" stroke-width="1"/>`);
    g.push(
      `<text x="${n(x0 - 54)}" y="${n((top + bot) / 2)}" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${pal.ink}" transform="rotate(-90 ${n(x0 - 54)} ${n((top + bot) / 2)})">${escapeXml(axisTitle)}</text>`,
    );
    let previous: number | null = null;
    let d = '';
    for (const point of pts) {
      const value = pick(point);
      if (!point.accepted || !finiteNum(value)) {
        previous = null;
        continue;
      }
      const move = previous === null || (wrapPhase && Math.abs(value - previous) > 180);
      d += `${move ? 'M' : 'L'}${n(mapF(point.frequencyHz))} ${n(map(value))}`;
      previous = value;
    }
    if (d.includes('L')) {
      g.push(`<path d="${d}" fill="none" stroke="${pal.ink}" stroke-width="1.6" stroke-linejoin="round"/>`);
    }
    for (const p of pts) {
      const v = pick(p);
      if (!finiteNum(v)) continue;
      const cx = mapF(p.frequencyHz);
      const cy = Math.min(bot, Math.max(top, map(v)));
      if (p.accepted) g.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="3" fill="${pal.ink}"/>`);
      else g.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="3.2" fill="${pal.paper}" stroke="${pal.muted}" stroke-width="1.2"/>`);
    }
    g.push('</g>');
    return g.join('');
  };

  out.push(panel('Gain plot', t.gainAxis, gTop, gBot, gR, mapG, (p) => p.gainDb));
  out.push(panel('Phase plot', t.phaseAxis, pTop, pBot, pR, mapP, (p) => p.phaseDeg, true));

  const axis: string[] = [];
  for (let d = dMin; d <= dMax; d++) {
    const xx = mapF(10 ** d);
    axis.push(line(xx, pBot, xx, pBot + 4, pal.ink, 1));
    axis.push(line(xx, gBot, xx, gBot + 4, pal.ink, 1));
    const lbl = formatEng(10 ** d, 'Hz', locale, { sig: 3, trim: true });
    axis.push(text(xx, pBot + 16, lbl, { anchor: 'middle', size: 10, mono: true }, pal.ink));
    axis.push(text(xx, gBot + 16, lbl, { anchor: 'middle', size: 10, mono: true, fill: pal.muted }, pal.ink));
  }
  axis.push(text((x0 + x1) / 2, pBot + 30, t.frequencyAxis, { anchor: 'middle', size: 11 }, pal.ink));
  out.push(`<g aria-label="frequency axis">${axis.join('')}</g>`);

  if (pts.length === 0) {
    out.push(text((x0 + x1) / 2, (gTop + gBot) / 2, t.noPoints, { anchor: 'middle', size: 13, fill: pal.muted }, pal.ink));
  }

  if (cutoffs.length) {
    const c: string[] = ['<g aria-label="cutoff">'];
    if (finiteNum(result.cutoffTargetDb)) {
      const yy = mapG(result.cutoffTargetDb);
      c.push(line(x0, yy, x1, yy, pal.muted, 1, '1 2'));
      c.push(text(x1 - 4, yy - 4, `${MINUS}3 dB`, { anchor: 'end', size: 10, mono: true, fill: pal.muted }, pal.ink));
    }
    for (const [i, frequency] of cutoffs.entries()) {
      const cx = mapF(frequency);
      c.push(line(cx, gTop, cx, pBot, pal.ink, 1, '4 3'));
      const label = `${cutoffs.length === 1 ? 'fc' : `fc${i + 1}`} = ${formatEng(frequency, 'Hz', locale, { sig: 4, trim: true })}`;
      const rightSide = cx < x1 - 120;
      const lx = rightSide ? cx + 6 : cx - 6;
      c.push(`<rect x="${n(rightSide ? lx - 2 : lx - 112)}" y="${n(gTop + 6 + i * 18)}" width="114" height="16" fill="${pal.paper}"/>`);
      c.push(text(lx, gTop + 18 + i * 18, label, { anchor: rightSide ? 'start' : 'end', size: 11, mono: true, weight: 600 }, pal.ink));
    }
    c.push('</g>');
    out.push(c.join(''));
  }

  if (options.showLegend !== false) {
    const ly = pBot + axisH + 22;
    const lg: string[] = ['<g aria-label="legend">'];
    lg.push(line(x0, ly - 4, x0 + 24, ly - 4, pal.ink, 1.6));
    lg.push(`<circle cx="${n(x0 + 12)}" cy="${n(ly - 4)}" r="3" fill="${pal.ink}"/>`);
    lg.push(text(x0 + 32, ly, t.acceptedKey, { size: 11 }, pal.ink));
    const rx = x0 + 260;
    lg.push(`<circle cx="${n(rx + 12)}" cy="${n(ly - 4)}" r="3.2" fill="${pal.paper}" stroke="${pal.muted}" stroke-width="1.2"/>`);
    lg.push(text(rx + 24, ly, t.rejectedKey, { size: 11 }, pal.ink));
    if (finiteNum(result.passbandGainDb)) {
      lg.push(
        text(x1, ly, `${t.passband} ${svgMinus(formatEng(result.passbandGainDb, 'dB', locale))}`, { anchor: 'end', size: 11, mono: true }, pal.ink),
      );
    }
    lg.push(text(x0, ly + 18, `Graticule v${GRATICULE_VERSION}`, { size: 9, fill: pal.soft }, pal.ink));
    lg.push('</g>');
    out.push(lg.join(''));
  }

  out.push('</svg>');
  return out.join('');
}

export interface OverlayOptions {
  readonly showGrid?: boolean;
  readonly showGaps?: boolean;
}

/**
 * Pixel accurate overlay in the coordinate space of the original capture.
 * viewBox equals the image size so it can sit exactly on top of the screenshot.
 */
export function renderOverlaySvg(result: ExtractionResult, options: OverlayOptions = {}): string {
  const { sourceQuad, sourceWidth, sourceHeight } = result;
  const projected = Boolean(sourceQuad && sourceWidth && sourceHeight);
  const w = projected ? sourceWidth : result.imageWidth;
  const h = projected ? sourceHeight : result.imageHeight;
  const g = result.detection.grid;
  const size = { width: result.imageWidth, height: result.imageHeight };
  const at = (x: number, y: number) => projected && sourceQuad ? projectRectToQuad({ x, y }, sourceQuad, size) : { x, y };
  const xy = (x: number, y: number) => {
    const point = at(x, y);
    return `${n(point.x)} ${n(point.y)}`;
  };
  const region = (left: number, right: number) => projected
    ? `polygon points="${xy(left, g.top)} ${xy(right, g.top)} ${xy(right, g.bottom)} ${xy(left, g.bottom)}"`
    : `rect x="${n(left)}" y="${n(g.top)}" width="${n(right - left)}" height="${n(g.height)}"`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true">`,
  ];
  if (options.showGrid ?? true) {
    const border = region(g.left, g.left + g.width);
    out.push(`<${border} fill="none" stroke="#ffffff" stroke-width="3" vector-effect="non-scaling-stroke"/>`);
    out.push(`<${border} fill="none" stroke="#000000" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>`);
  }
  for (const tr of result.traces) {
    if (!tr.settings.enabled) continue;
    const split = splitTrace(tr.samples);
    const shift = projected ? 0 : 0.5;
    const d = split.segments
      .map((seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${xy(p.xPx + shift, p.yPx + shift)}`).join(''))
      .join('');
    if (d) {
      out.push(`<path d="${d}" fill="none" stroke="#000000" stroke-width="3.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
      out.push(`<path d="${d}" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
    }
    if (options.showGaps ?? true) {
      for (const gap of split.gaps) {
        const a = gap.x0;
        const b = Math.max(gap.x1, gap.x0 + 1);
        out.push(`<${region(a, projected ? Math.min(b + 1, g.right) : b + 1)} fill="#ffffff" fill-opacity="0.09"/>`);
        const markY = gap.kind === 'clipped_high' ? g.top + 3 : g.bottom - 3;
        const start = at(a, markY);
        const end = at(projected ? Math.min(b + 1, g.right) : b + 1, markY);
        const mark = `x1="${n(start.x)}" y1="${n(start.y)}" x2="${n(end.x)}" y2="${n(end.y)}"`;
        out.push(`<line ${mark} stroke="#000000" stroke-width="3.5" vector-effect="non-scaling-stroke"/>`);
        out.push(`<line ${mark} stroke="#ffffff" stroke-width="1.5" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>`);
      }
    }
  }
  out.push('</svg>');
  return out.join('');
}
