import type { BodePoint, BodeResult, ChannelId, ChannelTrace, ExtractionResult, MathTraceResult, TraceSample } from '../types.js';
import { GRATICULE_VERSION, csvNumber, spreadsheetText } from './format.js';

const EOL = '\n';

export function csvComment(text: string): string {
  return spreadsheetText(text).replace(/,(?=[^\S\t\r]*(?:"[^\S\t\r]*)?[=+\-@\t\r])/g, ",'")
    .replace(/[\r\n]+/g, ' ').trim();
}

export function csvField(text: string): string {
  const safe = spreadsheetText(text);
  return /^#|[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function channelComment(trace: ChannelTrace): string {
  const s = trace.settings;
  return [
    `# ${s.channel}:`,
    `v_per_div=${csvNumber(s.voltsPerDiv)}`,
    `offset_v=${csvNumber(s.offsetVolts)}`,
    `probe=${csvNumber(s.probeAttenuation)}x`,
    `coupling=${s.coupling}`,
    `scale_source=${s.scaleSource}`,
    `valid=${trace.validCount}`,
    `clipped=${trace.clippedCount}`,
    `masked=${trace.maskedCount}`,
    `overlap=${trace.overlapCount}`,
    `unresolved=${trace.unresolvedCount}`,
  ].join(' ');
}

export function renderWaveformCsv(result: ExtractionResult, channelLabels?: Partial<Record<ChannelId, string>>, title?: string,
  math?: MathTraceResult | null): string {
  const traces = result.traces.filter((t) => t.settings.enabled);
  const tb = result.timebase;
  const grid = result.detection.grid;
  const lines: string[] = [
    `# Graticule v${GRATICULE_VERSION}`,
    `# file: ${csvComment(result.fileName)}`,
    ...(title?.trim() ? [`# title: ${csvComment(title)}`] : []),
    `# profile: ${csvComment(result.detection.profileName)} (${result.detection.profileId})`,
    `# grid: ${grid.hDivs} x ${grid.vDivs} div, layout ${grid.layoutVariant}`,
    `# time_per_div_s: ${csvNumber(tb.secPerDiv)} (${tb.source})`,
    `# trigger_offset_s: ${csvNumber(tb.triggerOffsetSec)}`,
  ];
  if (result.topFrequencyHz !== null) lines.push(`# scope_frequency_hz: ${csvNumber(result.topFrequencyHz)}`);
  for (const t of traces) {
    lines.push(channelComment(t));
    const label = channelLabels?.[t.channel];
    if (label?.trim()) lines.push(`# ${t.channel} label: ${csvComment(label)}`);
    const m = result.measurements.find(measurement => measurement.channel === t.channel);
    if (m) lines.push([
      `# ${t.channel} edge measurements:`,
      `rise_time_s=${csvNumber(m.riseTimeSec)}`,
      `fall_time_s=${csvNumber(m.fallTimeSec)}`,
      `overshoot_pct=${csvNumber(m.overshootPct)}`,
      `rise_limited=${m.riseLimited ?? false}`,
      `fall_limited=${m.fallLimited ?? false}`,
    ].join(' '));
  }
  if (math) lines.push(`# M: ${csvComment(math.label)} ${math.config.a} ${math.config.op} ${math.config.b} unit=${math.unit}`
    + ` scale_per_div=${csvNumber(math.voltsPerDiv)} offset=${csvNumber(math.offsetVolts)} warnings=${math.warnings.join('|')}`);
  lines.push('# a blank voltage cell means no trustworthy data at that time, see the status column');

  const header = ['time_s'];
  for (const t of traces) {
    const label = channelLabels?.[t.channel];
    const id = label?.trim() ? (spreadsheetText(label) === label ? label.trim() : label.trimEnd()) : t.channel.toLowerCase();
    header.push(csvField(`${id}_v`), csvField(`${id}_status`));
  }
  if (math) header.push(math.unit === 'V²' ? 'm_v2' : 'm_v', 'm_status');
  lines.push(header.join(','));

  const series = math ? [...traces.map(t => t.samples), math.samples] : traces.map(t => t.samples);
  const byCol = series.map(samples => new Map<number, TraceSample>(samples.map(s => [s.col, s])));
  const cols = new Set<number>();
  for (const samples of series) for (const s of samples) cols.add(s.col);
  const sortedCols = [...cols].sort((a, b) => a - b);

  for (const col of sortedCols) {
    let time: number | null = null;
    for (const m of byCol) {
      const s = m.get(col);
      if (s && Number.isFinite(s.timeSec)) {
        time = s.timeSec;
        break;
      }
    }
    const row = [csvNumber(time)];
    for (const m of byCol) {
      const s = m.get(col);
      if (!s) {
        row.push('', 'unresolved');
        continue;
      }
      const usable = s.status === 'ok' && s.voltage !== null && Number.isFinite(s.voltage);
      row.push(usable ? csvNumber(s.voltage, 6) : '', s.status);
    }
    lines.push(row.join(','));
  }
  return lines.join(EOL) + EOL;
}

export function sortBodePoints(points: readonly BodePoint[]): BodePoint[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const fa = a.p.frequencyHz;
      const fb = b.p.frequencyHz;
      const va = fa !== null && Number.isFinite(fa);
      const vb = fb !== null && Number.isFinite(fb);
      if (va && vb && fa !== fb) return (fa as number) - (fb as number);
      if (va !== vb) return va ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.p);
}

export function renderBodeCsv(result: BodeResult, title?: string): string {
  const lines: string[] = [
    `# Graticule v${GRATICULE_VERSION}`,
    ...(title?.trim() ? [`# title: ${csvComment(title)}`] : []),
    `# input_channel: ${result.inputChannel}`,
    `# output_channel: ${result.outputChannel}`,
    `# passband_gain_db: ${csvNumber(result.passbandGainDb, 6)}`,
    `# cutoff_target_db: ${csvNumber(result.cutoffTargetDb, 6)}`,
    `# cutoff_hz_minus_3db: ${csvNumber(result.cutoffHz, 6)}`,
    ...(result.cutoffLowHz == null ? [] : [`# cutoff_low_hz_minus_3db: ${csvNumber(result.cutoffLowHz, 6)}`]),
    ...(result.cutoffHighHz == null ? [] : [`# cutoff_high_hz_minus_3db: ${csvNumber(result.cutoffHighHz, 6)}`]),
    `# accepted: ${result.acceptedCount}`,
    `# rejected: ${result.rejectedCount}`,
    'file,frequency_hz,vin_vpp,vout_vpp,gain_db,phase_deg,cycles,r2_in,r2_out,accepted,reasons,warnings',
  ];
  for (const p of sortBodePoints(result.points)) {
    lines.push(
      [
        csvField(p.fileName),
        csvNumber(p.frequencyHz, 6),
        csvNumber(p.vinVpp, 6),
        csvNumber(p.voutVpp, 6),
        csvNumber(p.gainDb, 6),
        csvNumber(p.phaseDeg, 6),
        csvNumber(p.cycles, 6),
        csvNumber(p.r2In, 6),
        csvNumber(p.r2Out, 6),
        p.accepted ? 'true' : 'false',
        csvField(p.rejectionReasons.join(' | ')),
        csvField(p.warnings.join(' | ')),
      ].join(','),
    );
  }
  return lines.join(EOL) + EOL;
}
