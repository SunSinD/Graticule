import type { BodeResult, ChannelMeasurements, ExtractionResult, Locale } from '../types.js';
import { EMPTY_CELL, formatEng, formatFixed, formatPercent } from './format.js';
import { EXPORT_TEXT, METRIC_LABELS, METRIC_UNITS, metricLabel, reasonLabel, toMetricKey } from './labels.js';
import type { MetricKey } from './labels.js';
import { sortBodePoints } from './csv.js';

export type TableFormat = 'html' | 'markdown' | 'tsv';

interface Table {
  readonly caption: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly numericFrom: number;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function escapeTsv(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

const CELL = 'border:1px solid #000;padding:2pt 6pt;';
const HEAD = 'border:1px solid #000;padding:2pt 6pt;font-weight:bold;background:#e5e5e5;text-align:left;';
const TABLE = "border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#000;margin:0 0 8pt 0;";
const CAPTION = 'caption-side:top;text-align:left;font-weight:bold;padding:0 0 4pt 0;';

function renderHtml(tables: readonly Table[]): string {
  return tables
    .map((t) => {
      const head = t.head.map((h, i) => `<th style="${HEAD}${i >= t.numericFrom ? 'text-align:right;' : ''}">${escapeHtml(h)}</th>`).join('');
      const body = t.rows
        .map(
          (r) =>
            `<tr>${r
              .map((c, i) => `<td style="${CELL}${i >= t.numericFrom ? 'text-align:right;font-variant-numeric:tabular-nums;' : ''}">${escapeHtml(c)}</td>`)
              .join('')}</tr>`,
        )
        .join('');
      return `<table style="${TABLE}"><caption style="${CAPTION}">${escapeHtml(t.caption)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    })
    .join('\n');
}

function renderMarkdown(tables: readonly Table[]): string {
  return tables
    .map((t) => {
      const lines = [`**${escapeMarkdown(t.caption)}**`, ''];
      lines.push(`| ${t.head.map(escapeMarkdown).join(' | ')} |`);
      lines.push(`|${t.head.map((_, i) => (i >= t.numericFrom ? ' ---: ' : ' --- ')).join('|')}|`);
      for (const r of t.rows) lines.push(`| ${r.map(escapeMarkdown).join(' | ')} |`);
      return lines.join('\n');
    })
    .join('\n\n') + '\n';
}

function renderTsv(tables: readonly Table[]): string {
  return tables
    .map((t) => [escapeTsv(t.caption), t.head.map(escapeTsv).join('\t'), ...t.rows.map((r) => r.map(escapeTsv).join('\t'))].join('\n'))
    .join('\n\n') + '\n';
}

function render(tables: readonly Table[], format: TableFormat): string {
  if (format === 'html') return renderHtml(tables);
  if (format === 'markdown') return renderMarkdown(tables);
  return renderTsv(tables);
}

const MEASURE_ROWS: readonly MetricKey[] = ['vpp', 'vmax', 'vmin', 'vavg', 'vrms', 'period', 'freq', 'duty'];

export function metricValue(m: ChannelMeasurements, key: MetricKey): number | null {
  switch (key) {
    case 'vpp':
      return m.vpp;
    case 'vmax':
      return m.vmax;
    case 'vmin':
      return m.vmin;
    case 'vavg':
      return m.vavg;
    case 'vrms':
      return m.vrms;
    case 'period':
      return m.periodSec;
    case 'freq':
      return m.frequencyHz;
    case 'duty':
      return m.dutyCyclePct;
    default:
      return null;
  }
}

export function formatMetric(value: number | null, key: MetricKey | null, unit: string, locale: Locale): string {
  if (key === 'duty') return formatPercent(value, locale);
  if (key === 'phase') return formatEng(value, '\u00b0', locale);
  return formatEng(value, key ? METRIC_UNITS[key] : unit, locale, { sig: 4 });
}

function deltaText(value: number | null, key: MetricKey | null, unit: string, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_CELL;
  if (key === 'duty') return formatPercent(value, locale, 1, true);
  if (key === 'phase') return formatEng(value, '\u00b0', locale, { signed: true });
  return formatEng(value, key ? METRIC_UNITS[key] : unit, locale, { sig: 3, signed: true });
}

export function measurementTables(result: ExtractionResult, locale: Locale): Table[] {
  const tx = EXPORT_TEXT[locale];
  const enabled = new Set(result.traces.filter((t) => t.settings.enabled).map((t) => t.channel));
  const ms = result.measurements.filter((m) => enabled.has(m.channel));
  const tables: Table[] = [];

  const head = [tx.measurement, ...ms.map((m) => (m.clipped ? `${m.channel} (${tx.clipped})` : m.channel))];
  const rows: string[][] = MEASURE_ROWS.map((key) => [
    METRIC_LABELS[locale][key],
    ...ms.map((m) => formatMetric(metricValue(m, key), key, '', locale)),
  ]);
  const ph = result.phaseC1ToC2;
  if (ph && enabled.has(ph.refChannel) && enabled.has(ph.targetChannel)) {
    const row = [`${METRIC_LABELS[locale].phase} ${ph.refChannel}\u2192${ph.targetChannel}`];
    for (const m of ms) row.push(m.channel === ph.targetChannel ? formatMetric(ph.phaseDeg, 'phase', '\u00b0', locale) : EMPTY_CELL);
    rows.push(row);
  }
  tables.push({ caption: `${tx.measurementsCaption} ${result.fileName}`, head, rows, numericFrom: 1 });

  if (result.comparisons.length > 0) {
    const cRows = result.comparisons.map((c) => {
      const key = toMetricKey(c.metric);
      return [
        c.channel ?? EMPTY_CELL,
        metricLabel(c.metric, locale),
        formatMetric(c.scopeValue, key, c.unit, locale),
        formatMetric(c.graticuleValue, key, c.unit, locale),
        deltaText(c.delta, key, c.unit, locale),
        formatPercent(c.deltaPct, locale, 1, true),
      ];
    });
    tables.push({
      caption: tx.comparisonCaption,
      head: [tx.channel, tx.measurement, tx.scope, tx.graticule, tx.delta, tx.deltaPct],
      rows: cRows,
      numericFrom: 2,
    });
  }
  return tables;
}

export function renderMeasurementsTable(result: ExtractionResult, format: TableFormat, locale: Locale): string {
  return render(measurementTables(result, locale), format);
}

function plainNumber(value: number | null, digits: number, locale: Locale): string {
  if (value === null || !Number.isFinite(value)) return EMPTY_CELL;
  return formatFixed(value, digits, locale);
}

export function renderBodeTable(result: BodeResult, format: TableFormat, locale: Locale): string {
  const tx = EXPORT_TEXT[locale];
  const summary: Table = {
    caption: tx.bodeSummaryCaption,
    head: [tx.parameter, tx.value],
    rows: [
      [tx.inputOutput, `${result.inputChannel} / ${result.outputChannel}`],
      [tx.passbandGain, formatEng(result.passbandGainDb, 'dB', locale)],
      [tx.cutoffTarget, formatEng(result.cutoffTargetDb, 'dB', locale)],
      [tx.cutoff, result.cutoffHz !== null && Number.isFinite(result.cutoffHz) ? formatEng(result.cutoffHz, 'Hz', locale, { sig: 4 }) : tx.noCutoff],
      [tx.pointCounts, `${result.acceptedCount} / ${result.rejectedCount}`],
    ],
    numericFrom: 1,
  };
  const points: Table = {
    caption: tx.bodeCaption,
    head: [tx.file, tx.frequency, tx.vin, tx.vout, tx.gain, tx.phase, tx.status, tx.reasons],
    rows: sortBodePoints(result.points).map((p) => [
      p.edited ? `${p.fileName} (${tx.edited})` : p.fileName,
      formatEng(p.frequencyHz, 'Hz', locale, { sig: 4 }),
      formatEng(p.vinVpp, 'V', locale, { sig: 4 }),
      formatEng(p.voutVpp, 'V', locale, { sig: 4 }),
      plainNumber(p.gainDb, 2, locale),
      plainNumber(p.phaseDeg, 1, locale),
      p.accepted ? tx.accepted : tx.rejected,
      p.rejectionReasons.length ? p.rejectionReasons.map((r) => reasonLabel(r, locale)).join(', ') : EMPTY_CELL,
    ]),
    numericFrom: 1,
  };
  return render([summary, points], format);
}
