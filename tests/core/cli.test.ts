import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { version } from '../../package.json';
import { sample } from './fixtures.js';

const root = mkdtempSync(join(tmpdir(), 'graticule-cli-'));
const cliPath = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const input = join(root, 'capture.png');
writeFileSync(input, sample('sine_schmitt.png'));

const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('command line', () => {
  test('writes the --title argument immediately after the filename in waveform CSV', () => {
    const result = cli(input, '--csv', '--title', 'Bench capture');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n').slice(0, 3)).toEqual([`# Graticule v${version}`, '# file: capture.png', '# title: Bench capture']);
  });

  test('exports LaTeX and dark SVG and creates nested output directories', () => {
    const destination = join(root, 'nested', 'table.tex');
    const table = cli(input, '--format', 'latex', '--out', destination);
    expect(table.status, table.stderr).toBe(0);
    expect(readFileSync(destination, 'utf8')).toContain('\\begin{tabular}');
    const plot = cli(input, '--svg', '--theme', 'dark');
    expect(plot.status, plot.stderr).toBe(0);
    expect(plot.stdout).toContain('fill="#0a0a0a"');
    const bothDir = join(root, 'multiple', 'data');
    const both = cli(input, '--svg', '--format', 'markdown', '--out', bothDir);
    expect(both.status, both.stderr).toBe(0);
    expect(readFileSync(join(bothDir, 'capture.md'), 'utf8')).toContain('**Measurements capture.png**');
    expect(readFileSync(join(bothDir, 'capture.svg'), 'utf8')).toContain('<svg');
  }, 15_000);

  test('uses manual profile, scales and source corners', () => {
    const profile = cli(input, '--profile', 'universal-fallback', '--json');
    expect(profile.status, profile.stderr).toBe(0);
    const profileResult: unknown = JSON.parse(profile.stdout);
    expect(profileResult).toMatchObject({ detection: { profileId: 'universal-fallback' } });
    const result = cli(input, '--json', '--sec-per-div', '1 ms/div', '--vdiv', 'C1=2V', '--vdiv', 'C2=500mV/div',
      '--deskew', '19,49,1019,49,1019,499,19,499');
    expect(result.status, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      sourceWidth: 1024, sourceHeight: 600, imageWidth: 1001, imageHeight: 451,
      detection: { profileId: 'universal-fallback' }, timebase: { secPerDiv: 0.001, source: 'manual' },
      traces: expect.arrayContaining([
        expect.objectContaining({ channel: 'C1', settings: expect.objectContaining({ voltsPerDiv: 2, scaleSource: 'manual' }) }),
        expect.objectContaining({ channel: 'C2', settings: expect.objectContaining({ voltsPerDiv: 0.5, scaleSource: 'manual' }) }),
      ]),
    });
  }, 15_000);

  test('calibrates native divisions and offsets while exporting a math product', () => {
    const result = cli(input, '--json', '--hdivs', '12', '--vdivs', '6', '--offset', 'C1=0.2V', '--trigger-offset=-1ms',
      '--math', 'mul', '--math-a', 'C1', '--math-b', 'C2');
    expect(result.status, result.stderr).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      detection: { profileId: 'siglent-sds2000x-plus', grid: { hDivs: 12, vDivs: 6 } },
      timebase: { triggerOffsetSec: -0.001 },
      traces: expect.arrayContaining([expect.objectContaining({ settings: expect.objectContaining({ channel: 'C1', offsetVolts: 0.2, zeroSource: 'manual' }) })]),
      math: { label: 'M', unit: 'V²', config: { op: 'mul', a: 'C1', b: 'C2' } },
    });
  });

  test('uses math in XY, FFT and multiple JSON analysis modes', () => {
    const math = ['--math', 'add', '--math-a', 'C1', '--math-b', 'C2'];
    const xy = cli(input, ...math, '--xy', 'M,C2', '--csv');
    expect(xy.status, xy.stderr).toBe(0);
    expect(xy.stdout).toContain('column,time_s,x_v,y_v,x_status,y_status');
    const fft = cli(input, ...math, '--fft', 'M', '--window', 'blackman', '--scale', 'linear', '--svg');
    expect(fft.status, fft.stderr).toBe(0);
    expect(fft.stdout).toContain('V RMS');
    const combined = cli(input, ...math, '--xy', 'C1,M', '--fft', 'C1', '--decode', 'uart', '--channel', 'C2', '--baud', '9600', '--json');
    expect(combined.status, combined.stderr).toBe(0);
    const parsed: unknown = JSON.parse(combined.stdout);
    expect(parsed).toMatchObject({
      xy: { xAxis: 'C1', yAxis: 'M' }, spectrum: { window: 'hann', channel: 'C1' },
      uart: { channel: 'C2', baud: 9600 }, math: { config: { op: 'add' } },
    });
  }, 20_000);

  test('compares a capture to a reference and protects the scope CSV from being overwritten', () => {
    const scope = join(root, 'reference.csv');
    writeFileSync(scope, 'time_s,CH1_V,CH2_mV\n-0.003,0,1000\n0,0,1000\n0.003,0,1000\n');
    const result = cli('compare', input, scope, '--channel', 'C2', '--json');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      channel: 'C2', csvColumn: 'CH2_mV', unaligned: { lagPx: 0, coverage: 1, rmseV: expect.any(Number) },
    });
    const collision = cli('compare', input, scope, '--json', '--out', scope);
    expect(collision.status).toBe(1);
    expect(collision.stderr).toContain('Output would overwrite an input file');
  }, 15_000);

  test('uses custom titles in Bode CSV and Bode and Compare LaTeX captions', () => {
    const captures = join(root, 'sweep');
    mkdirSync(captures);
    writeFileSync(join(captures, '1kHz.png'), sample('sweep_04.png'));
    const sweep = cli('--bode', captures, '--csv', '--format', 'latex', '--title', 'Sweep & gain', '--out', captures);
    expect(sweep.status, sweep.stderr).toBe(0);
    expect(readFileSync(join(captures, 'bode.csv'), 'utf8')).toContain('# title: Sweep & gain\n');
    expect(readFileSync(join(captures, 'bode.tex'), 'utf8')).toContain('\\caption{Sweep \\& gain}');
    const scope = join(root, 'titled-reference.csv');
    writeFileSync(scope, 'Time (s),C2\n-0.003,1\n0.003,1\n');
    const comparison = cli('compare', input, scope, '--format', 'latex', '--title', 'Scope_2');
    expect(comparison.status, comparison.stderr).toBe(0);
    expect(comparison.stdout).toContain('\\caption{Scope\\_2}');
  }, 15_000);

  test.each([
    ['--theme', 'blue', /--theme/], ['--format', 'pdf', /--format/], ['--profile', 'unlisted', /Unknown profile/],
    ['--vdiv', 'C5=1V', /--vdiv/], ['--sec-per-div', '2mV', /--sec-per-div/],
    ['--sec-per-div', '2V2', /Invalid --sec-per-div/], ['--sec-per-div', '2mV² /div', /Invalid --sec-per-div/],
    ['--vdiv', 'C1=2V²', /Invalid --vdiv/], ['--vdiv', 'C1=2mV2/div', /Invalid --vdiv/],
    ['--offset', 'C1=2V2', /Invalid --offset/], ['--offset', 'C1=2mV²', /Invalid --offset/],
    ['--trigger-offset', '2V²', /Invalid --trigger-offset/], ['--trigger-offset', '2mV2', /Invalid --trigger-offset/],
    ['--sec-per-div', '1e308s', /Invalid --sec-per-div.*exceeds the numeric range/],
    ['--vdiv', 'C1=1e308V', /Invalid --vdiv.*exceeds the numeric range/],
    ['--sec-per-div', '1 2 ms', /Invalid --sec-per-div/], ['--vdiv', 'C1=1 2 V', /Invalid --vdiv/],
    ['--deskew', '0,0,100,100,100,0,0,100', /deskew corners/],
    ['--hdivs', '0', /--hdivs/], ['--vdivs', '1.5', /--vdivs/],
    ['--offset', 'C1=2ms', /--offset/], ['--trigger-offset', '2mV', /--trigger-offset/],
    ['--offset', 'C1=2V /DIV', /--offset/], ['--trigger-offset', '2ms/div', /--trigger-offset/],
    ['--trigger-offset', '1e30s', /[Tt]rigger offset.*distinct timestamps/],
    ['--xy', 'C1', /--xy/], ['--fft', 'M', /Axis M requires/],
  ] as const)('rejects invalid %s input', (flag, value, message) => {
    const result = cli(input, flag, value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stdout).toBe('');
  });

  test.each([
    ['--xy', 'C1,C3'], ['--fft', 'C3'], ['--decode', 'uart', '--channel', 'C3'],
  ] as const)('rejects an absent channel requested by %s', (...args) => {
    const result = cli(input, ...args, '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/requires channel C3, which is missing/);
    expect(result.stdout).toBe('');
  });

  test('rejects UART SVG even when JSON is requested', () => {
    const result = cli(input, '--decode', 'uart', '--svg', '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--svg is unsupported with --decode uart/);
    expect(result.stdout).toBe('');
  });

  test('rejects a timebase whose FFT sample rate overflows', () => {
    const result = cli(input, '--fft', 'C1', '--sec-per-div', '1e-307s', '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--fft timebase.*sample rate exceeds the numeric range/);
    expect(result.stdout).toBe('');
  });

  test('protects original inputs, including hardlink aliases', () => {
    const alias = join(root, 'alias.csv');
    linkSync(input, alias);
    for (const output of [input, alias]) {
      const result = cli(input, '--csv', '--out', output);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/would overwrite an input file/);
    }
    expect(readFileSync(input)).toEqual(sample('sine_schmitt.png'));
  });

  test('rejects an explicitly empty output path', () => {
    const result = cli(input, '--csv', '--out=');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--out requires a non-empty path');
    expect(result.stdout).toBe('');
  });

  test('checks every destination before writing and protects already linked output files', () => {
    const directory = join(root, 'preflight');
    const csv = join(directory, 'capture.csv');
    const svg = join(directory, 'capture.svg');
    mkdirSync(svg, { recursive: true });
    const blocked = cli(input, '--csv', '--svg', '--out', directory);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/Output is not a regular file.*capture\.svg/);
    expect(existsSync(csv)).toBe(false);
    rmdirSync(svg);
    writeFileSync(csv, 'saved output');
    linkSync(csv, svg);
    const duplicate = cli(input, '--csv', '--svg', '--out', directory);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toMatch(/Duplicate output destination/);
    expect(readFileSync(csv, 'utf8')).toBe('saved output');
    expect(readFileSync(svg, 'utf8')).toBe('saved output');
  }, 15_000);

  test('exits quietly after the stdout reader closes the pipe', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, input, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const [status] = await once(child, 'close');
    expect(status, stderr).toBe(0);
    expect(stderr).toBe('');
  });

  test('keeps unreadable captures in the Bode sweep and prevents a cutoff through them', () => {
    const dir = join(root, 'batch');
    mkdirSync(dir);
    writeFileSync(join(dir, 'passband.png'), sample('sweep_02.png'));
    writeFileSync(join(dir, 'stopband.png'), sample('sweep_05.png'));
    const baseline = cli('--bode', dir, '--json');
    expect(baseline.status, baseline.stderr).toBe(0);
    const clean: unknown = JSON.parse(baseline.stdout);
    expect(clean).toMatchObject({ acceptedCount: 2, cutoffHz: expect.any(Number) });

    const corrupt = Uint8Array.from(sample('sweep_04.png'));
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    writeFileSync(join(dir, 'bad 1000 Hz.png'), corrupt);
    writeFileSync(join(dir, 'bad unknown.png'), corrupt);
    const result = cli('--bode', dir, '--json');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/bad 1000 Hz\.png: Invalid PNG: CRC mismatch in IEND/);
    expect(result.stderr).toMatch(/bad unknown\.png: Invalid PNG: CRC mismatch in IEND/);
    const sweep: unknown = JSON.parse(result.stdout);
    expect(sweep).toMatchObject({ acceptedCount: 2, rejectedCount: 2, cutoffHz: null, points: [
      { fileName: 'passband.png', accepted: true },
      { fileName: 'bad 1000 Hz.png', accepted: false, frequencyHz: 1000, frequencySource: 'filename',
        rejectionReasons: ['capture_unreadable'], extraction: null },
      { fileName: 'stopband.png', accepted: true },
      { fileName: 'bad unknown.png', accepted: false, frequencyHz: null, frequencySource: 'none',
        rejectionReasons: ['capture_unreadable'], extraction: null },
    ] });
  }, 15_000);
});
