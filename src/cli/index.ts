#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { columnInterval } from '../core/columns.js';
import { compareWithScopeCsv, parseScopeCsv } from '../core/compare.js';
import { csvField, renderBodeCsv, renderWaveformCsv } from '../core/export/csv.js';
import { GRATICULE_VERSION, csvNumber, localizeDecimal, parseEngineering } from '../core/export/format.js';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg.js';
import { renderBodeTable, renderMeasurementsTable, renderTables } from '../core/export/table.js';
import type { TableFormat } from '../core/export/table.js';
import { computeMathTrace } from '../core/math.js';
import { analyzeBodeBatch, analyzePngBytes } from '../core/pipeline.js';
import { CHANNELS } from '../core/pixels.js';
import { getNativeProfile } from '../core/profiles.js';
import { computeSpectrum, renderSpectrumCsv, renderSpectrumSvg, renderSpectrumTable } from '../core/spectrum.js';
import { decodeUart } from '../core/uart.js';
import { computeXyPlot, renderXyCsv, renderXySvg } from '../core/xy.js';
import type { BodeRejectedCapture, ChannelId, ExtractionOverrides, ExtractionResult, Locale, ProfileId, Quad, XyAxisId } from '../core/types.js';

const usage = `Usage
  graticule capture.png|capture.bmp [options]
  graticule --version
  graticule --bode folder [options]
  graticule compare capture.png|capture.bmp scope.csv [--channel C1] [--csv-column <label>] [--json]

Accepts PNG and BMP captures, including in Bode folders.
With no output flag, prints a table. Use --out with a file path for one format
or a directory path for multiple formats.

  --csv | --svg | --json | --table
  --title <text>
  --format tsv|markdown|html|latex
  --theme light|dark
  --locale en|fr
  --profile <id>
  --sec-per-div <val>
  --vdiv <C1=2V> (repeatable for C1 through C4)
  --hdivs N | --vdivs N
  --offset C1=0V (repeatable)
  --trigger-offset 0s
  --math sub|add|mul --math-a C1 --math-b C2
  --xy C1,C2
  --fft C1 [--window hann|rect|flattop|blackman] [--scale dbv|linear]
  --decode uart [--channel C1] [--baud auto|9600]
  --deskew x0,y0,x1,y1,x2,y2,x3,y3 (TL, TR, BR, BL)
  --out path
  --version | -v`;

interface Output {
  readonly extension: string;
  readonly text: string;
}

const tableExtensions: Readonly<Record<TableFormat, string>> = {
  tsv: 'tsv', markdown: 'md', html: 'html', latex: 'tex',
};

function scale(raw: string, flag: string, unit: 's' | 'V', divisions: number, signed = false): number {
  const value = parseEngineering(raw);
  const compact = raw.replace(/\s+/g, '');
  const suffix = compact.replace(/\/div$/i, '');
  const rawUnit = /(?:v[2²]|[vsa]|hz|db|div|[%°])$/i.exec(suffix)?.[0];
  if (signed && compact !== suffix) throw new Error(`Invalid ${flag} value: ${raw}`);
  if (value === null || (!signed && value <= 0) || (rawUnit && rawUnit.toLowerCase() !== unit.toLowerCase())) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  if (!Number.isFinite(value * divisions)) throw new Error(`Invalid ${flag} value: ${raw} exceeds the numeric range across the grid`);
  return value;
}

function divisions(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 100) throw new Error(`${flag} requires an integer from 1 to 100.`);
  return n;
}

function channelId(raw: string | undefined, flag: string): ChannelId | undefined {
  if (raw === undefined) return undefined;
  const channel = CHANNELS.find(id => id === raw.trim().toUpperCase());
  if (!channel) throw new Error(`${flag} requires C1, C2, C3 or C4.`);
  return channel;
}

function axis(raw: string, flag: string): XyAxisId {
  return raw.trim().toUpperCase() === 'M' ? 'M' : channelId(raw, flag)!;
}

function deskew(raw: string): Quad {
  const coords = raw.split(',').map(part => part.trim() ? Number(part) : NaN);
  if (coords.length !== 8 || !coords.every(Number.isFinite)) throw new Error('Use --deskew x0,y0,x1,y1,x2,y2,x3,y3.');
  const [x0, y0, x1, y1, x2, y2, x3, y3] = coords;
  return [{ x: x0!, y: y0! }, { x: x1!, y: y1! }, { x: x2!, y: y2! }, { x: x3!, y: y3! }];
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bode: { type: 'string' }, csv: { type: 'boolean' }, svg: { type: 'boolean' },
      json: { type: 'boolean' }, table: { type: 'boolean' }, locale: { type: 'string' },
      out: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      theme: { type: 'string' }, format: { type: 'string' }, profile: { type: 'string' }, title: { type: 'string' },
      'sec-per-div': { type: 'string' }, vdiv: { type: 'string', multiple: true }, deskew: { type: 'string' },
      hdivs: { type: 'string' }, vdivs: { type: 'string' }, offset: { type: 'string', multiple: true },
      'trigger-offset': { type: 'string' }, math: { type: 'string' }, 'math-a': { type: 'string' }, 'math-b': { type: 'string' },
      xy: { type: 'string' }, fft: { type: 'string' }, window: { type: 'string' }, scale: { type: 'string' },
      decode: { type: 'string' }, channel: { type: 'string' }, baud: { type: 'string' }, 'csv-column': { type: 'string' },
    },
  });
  if (values.out === '') throw new Error('--out requires a non-empty path.');
  if (values.help) {
    process.stdout.write(usage + '\n');
    return;
  }
  if (values.version) {
    process.stdout.write(`${GRATICULE_VERSION}\n`);
    return;
  }
  const comparing = positionals[0] === 'compare';
  if (values.bode !== undefined ? positionals.length !== 0 : positionals.length !== (comparing ? 3 : 1)) throw new Error(usage);
  const locale = values.locale ?? 'en';
  if (locale !== 'en' && locale !== 'fr') throw new Error('Use --locale en or --locale fr.');
  const theme = values.theme ?? 'light';
  if (theme !== 'light' && theme !== 'dark') throw new Error('Use --theme light or --theme dark.');
  const format = values.format ?? 'tsv';
  if (format !== 'tsv' && format !== 'markdown' && format !== 'html' && format !== 'latex') {
    throw new Error('Use --format tsv, markdown, html or latex.');
  }
  const profileId = values.profile as ProfileId | undefined;
  const nativeProfile = profileId === undefined ? undefined : getNativeProfile(profileId);
  if (profileId !== undefined && profileId !== 'universal-fallback' && !nativeProfile) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  const channels: NonNullable<ExtractionOverrides['channels']> = {};
  const hDivs = divisions(values.hdivs, '--hdivs'), vDivs = divisions(values.vdivs, '--vdivs');
  for (const flag of ['vdiv', 'offset'] as const) {
    for (const entry of values[flag] ?? []) {
      const match = /^\s*(C[1-4])\s*=\s*(.+)$/i.exec(entry);
      const id = channelId(match?.[1], `--${flag}`);
      if (!id) throw new Error(`Use --${flag} C1=${flag === 'offset' ? '0V' : '2V'}. Got ${entry}`);
      const n = scale(match![2]!, `--${flag}`, 'V', vDivs ?? 8, flag === 'offset');
      channels[id] = { ...channels[id], ...(flag === 'offset' ? { offsetVolts: n } : { voltsPerDiv: n }) };
    }
  }
  const secPerDivArg = values['sec-per-div'];
  const secPerDiv = secPerDivArg === undefined ? undefined : scale(secPerDivArg, '--sec-per-div', 's', hDivs ?? 10);
  const trigger = values['trigger-offset'];
  const overrides: ExtractionOverrides = {
    profileId, channels, secPerDiv, hDivs, vDivs,
    triggerOffsetSec: trigger === undefined ? undefined : scale(trigger, '--trigger-offset', 's', 1, true),
    manualQuad: values.deskew === undefined ? undefined : deskew(values.deskew),
  };
  const formats: Output[] = [];
  const localizeRows = (rows: readonly (readonly string[])[], from: number, to = Infinity) =>
    rows.map(row => row.map((cell, i) => i >= from && i < to ? localizeDecimal(cell, locale) : cell));
  const table = values.table || values.format || (!values.csv && !values.svg && !values.json);
  const svgOptions = { locale, theme, title: values.title } as const;
  const op = values.math;
  if (op !== undefined && op !== 'sub' && op !== 'add' && op !== 'mul') throw new Error('Use --math sub, add or mul.');
  const mathA = channelId(values['math-a'], '--math-a'), mathB = channelId(values['math-b'], '--math-b');
  if (op ? !mathA || !mathB : mathA || mathB) throw new Error('Use --math with --math-a and --math-b.');
  const axes = values.xy?.split(',');
  if (axes && axes.length !== 2) throw new Error('Use --xy C1,C2.');
  const fft = values.fft === undefined ? undefined : axis(values.fft, '--fft');
  const window = values.window;
  if (window !== undefined && window !== 'hann' && window !== 'rect' && window !== 'flattop' && window !== 'blackman') {
    throw new Error('Use --window hann, rect, flattop or blackman.');
  }
  const spectrumScale = values.scale;
  if (spectrumScale !== undefined && spectrumScale !== 'dbv' && spectrumScale !== 'linear') throw new Error('Use --scale dbv or linear.');
  if (!fft && (window || spectrumScale)) throw new Error('--window and --scale require --fft.');
  if (values.decode !== undefined && values.decode !== 'uart') throw new Error('Use --decode uart.');
  if (values.decode && values.svg) throw new Error('--svg is unsupported with --decode uart. Use a table, CSV or JSON.');
  const channel = channelId(values.channel, '--channel');
  if (!comparing && !values.decode && channel) throw new Error('--channel requires compare or --decode uart.');
  const csvColumn = values['csv-column'];
  if (csvColumn !== undefined && !comparing) throw new Error('--csv-column requires compare.');
  if (csvColumn !== undefined && !csvColumn.trim()) throw new Error('--csv-column requires a column label.');
  const baudArg = values.baud?.trim();
  if (baudArg !== undefined && baudArg !== 'auto' && !/^\d+(?:\.\d+)?$/.test(baudArg)) {
    throw new Error('Use --baud auto or a positive rate.');
  }
  const baud = baudArg === undefined || baudArg === 'auto' ? 'auto' : Number(baudArg);
  if (baud !== 'auto' && (!Number.isFinite(baud) || baud <= 0)) throw new Error('Use --baud auto or a positive rate.');
  if (values.baud !== undefined && !values.decode) throw new Error('--baud requires --decode uart.');
  if ((values.bode !== undefined || comparing) && (op || fft || axes || values.decode)) throw new Error('Run capture analysis on a single image.');
  const inputs: string[] = [];
  let stem = 'bode';
  if (values.bode !== undefined) {
    const folder = values.bode;
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && ['.png', '.bmp'].includes(extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!entries.length) throw new Error(`No PNG or BMP files in ${folder}`);
    const captures: (ExtractionResult | BodeRejectedCapture)[] = [];
    for (const { name } of entries) {
      const file = join(folder, name);
      inputs.push(file);
      try {
        captures.push(analyzePngBytes(await readFile(file), name, overrides));
      } catch (error) {
        process.stderr.write(`graticule: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        captures.push({ fileName: name, rejectionReason: 'capture_unreadable' });
      }
    }
    const result = analyzeBodeBatch(captures);
    if (values.csv) formats.push({ extension: 'csv', text: renderBodeCsv(result, values.title) });
    if (values.svg) formats.push({ extension: 'svg', text: renderBodeSvg(result, svgOptions) });
    if (values.json) formats.push({ extension: 'json', text: JSON.stringify(result, null, 2) + '\n' });
    if (table) formats.push({ extension: tableExtensions[format], text: renderBodeTable(result, format, locale, values.title) });
  } else {
    const input = positionals[comparing ? 1 : 0]!;
    inputs.push(input);
    const result = analyzePngBytes(await readFile(input), basename(input), overrides);
    stem = basename(input, extname(input));
    const json = (data: unknown) => formats.push({ extension: 'json', text: JSON.stringify(data, null, 2) + '\n' });
    if (comparing) {
      const scopeFile = positionals[2]!;
      inputs.push(scopeFile);
      const comparison = compareWithScopeCsv(result, parseScopeCsv(await readFile(scopeFile, 'utf8')), { channel, csvColumn });
      if (values.svg) throw new Error('Compare supports a table, CSV and JSON.');
      if (values.json) json(comparison);
      const rows = Object.entries(comparison.unaligned).map(([key, value]) =>
        [key, csvNumber(value), csvNumber(comparison.aligned[key as keyof typeof comparison.aligned])]);
      const head = locale === 'fr' ? ['Mesure', 'Sans alignement', 'Aligné'] : ['Measurement', 'Unaligned', 'Aligned'];
      if (table) formats.push({ extension: tableExtensions[format], text: renderTables([{
        caption: values.title ?? `${comparison.channel} / ${comparison.csvColumn}`, head, rows: localizeRows(rows, 1), numericFrom: 1,
      }], format) });
      if (values.csv) formats.push({ extension: 'csv', text: [['metric', 'unaligned', 'aligned'], ...rows].map(row => row.join(',')).join('\n') + '\n' });
    } else {
      const math = op ? computeMathTrace(result, { op, a: mathA!, b: mathB! }) : null;
      if (op && !math) throw new Error('Math needs both source channels enabled.');
      const xyAxes = axes?.map(id => axis(id, '--xy'));
      if (!math && (fft === 'M' || xyAxes?.includes('M'))) throw new Error('Axis M requires --math.');
      const requireChannel = (id: XyAxisId, flag: string) => {
        if (id !== 'M' && !result.traces.some(trace => trace.channel === id && trace.settings.enabled)) {
          throw new Error(`${flag} requires channel ${id}, which is missing from the capture.`);
        }
      };
      const uartChannel = channel ?? 'C1';
      xyAxes?.forEach(id => requireChannel(id, '--xy'));
      if (fft) {
        requireChannel(fft, '--fft');
        if (!Number.isFinite(1 / columnInterval(result))) throw new Error('Invalid --fft timebase: sample rate exceeds the numeric range.');
      }
      if (values.decode) requireChannel(uartChannel, '--decode uart');
      const xy = xyAxes && computeXyPlot(result, xyAxes[0]!, xyAxes[1]!, math);
      const spectrum = fft && computeSpectrum(result, { channel: fft, window, math });
      const uart = values.decode && decodeUart(result, { channel: uartChannel, baud });
      const modes = Number(Boolean(xy)) + Number(Boolean(spectrum)) + Number(Boolean(uart));
      const add = (mode: string, extension: string, text: string) => formats.push({
        extension: modes > 1 ? `${mode}.${extension}` : extension, text,
      });
      if (values.json) json(modes > 1 ? { xy, spectrum, uart, ...(math && { math }) }
        : xy || spectrum || uart || (math ? { ...result, math } : result));
      if (!modes) {
        if (values.csv) add('waveform', 'csv', renderWaveformCsv(result, undefined, values.title, math));
        if (values.svg) add('waveform', 'svg', renderWaveformSvg(result, { ...svgOptions, math }));
        if (table) add('waveform', tableExtensions[format], renderMeasurementsTable(result, format, locale, undefined, values.title, math));
      }
      if (xy) {
        if (values.csv) add('xy', 'csv', renderXyCsv(xy, values.title));
        if (values.svg) add('xy', 'svg', renderXySvg(xy, svgOptions));
        if (table) add('xy', tableExtensions[format], renderTables([{
          caption: values.title ?? `${xy.xAxis} / ${xy.yAxis}`, numericFrom: 1,
          head: locale === 'fr' ? ['Axe', 'Min', 'Max', 'Crête à crête'] : ['Axis', 'Min', 'Max', 'Peak to peak'],
          rows: localizeRows([[`${xy.xAxis} (${xy.xUnit})`, csvNumber(xy.xMin), csvNumber(xy.xMax), csvNumber(xy.xVpp)],
            [`${xy.yAxis} (${xy.yUnit})`, csvNumber(xy.yMin), csvNumber(xy.yMax), csvNumber(xy.yVpp)]], 1),
        }], format));
      }
      if (spectrum) {
        if (values.csv) add('fft', 'csv', renderSpectrumCsv(spectrum, values.title));
        if (values.svg) add('fft', 'svg', renderSpectrumSvg(spectrum, { ...svgOptions, scale: spectrumScale }));
        if (table) add('fft', tableExtensions[format], renderSpectrumTable(spectrum, locale, format, values.title));
      }
      if (uart) {
        const rows = uart.frames.map(frame => [
          csvNumber(frame.startSec), csvNumber(frame.endSec), frame.hex, frame.ascii,
          String(frame.framingError), String(frame.parityError), String(frame.uncertain),
        ]);
        const head = ['start_s', 'end_s', 'hex', 'ascii', 'framing_error', 'parity_error', 'uncertain'];
        // Timestamps stay numeric in CSV; only the text columns need spreadsheet formula protection.
        if (values.csv) add('uart', 'csv', [head.join(','), ...rows.map(([start, end, ...rest]) =>
          [start, end, ...rest.map(csvField)].join(','))].join('\n') + '\n');
        const tableHead = locale === 'fr'
          ? ['Début (s)', 'Fin (s)', 'Hex', 'ASCII', 'Erreur de trame', 'Erreur de parité', 'Incertain'] : head;
        if (table) add('uart', tableExtensions[format], renderTables([{
          caption: values.title ?? `UART ${uart.channel} ${uart.baud ?? ''} ${uart.reason ?? ''}`.trim(),
          head: tableHead, rows: localizeRows(rows, 0, 2), numericFrom: 0, numericTo: 2,
        }], format));
      }
    }
  }
  await writeOutputs(formats, stem, values.out, locale, inputs);
}

function statExisting(path: string, readStat: typeof stat = stat) {
  return readStat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

async function writeOutputs(outputs: readonly Output[], stem: string, out: string | undefined, locale: Locale,
  inputs: readonly string[]): Promise<void> {
  if (out === undefined) {
    if (outputs.length !== 1) throw new Error(locale === 'fr' ? 'Utilisez --out pour plusieurs formats.' : 'Use --out for multiple formats.');
    const { text } = outputs[0]!;
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  const outStat = await statExisting(out);
  const directory = outputs.length > 1 || outStat?.isDirectory();
  if (directory && outStat && !outStat.isDirectory()) throw new Error(`Output location is not a directory: ${out}`);
  const writes = outputs.map(({ extension, text }) => ({ text, path: directory ? join(out, `${stem}.${extension}`) : out }));
  const inputStats = await Promise.all(inputs.map(path => statExisting(path)));
  const inputPaths = new Set(inputs.map(pathKey));
  const paths = new Set<string>();
  const files = new Set<string>();
  const existingPaths: string[] = [];
  for (const { path } of writes) {
    const output = await statExisting(path);
    const key = pathKey(path);
    if (inputPaths.has(key) || (output && inputStats.some(input => input && input.ino === output.ino && input.dev === output.dev))) {
      throw new Error(`Output would overwrite an input file: ${path}`);
    }
    if (output ? !output.isFile() : (await statExisting(path, lstat))?.isSymbolicLink()) {
      throw new Error(`Output is not a regular file: ${path}`);
    }
    const file = output && `${output.dev}:${output.ino}`;
    if (paths.has(key) || (file !== null && files.has(file))) throw new Error(`Duplicate output destination: ${path}`);
    paths.add(key);
    if (file !== null) {
      files.add(file);
      existingPaths.push(path);
    }
  }
  await Promise.all(existingPaths.map(path => access(path, constants.W_OK)));
  const parent = directory ? out : dirname(out);
  await mkdir(parent, { recursive: true });
  if (existingPaths.length < writes.length) await access(parent, constants.W_OK);
  await Promise.all(writes.map(({ path, text }) => writeFile(path, text)));
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
});

void run().catch((error: unknown) => {
  process.stderr.write(`graticule: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
