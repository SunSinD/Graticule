import type {
  BodeGateOptions,
  BodeResult,
  ChannelId,
  ChannelMeasurements,
  ExtractionResult,
  GapStatus,
  Locale,
  MathTraceResult,
} from '../../core/types';
import type { SpectrumResult } from '../../core/spectrum';
import type { XyResult } from '../../core/xy';
import { formatMetric, metricValue } from '../../core/export/table';
import { METRIC_UNITS, metricLabel, toMetricKey } from '../../core/export/labels';
import type { MetricKey } from '../../core/export/labels';
import { EMPTY_CELL, METRIC_LABELS, ROW_LABELS, formatEng, formatFixed, formatPercent, gapLabel } from '../i18n';
import type { Dict, RowKey } from '../i18n';
import type { ChannelLabels } from '../history';

const ROWS: readonly RowKey[] = ['vpp', 'vmax', 'vmin', 'vavg', 'vrms', 'period', 'freq', 'duty', 'rise', 'fall', 'overshoot'];

function hasValue(m: ChannelMeasurements, key: RowKey): boolean {
  const value = metricValue(m, key);
  return value !== null && Number.isFinite(value);
}

function cellText(m: ChannelMeasurements, key: RowKey, locale: Locale): string {
  const value = metricValue(m, key);
  const text = formatMetric(value, key, '', locale);
  if (value === null || !Number.isFinite(value)) return text;
  if ((key === 'rise' && m.riseLimited) || (key === 'fall' && m.fallLimited)) return `< ${text}`;
  return text;
}

const SIGNED_ROWS: ReadonlySet<RowKey> = new Set(['vmax', 'vmin', 'vavg']);

function mathText(math: MathTraceResult, key: RowKey, locale: Locale): string {
  const m = math.measurement;
  const value = metricValue(m, key);
  const text =
    METRIC_UNITS[key] === 'V'
      ? formatEng(value, math.unit, locale, { sig: 3, signed: SIGNED_ROWS.has(key) })
      : formatMetric(value, key, '', locale);
  if (value === null || !Number.isFinite(value)) return text;
  if ((key === 'rise' && m.riseLimited) || (key === 'fall' && m.fallLimited)) return `< ${text}`;
  return text;
}

interface PhaseRow {
  readonly from: ChannelId;
  readonly to: ChannelId;
  readonly deg: number;
}

function phaseRow(result: ExtractionResult | null, enabled: ReadonlySet<ChannelId>): PhaseRow | null {
  if (!result) return null;
  const legacy = result.phaseC1ToC2;
  const ph =
    legacy?.phaseDeg != null
      ? { from: legacy.refChannel, to: legacy.targetChannel, deg: legacy.phaseDeg }
      : result.phasePair
        ? { from: result.phasePair.from, to: result.phasePair.to, deg: result.phasePair.phaseDeg }
        : null;
  return ph && Number.isFinite(ph.deg) && enabled.has(ph.from) && enabled.has(ph.to) ? ph : null;
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
  readonly math?: MathTraceResult | null;
  readonly xy?: XyResult | null;
  readonly spectrum?: SpectrumResult | null;
  readonly axisLabel?: (axis: string) => string;
}

export function MeasurementsPanel({ tx, locale, result, labels, math = null, xy = null, spectrum = null, axisLabel }: Props) {
  const enabled = new Set(result?.traces.filter((t) => t.settings.enabled).map((t) => t.channel) ?? []);
  const ms = result?.measurements.filter((m) => enabled.has(m.channel)) ?? [];
  const ph = phaseRow(result, enabled);
  const label = (ch: ChannelId) => labels?.[ch]?.trim() || ch;
  const rows = ROWS.filter((key) => ms.some((m) => hasValue(m, key)) || (math !== null && hasValue(math.measurement, key)));
  const name = axisLabel ?? ((axis: string) => axis);

  return (
    <section>
      <h2>{tx.results}</h2>
      {xy && <XyBlock tx={tx} locale={locale} xy={xy} name={name} />}
      {spectrum && <SpectrumBlock tx={tx} locale={locale} spec={spectrum} name={name} />}
      <div data-testid="measurement-summary" className="table-wrap">
        {!result ? (
          <p className="muted small">{tx.notExtracted}</p>
        ) : (
          <table className="grid-table compact values">
            <thead>
              <tr>
                <th>{tx.quantity}</th>
                {ms.map((m) => (
                  <th key={m.channel} className="r">
                    {label(m.channel)}
                  </th>
                ))}
                {math && <th className="r">{math.label}</th>}
                {ms.length === 0 && !math && <th className="r">{EMPTY_CELL}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((key) => (
                <tr key={key}>
                  <th scope="row">{ROW_LABELS[locale][key]}</th>
                  {ms.map((m) => (
                    <td key={m.channel} className="r num">
                      {cellText(m, key, locale)}
                    </td>
                  ))}
                  {math && <td className="r num">{mathText(math, key, locale)}</td>}
                </tr>
              ))}
              {ph && (
                <tr>
                  <th scope="row">
                    {tx.phase} {label(ph.from)}→{label(ph.to)}
                  </th>
                  {ms.map((m) => (
                    <td key={m.channel} className="r num">
                      {m.channel === ph.to ? formatEng(ph.deg, '°', locale, { signed: true }) : EMPTY_CELL}
                    </td>
                  ))}
                  {math && <td className="r num">{EMPTY_CELL}</td>}
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
      {result && <GapList tx={tx} locale={locale} result={result} />}
      {result && result.comparisons.length > 0 && <Comparison tx={tx} locale={locale} result={result} />}
    </section>
  );
}

function XyBlock({ tx, locale, xy, name }: { tx: Dict; locale: Locale; xy: XyResult; name: (axis: string) => string }) {
  const range = (lo: number | null, hi: number | null, unit: string) =>
    lo === null || hi === null ? EMPTY_CELL : `${formatEng(lo, unit, locale, { sig: 3 })} … ${formatEng(hi, unit, locale, { sig: 3 })}`;
  const h = xy.hysteresis;
  return (
    <div className="block-top" data-testid="xy-summary">
      <h3>
        {tx.xyResults} {name(xy.xAxis)} / {name(xy.yAxis)}
      </h3>
      <dl className="kv small">
        <div>
          <dt>{tx.xRange}</dt>
          <dd>{range(xy.xMin, xy.xMax, xy.xUnit)}</dd>
        </div>
        <div>
          <dt>{tx.yRange}</dt>
          <dd>{range(xy.yMin, xy.yMax, xy.yUnit)}</dd>
        </div>
        {xy.lissajousPhaseDeg !== null && (
          <div>
            <dt>{tx.lissajous}</dt>
            <dd>{formatEng(xy.lissajousPhaseDeg, '°', locale, { signed: true })}</dd>
          </div>
        )}
        {h && (
          <>
            <div>
              <dt>{tx.hystLow}</dt>
              <dd>{formatEng(h.lowThresholdV, xy.xUnit, locale, { sig: 3 })}</dd>
            </div>
            <div>
              <dt>{tx.hystHigh}</dt>
              <dd>{formatEng(h.highThresholdV, xy.xUnit, locale, { sig: 3 })}</dd>
            </div>
            <div>
              <dt>
                {tx.hysteresis} ({tx.hystWidth.toLowerCase()})
              </dt>
              <dd>{formatEng(h.widthV, xy.xUnit, locale, { sig: 3 })}</dd>
            </div>
          </>
        )}
      </dl>
      {xy.gapCount > 0 && <p className="muted small">{tx.xyGaps(xy.gapCount)}</p>}
      {(xy.clippedX || xy.clippedY) && <p className="muted small">{tx.xyClipped}</p>}
    </div>
  );
}

function SpectrumBlock({ tx, locale, spec, name }: { tx: Dict; locale: Locale; spec: SpectrumResult; name: (axis: string) => string }) {
  const thd =
    spec.thdPct === null
      ? tx.thdReasons[spec.thdReason ?? ''] ?? EMPTY_CELL
      : spec.thdBelowFloor
        ? tx.thdBelow
        : `${formatFixed(spec.thdPct, 2, locale)}%`;
  const harmonics = spec.harmonics.filter((h) => h.order >= 2 && h.order <= 5);
  return (
    <div className="block-top" data-testid="fft-summary">
      <h3>
        {tx.fftResults} {name(spec.channel)}
      </h3>
      <dl className="kv small">
        <div>
          <dt>{tx.fundamental}</dt>
          <dd>{spec.fundamental ? formatEng(spec.fundamental.frequencyHz, 'Hz', locale, { sig: 4 }) : EMPTY_CELL}</dd>
        </div>
        <div>
          <dt>{tx.thd}</dt>
          <dd>{thd}</dd>
        </div>
        {harmonics.map((h) => (
          <div key={h.order}>
            <dt>H{h.order}</dt>
            <dd>{h.dbc === null ? EMPTY_CELL : `${formatFixed(h.dbc, 1, locale)} dBc`}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">{tx.noiseNote}</p>
    </div>
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
              {result?.cutoffHz != null ? formatEng(result.cutoffHz, 'Hz', locale, { sig: 4 }) : result ? tx.noCutoff : EMPTY_CELL}
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
