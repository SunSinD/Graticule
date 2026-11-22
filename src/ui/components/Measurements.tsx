import type { BodeGateOptions, BodeResult, ChannelId, ChannelMeasurements, ExtractionResult, GapStatus, Locale } from '../../core/types';
import { formatMetric, metricValue } from '../../core/export/table';
import { metricLabel, toMetricKey } from '../../core/export/labels';
import type { MetricKey } from '../../core/export/labels';
import { EMPTY_CELL, METRIC_LABELS, ROW_LABELS, formatEng, formatPercent, gapLabel } from '../i18n';
import type { Dict, RowKey } from '../i18n';
import type { ChannelLabels } from '../history';

const ROWS: readonly RowKey[] = ['vpp', 'vmax', 'vmin', 'vavg', 'vrms', 'period', 'freq', 'duty', 'rise', 'fall', 'overshoot'];

function cellText(m: ChannelMeasurements, key: RowKey, locale: Locale): string {
  const value = metricValue(m, key);
  const text = formatMetric(value, key, '', locale);
  if (value === null || !Number.isFinite(value)) return text;
  if ((key === 'rise' && m.riseLimited) || (key === 'fall' && m.fallLimited)) return `< ${text}`;
  return text;
}
const GAP_KINDS: readonly Exclude<GapStatus, 'ok'>[] = [
  'clipped_high',
  'clipped_low',
  'masked_cursor',
  'masked_overlay',
  'overlap_ambiguous',
  'unresolved',
];

interface Props {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly result: ExtractionResult | null;
  readonly labels?: ChannelLabels | undefined;
}

export function MeasurementsPanel({ tx, locale, result, labels }: Props) {
  const enabled = new Set(result?.traces.filter((t) => t.settings.enabled).map((t) => t.channel) ?? []);
  const ms = result?.measurements.filter((m) => enabled.has(m.channel)) ?? [];
  const ph = result?.phaseC1ToC2 ?? null;
  const showPhase = ph !== null && enabled.has(ph.refChannel) && enabled.has(ph.targetChannel);

  return (
    <section>
      <h2>{tx.results}</h2>
      <div data-testid="measurement-summary" className="table-wrap">
        <table className="grid-table compact values">
          <thead>
            <tr>
              <th>{tx.quantity}</th>
              {ms.length === 0 ? <th className="r">{EMPTY_CELL}</th> : ms.map((m) => <th key={m.channel} className="r">{labels?.[m.channel]?.trim() || m.channel}</th>)}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((key) => (
              <tr key={key}>
                <th scope="row">{ROW_LABELS[locale][key]}</th>
                {ms.length === 0 ? (
                  <td className="r num">{EMPTY_CELL}</td>
                ) : (
                  ms.map((m) => (
                    <td key={m.channel} className="r num">
                      {cellText(m, key, locale)}
                    </td>
                  ))
                )}
              </tr>
            ))}
            <tr>
              <th scope="row">{tx.phaseRow}</th>
              {ms.length === 0 ? (
                <td className="r num">{EMPTY_CELL}</td>
              ) : (
                ms.map((m) => (
                  <td key={m.channel} className="r num">
                    {showPhase && ph && m.channel === ph.targetChannel ? formatEng(ph.phaseDeg, '°', locale) : EMPTY_CELL}
                  </td>
                ))
              )}
            </tr>
          </tbody>
        </table>
      </div>
      {result && <GapList tx={tx} locale={locale} result={result} />}
      {result && result.comparisons.length > 0 && <Comparison tx={tx} locale={locale} result={result} />}
    </section>
  );
}

function GapList({ tx, locale, result }: { readonly tx: Dict; readonly locale: Locale; readonly result: ExtractionResult }) {
  const lines: { ch: ChannelId; text: string }[] = [];
  for (const tr of result.traces) {
    if (!tr.settings.enabled) continue;
    const counts = new Map<GapStatus, number>();
    for (const s of tr.samples) if (s.status !== 'ok') counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    const parts = GAP_KINDS.filter((k) => counts.has(k)).map((k) => `${gapLabel(k, locale)} ${counts.get(k)}`);
    if (parts.length) lines.push({ ch: tr.channel, text: parts.join(', ') });
  }
  if (lines.length === 0) return null;
  return (
    <dl className="kv small">
      {lines.map((l) => (
        <div key={l.ch}>
          <dt>
            {tx.gaps} {l.ch}
          </dt>
          <dd>{l.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function Comparison({ tx, locale, result }: { readonly tx: Dict; readonly locale: Locale; readonly result: ExtractionResult }) {
  return (
    <div className="block">
      <h3>{tx.comparison}</h3>
      <div className="table-wrap">
        <table className="grid-table compact">
          <thead>
            <tr>
              <th />
              <th className="r">{tx.scope}</th>
              <th className="r">{tx.graticule}</th>
              <th className="r">{tx.delta}</th>
            </tr>
          </thead>
          <tbody>
            {result.comparisons.map((c, i) => {
              const key = toMetricKey(c.metric);
              const delta =
                c.delta === null
                  ? EMPTY_CELL
                  : key === 'duty'
                    ? formatPercent(c.delta, locale, 1, true)
                    : formatEng(c.delta, key ? (key === 'phase' ? '°' : unitFor(key)) : c.unit, locale, { sig: 3, signed: true });
              return (
                <tr key={`${c.metric}-${i}`}>
                  <th scope="row">
                    {c.channel ? `${c.channel} ` : ''}
                    {key ? shortLabel(key, locale) : metricLabel(c.metric, locale)}
                  </th>
                  <td className="r num">{formatMetric(c.scopeValue, key, c.unit, locale)}</td>
                  <td className="r num">{formatMetric(c.graticuleValue, key, c.unit, locale)}</td>
                  <td className="r num" title={c.deltaPct === null ? undefined : formatPercent(c.deltaPct, locale, 1, true)}>
                    {delta}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">{tx.comparisonNote}</p>
    </div>
  );
}

function unitFor(key: MetricKey): string {
  return key === 'period' ? 's' : key === 'freq' ? 'Hz' : key === 'duty' ? '%' : 'V';
}

function shortLabel(key: MetricKey, locale: Locale): string {
  const full = METRIC_LABELS[locale][key];
  const m = /\(([^)]+)\)$/.exec(full);
  return m?.[1] ?? full;
}

interface BodeProps {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly result: BodeResult | null;
  readonly gate: BodeGateOptions;
  readonly onGate: (gate: BodeGateOptions) => void;
}

const CHS: readonly ChannelId[] = ['C1', 'C2', 'C3', 'C4'];

export function BodeSummary({ tx, locale, result, gate, onGate }: BodeProps) {
  const input = gate.inputChannel ?? result?.inputChannel ?? 'C1';
  const output = gate.outputChannel ?? result?.outputChannel ?? 'C2';
  const sided = result != null && (result.cutoffLowHz != null || result.cutoffHighHz != null);
  return (
    <section>
      <h2>{tx.bodeSummary}</h2>
      <div className="row2">
        <label className="field">
          <span>{tx.inputChannel}</span>
          <select aria-label={tx.inputChannel} value={input} onChange={(e) => onGate({ ...gate, inputChannel: e.target.value as ChannelId })}>
            {CHS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{tx.outputChannel}</span>
          <select aria-label={tx.outputChannel} value={output} onChange={(e) => onGate({ ...gate, outputChannel: e.target.value as ChannelId })}>
            {CHS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <dl className="kv">
        <div>
          <dt>{tx.passband}</dt>
          <dd className="num">{formatEng(result?.passbandGainDb ?? null, 'dB', locale)}</dd>
        </div>
        {sided && result ? (
          <>
            {result.cutoffLowHz != null && (
              <div>
                <dt>{tx.cutoffLow}</dt>
                <dd className="num">{formatEng(result.cutoffLowHz, 'Hz', locale, { sig: 4 })}</dd>
              </div>
            )}
            {result.cutoffHighHz != null && (
              <div>
                <dt>{tx.cutoffHigh}</dt>
                <dd className="num">{formatEng(result.cutoffHighHz, 'Hz', locale, { sig: 4 })}</dd>
              </div>
            )}
          </>
        ) : (
          <div>
            <dt>{tx.cutoff}</dt>
            <dd className="num">
              {result?.cutoffHz != null ? formatEng(result.cutoffHz, 'Hz', locale, { sig: 4 }) : tx.noCutoff}
            </dd>
          </div>
        )}
        <div>
          <dt>
            {tx.acceptedCount} / {tx.rejectedCount}
          </dt>
          <dd className="num">
            {result ? `${result.acceptedCount} / ${result.rejectedCount}` : EMPTY_CELL}
          </dd>
        </div>
      </dl>
    </section>
  );
}
