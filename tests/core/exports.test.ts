import { describe, expect, test } from 'vitest';
import { renderWaveformCsv } from '../../src/core/export/csv.js';
import { GRATICULE_VERSION, parseEngineering } from '../../src/core/export/format.js';
import { renderWaveformSvg, waveformFrame } from '../../src/core/export/svg.js';
import { renderMeasurementsTable } from '../../src/core/export/table.js';
import { analyzePngBytes } from '../../src/core/pipeline.js';
import type { SvgExportOptions } from '../../src/core/types.js';
import { sample } from './fixtures.js';

const result = analyzePngBytes(sample('sine_schmitt.png'), 'Capture_A&B%#_1.png');

describe('waveform exports', () => {
  test('formats engineering scales with optional units per division and rejects overflow', () => {
    expect(GRATICULE_VERSION).toBe('1.1.0');
    expect(parseEngineering('5 mV/div')).toBe(0.005);
    expect(parseEngineering('2,5 ms / div')).toBe(0.0025);
    expect(parseEngineering('2/div')).toBe(2);
    expect(parseEngineering('1e308G')).toBeNull();
    expect(parseEngineering('1e309')).toBeNull();
    expect(parseEngineering('3 GigaVolts')).toBeNull();
  });

  test('places cursor lines in the same frame as the waveform axes and includes calibrated deltas', () => {
    const options: SvgExportOptions = {
      width: 720, theme: 'dark', cursors: { x1: 0.25, x2: 0.75, y1: 0.25, y2: 0.75, channel: 'C2' },
      channelLabels: { C1: 'Vin <in>', C2: 'Vout & ref' },
    };
    const frame = waveformFrame(result, options);
    const svg = renderWaveformSvg(result, options);
    const n = (v: number) => Math.round(v * 100) / 100;
    const x = n(frame.x0 + frame.plotW * 0.25);
    const y = n(frame.y0 + frame.plotH * 0.75);
    expect(svg).toContain('viewBox="0 0 ' + frame.width + ' ' + frame.height + '"');
    expect(svg).toContain('x1="' + x + '" y1="' + n(frame.y0) + '" x2="' + x + '" y2="' + n(frame.y1) + '"');
    expect(svg).toContain('x1="' + n(frame.x0) + '" y1="' + y + '" x2="' + n(frame.x1) + '" y2="' + y + '"');
    expect(svg).toContain('stroke-dasharray="5 3"');
    expect(svg).toContain('stroke-dasharray="1 3"');
    expect(svg).toMatch(/Δt .*1\/Δt .*ΔV /);
    expect(svg).toContain('Vin &lt;in&gt;');
    expect(svg).toContain('Vout &amp; ref');
    expect(frame.timeAt(0.75) - frame.timeAt(0.25)).toBeCloseTo(result.timebase.secPerDiv * 5, 12);
    const c2 = result.traces.find(trace => trace.channel === 'C2')!;
    expect(frame.voltAt('C2', 0.25)! - frame.voltAt('C2', 0.75)!).toBeCloseTo(c2.settings.voltsPerDiv * 4, 12);
    expect(frame.voltAt('C4', 0)).toBeNull();
  });

  test('exports edge measurements and custom labels in CSV, English and French tables, and escaped LaTeX', () => {
    const measured = { ...result, measurements: result.measurements.map(m => ({
      ...m, riseTimeSec: 1e-6, fallTimeSec: 2e-6, overshootPct: 12, riseLimited: true, fallLimited: false,
    })) };
    const channelLabels = { C1: 'Vin, "A&B_1"', C2: 'Vo|2' };
    const csv = renderWaveformCsv(measured, channelLabels);
    expect(csv).toContain('time_s,"Vin, ""A&B_1""_v","Vin, ""A&B_1""_status",Vo|2_v,Vo|2_status');
    expect(csv).toContain('rise_time_s=0.000001 fall_time_s=0.000002 overshoot_pct=12 rise_limited=true fall_limited=false');
    expect(renderMeasurementsTable(measured, 'markdown', 'en', channelLabels)).toContain('Vo\\|2');
    expect(renderMeasurementsTable(measured, 'tsv', 'en')).toContain('Rise time (10–90%)\t≤ 1.000 µs');
    expect(renderMeasurementsTable(measured, 'html', 'fr', channelLabels)).toContain('Temps de descente (90–10%)');
    const latex = renderMeasurementsTable(measured, 'latex', 'fr', channelLabels);
    expect(latex).toContain('\\begin{tabular}{lrr}');
    expect(latex).toContain('Capture\\_A\\&B\\%\\#\\_1.png');
    expect(latex).toContain('Vin, "A\\&B\\_1"');
    expect(latex).toContain('Temps de montée (10--90\\%) & $\\leq$ 1,000 \\textmu{}s');
    expect(latex).toContain('Dépassement & 12,0\\% & 12,0\\% \\\\');
    expect(latex.trimEnd()).toMatch(/\\end\{table\}$/);
  });
});
