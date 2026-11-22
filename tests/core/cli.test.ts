import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
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

  test.each([
    ['--theme', 'blue', /--theme/], ['--format', 'pdf', /--format/], ['--profile', 'unlisted', /Unknown profile/],
    ['--vdiv', 'C5=1V', /--vdiv/], ['--sec-per-div', '2mV', /--sec-per-div/],
    ['--deskew', '0,0,100,100,100,0,0,100', /deskew corners/],
  ] as const)('rejects invalid %s input', (flag, value, message) => {
    const result = cli(input, flag, value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
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

  test('keeps good Bode captures and identifies an unreadable file on stderr', () => {
    const dir = join(root, 'batch');
    mkdirSync(dir);
    writeFileSync(join(dir, 'good.png'), sample('sweep_04.png'));
    const corrupt = Uint8Array.from(sample('sweep_04.png'));
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    writeFileSync(join(dir, 'bad.png'), corrupt);
    const result = cli('--bode', dir, '--csv');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('good.png');
    expect(result.stdout).not.toContain('bad.png');
    expect(result.stderr).toMatch(/bad\.png: Invalid PNG: CRC mismatch in IEND/);
  });
});
