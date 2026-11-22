import { describe, expect, test } from 'vitest';
import { csvField, renderBodeCsv, renderWaveformCsv } from '../../src/core/export/csv.js';
import { GRATICULE_VERSION, parseEngineering, stepScale125 } from '../../src/core/export/format.js';
import { renderBodeSvg, renderOverlaySvg, renderWaveformSvg, waveformFrame } from '../../src/core/export/svg.js';
import { renderBodeTable, renderMeasurementsTable } from '../../src/core/export/table.js';
import { splitTrace } from '../../src/core/export/trace-geometry.js';
import { analyzeBodeBatch, analyzePngBytes } from '../../src/core/pipeline.js';
import type { Quad, SvgExportOptions } from '../../src/core/types.js';
import { sample } from './fixtures.js';

const result = analyzePngBytes(sample('sine_schmitt.png'), 'Capture_A&B%#_1.png');

describe('waveform exports', () => {
  test('formats engineering scales with optional units per division and rejects overflow', () => {
    expect(GRATICULE_VERSION).toBe('1.1.3');
    expect(parseEngineering('5 mV/div')).toBe(0.005);
    expect(parseEngineering('2,5 ms / div')).toBe(0.0025);
    expect(parseEngineering('2/div')).toBe(2);
    expect(parseEngineering('1e308G')).toBeNull();
    expect(parseEngineering('1e309')).toBeNull();
    expect(parseEngineering('1.7976931348623e308')).toBe(1.79769313486e308);
    expect(parseEngineering('1 2 V')).toBeNull();
    expect(parseEngineering('1. 2 V')).toBeNull();
    expect(parseEngineering('1e1 2 V')).toBeNull();
    expect(parseEngineering('1.2e2 V')).toBe(120);
    expect(parseEngineering('3 GigaVolts')).toBeNull();
  });

  test('steps through positive representable subnormal scales', () => {
    expect(stepScale125(1e-323, 1)).toBe(2e-323);
    expect(stepScale125(2e-323, -1)).toBe(1e-323);
    expect(stepScale125(Number.MIN_VALUE, -1)).toBe(Number.MIN_VALUE);
    expect(stepScale125(1, -1)).toBe(0.5);
    expect(stepScale125(1, 1)).toBe(2);
  });

  test('writes a sanitized CSV title after the filename and omits whitespace-only titles', () => {
    const csv = renderWaveformCsv(result, { C1: 'Input' }, ' =scope\r\ntrace ');
    expect(csv.split('\n').slice(1, 3)).toEqual([`# file: ${result.fileName}`, "# title: ' =scope trace"]);
    expect(csv).toContain('Input_v,Input_status');
    expect(renderWaveformCsv(result, undefined, ' \t\n')).not.toContain('# title:');
  });

  test('uses default SVG dimensions for invalid options in both renderers', () => {
    const bode = analyzeBodeBatch([result]);
    const viewport = (svg: string) => svg.match(/viewBox="([^"]+)"/)?.[1];
    for (const value of [NaN, Infinity, -Infinity, 0, -200]) {
      const options = { width: value, height: value };
      expect(viewport(renderWaveformSvg(result, options))).toBe(viewport(renderWaveformSvg(result)));
      expect(viewport(renderBodeSvg(bode, options))).toBe('0 0 960 660');
    }
    expect(viewport(renderBodeSvg(bode, { width: 720, height: 400 }))).toBe('0 0 720 400');
  });

  test('calibrates time and voltage against the plot origin at extreme scales', () => {
    const traces = result.traces.map(trace => ({ ...trace, settings: { ...trace.settings, voltsPerDiv: 1e307 } }));
    const timebase = { ...result.timebase, secPerDiv: 1e307, triggerOffsetSec: 1e308 };
    const frame = waveformFrame({ ...result, timebase, traces });
    const { grid } = result.detection;
    expect(frame.timeAt(0.5)).toBe(1e308);
    expect(frame.timeAt(1) / 1e308).toBeCloseTo(1.5, 12);
    const trace = traces[0]!;
    expect(frame.voltAt(trace.channel, (trace.settings.zeroY - grid.top) / grid.height)! / 1e307).toBeCloseTo(0, 12);
    const shifted = waveformFrame({ ...result, timebase: { ...timebase, secPerDiv: 5e307, triggerOffsetSec: -1e308 } });
    expect(shifted.timeAt(1) / 1e308).toBeCloseTo(1.5, 12);
  });

  test('prints exact zero for coincident cursors and preserves deltas at large offsets', () => {
    const cursors = { channel: 'C1' as const, x1: 0.3, x2: 0.3 + 5e-13, y1: 0.6, y2: 0.6 - 5e-13 };
    expect(renderWaveformSvg(result, { cursors })).toContain('\u0394t 0 s   1/\u0394t \u2014   \u0394V 0 V');
    const timebase = { ...result.timebase, secPerDiv: 0.001, triggerOffsetSec: 1e308 };
    const traces = result.traces.map(trace => ({ ...trace, settings: { ...trace.settings, zeroY: 1e308, voltsPerDiv: 1 } }));
    const svg = renderWaveformSvg({ ...result, timebase, traces }, { cursors: { channel: 'C1', x1: 0, x2: 0.5, y1: 0, y2: 0.5 } });
    expect(svg).toContain('\u0394t 5 ms   1/\u0394t 200 Hz   \u0394V 4 V');
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

  test('escapes untrusted custom titles and channel labels in Word, Markdown, LaTeX and TSV', () => {
    const title = 'Bench_[A] <b>probe</b> | μ * \\';
    const labels = { C1: '=C1', C2: '-C2' };
    const html = renderMeasurementsTable(result, 'html', 'en', labels, title);
    expect(html).toContain('Bench_[A] &lt;b&gt;probe&lt;/b&gt; | μ * \\');
    expect(html).not.toContain(result.fileName);
    const markdown = renderMeasurementsTable(result, 'markdown', 'en', labels, title);
    expect(markdown).toContain('Bench\\_\\[A\\] \\<b\\>probe\\</b\\> \\| μ \\* \\\\');
    expect(markdown).not.toContain('<b>');
    const latex = renderMeasurementsTable(result, 'latex', 'en', labels, title);
    expect(latex).toContain('Bench\\_[A] \\textless{}b\\textgreater{}probe\\textless{}/b\\textgreater{} \\textbar{} \\textmu{}');
    const tsv = renderMeasurementsTable(result, 'tsv', 'en', labels, title);
    expect(tsv).toContain(title);
    expect(tsv).toMatch(/Measurement\t'=C1\t'-C2/);
  });

  test('quotes comment-leading filenames and protects formula text without changing numeric Bode cells', () => {
    const batch = analyzeBodeBatch([result]);
    const point = batch.points[0]!;
    const bode = { ...batch, points: [
      { ...point, fileName: '#sample.png', gainDb: -5.2 },
      { ...point, fileName: '@sample.png', gainDb: -4.5 },
      { ...point, fileName: '[sample.png' },
    ] };
    const csv = renderBodeCsv(bode);
    expect(csv.split('\n').filter(line => !line.startsWith('#'))).toEqual(expect.arrayContaining([
      expect.stringMatching(/^"#sample\.png",.*,-5\.2,/), expect.stringMatching(/^'@sample\.png,.*,-4\.5,/),
    ]));
    expect(renderBodeTable(bode, 'tsv', 'en')).toMatch(/'@sample\.png\t[^\n]*\t-4\.50\t/);
    expect(renderBodeTable(bode, 'latex', 'en')).toContain('\n{[}sample.png &');
    const header = renderWaveformCsv(result, { C1: '=1+1', C2: '\tprobe' }).split('\n').find(line => line.startsWith('time_s'));
    expect(header).toBe("time_s,'=1+1_v,'=1+1_status,'\tprobe_v,'\tprobe_status");
    for (const prefix of ['=', '+', '-', '@', '\t']) expect(csvField(`${prefix}probe`)).toBe(`'${prefix}probe`);
    expect(csvField('\rprobe')).toBe('"\'\rprobe"');
  });

  test('provides a value column for empty measurement tables', () => {
    const empty = { ...result, measurements: [], traces: [] };
    const [, head, row] = renderMeasurementsTable(empty, 'tsv', 'en').split('\n');
    expect(head).toBe('Measurement\tValue');
    expect(row?.split('\t')).toEqual([expect.any(String), '—']);
  });

  test('keeps a positive waveform plot width and removes illegal XML characters', () => {
    const options = { width: 1, title: 'Vin\u0000\u0008<>\u000b\u000c\u001f\uFFFE\uFFFF & trace' };
    expect(waveformFrame(result, options).plotW).toBeGreaterThan(0);
    expect(waveformFrame(result, { width: NaN }).plotW).toBeGreaterThan(0);
    const svg = renderWaveformSvg(result, options);
    expect(svg).toContain('Vin&lt;&gt; &amp; trace');
    expect(svg).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFFE\uFFFF]/);
  });

  test('draws isolated overlay samples and shows omitted columns and a final deskewed gap', () => {
    const g = result.detection.grid;
    const x = g.right - 4;
    const y = g.top + 20;
    const trace = result.traces[0]!;
    const samples = [
      { ...trace.samples[0]!, col: x - g.left, xPx: x, yPx: y, status: 'ok' as const },
      { ...trace.samples[0]!, col: x + 2 - g.left, xPx: x + 2, yPx: y, status: 'ok' as const },
      { ...trace.samples[0]!, col: x + 3 - g.left, xPx: x + 3, yPx: y, status: 'ok' as const },
      { ...trace.samples[0]!, col: x + 4 - g.left, xPx: x + 4, yPx: null, status: 'masked_overlay' as const },
    ];
    const split = splitTrace(samples);
    expect(split.segments.map(segment => segment.length)).toEqual([1, 2]);
    expect(split.gaps).toEqual([{ x0: x + 1, x1: x + 1, kind: 'unresolved' }, { x0: g.right, x1: g.right, kind: 'masked_overlay' }]);
    const { imageWidth: w, imageHeight: h } = result;
    const square: Quad = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
    const overlay = renderOverlaySvg({ ...result, sourceQuad: square, sourceWidth: w, sourceHeight: h, traces: [{ ...trace, samples }] });
    const isolated = `${x + 0.5} ${y + 0.5}`;
    expect(overlay).toContain(`d="M${isolated}L${isolated}M${x + 2.5} ${y + 0.5}`);
    expect(overlay).toContain('stroke-linecap="round"');
    expect(overlay).toContain(`points="${g.right} ${g.top} ${g.right + 1} ${g.top} ${g.right + 1} ${g.bottom + 1} ${g.right} ${g.bottom + 1}"`);
  });
});
