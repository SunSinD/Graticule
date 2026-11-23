import { formatEng } from './format.js';
import type { Locale, PlotTheme } from '../types.js';

export interface AnalysisPlotOptions {
  readonly title?: string;
  readonly locale?: Locale;
  readonly theme?: PlotTheme;
  readonly width?: number;
  readonly height?: number;
}

export const xml = (str: string) => str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]!);
export const point = (value: number) => Number(value.toFixed(3));

export function analysisPlot(options: AnalysisPlotOptions, title: string, square: boolean,
  xLabel: string, yLabel: string, xTick: (f: number) => string, yTick: (f: number) => string,
  draw: (x: (f: number) => number, y: (f: number) => number, ink: string) => string): string {
  const size = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.max(240, value!) : fallback;
  const width = size(options.width, square ? 620 : 880), height = size(options.height, square ? 590 : 450);
  const paper = options.theme === 'dark' ? '#111' : '#fff', ink = options.theme === 'dark' ? '#eee' : '#111';
  let w = width - 108, h = height - 106;
  if (square) w = h = Math.min(w, h);
  const x = (f: number) => point(82 + (width - 108 - w) / 2 + f * w);
  const y = (f: number) => point(44 + (height - 106 - h) / 2 + (1 - f) * h);
  const text = (s: string, xx: number, yy: number, anchor = 'middle') =>
    `<text x="${xx}" y="${yy}" text-anchor="${anchor}">${xml(s)}</text>`;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">`,
    `<rect width="100%" height="100%" fill="${paper}"/><g fill="${ink}" font-family="system-ui,sans-serif" font-size="11">`,
    text(title, x(0), 24, 'start')];
  for (let i = 0; i <= 8; i++) {
    const f = i / 8;
    out.push(`<path d="M${x(f)} ${y(0)}V${y(1)} M${x(0)} ${y(f)}H${x(1)}" fill="none" stroke="${ink}" stroke-opacity="${i === 0 || i === 8 ? 0.85 : 0.18}"/>`);
    if (i % 2 === 0 || w >= 450) out.push(text(xTick(f), x(f), y(0) + 17));
    out.push(text(yTick(f), x(0) - 8, y(f) + 4, 'end'));
  }
  out.push(text(xLabel, x(0.5), y(0) + 39),
    `<text transform="translate(${x(0) - 69} ${y(0.5)}) rotate(-90)" text-anchor="middle">${xml(yLabel)}</text></g>`,
    `<defs><clipPath id="analysis-plot-clip"><rect x="${x(0)}" y="${y(1)}" width="${w}" height="${h}"/></clipPath></defs>`,
    draw(x, y, ink), '</svg>');
  return out.join('');
}

export const axisValue = (value: number, unit: string, locale: Locale) => formatEng(value, unit, locale, { sig: 3, trim: true });
