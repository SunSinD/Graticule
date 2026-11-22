#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderBodeCsv, renderWaveformCsv } from '../core/export/csv.js';
import { parseEngineering } from '../core/export/format.js';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg.js';
import { renderBodeTable, renderMeasurementsTable } from '../core/export/table.js';
import type { TableFormat } from '../core/export/table.js';
import { analyzeBodeBatch, analyzePngBytes } from '../core/pipeline.js';
import { CHANNELS } from '../core/pixels.js';
import { getNativeProfile } from '../core/profiles.js';
import type { ExtractionOverrides, ExtractionResult, Locale, ProfileId, Quad } from '../core/types.js';

const usage = `Usage
  graticule capture.png [options]
  graticule --bode folder [options]

With no output flag, prints a table. Use --out with a file path for one format
or a directory path for multiple formats.

  --csv | --svg | --json | --table
  --format tsv|markdown|html|latex
  --theme light|dark
  --locale en|fr
  --profile <id>
  --sec-per-div <val>
  --vdiv <C1=2V> (repeatable for C1 through C4)
  --deskew x0,y0,x1,y1,x2,y2,x3,y3 (TL, TR, BR, BL)
  --out path`;

interface Output {
  readonly extension: string;
  readonly text: string;
}

const tableExtensions: Readonly<Record<TableFormat, string>> = {
  tsv: 'tsv', markdown: 'md', html: 'html', latex: 'tex',
};

function scale(raw: string, flag: string, unit: 's' | 'V'): number {
  const value = parseEngineering(raw);
  const suffix = raw.replace(/\s+/g, '').replace(/\/div$/i, '');
  if (value === null || value <= 0 || (/[vsa]$|(?:hz|db|div)$|[%°]$/i.test(suffix) && !suffix.toLowerCase().endsWith(unit.toLowerCase()))) {
    throw new Error(`Invalid ${flag} value: ${raw}`);
  }
  return value;
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
      out: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' },
      theme: { type: 'string' }, format: { type: 'string' }, profile: { type: 'string' },
      'sec-per-div': { type: 'string' }, vdiv: { type: 'string', multiple: true }, deskew: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(usage + '\n');
    return;
  }
  if (values.bode ? positionals.length !== 0 : positionals.length !== 1) throw new Error(usage);
  const locale = values.locale ?? 'en';
  if (locale !== 'en' && locale !== 'fr') throw new Error('Use --locale en or --locale fr.');
  const theme = values.theme ?? 'light';
  if (theme !== 'light' && theme !== 'dark') throw new Error('Use --theme light or --theme dark.');
  const format = values.format ?? 'tsv';
  if (format !== 'tsv' && format !== 'markdown' && format !== 'html' && format !== 'latex') {
    throw new Error('Use --format tsv, markdown, html or latex.');
  }
  const profileId = values.profile as ProfileId | undefined;
  if (profileId !== undefined && profileId !== 'universal-fallback' && !getNativeProfile(profileId)) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  const channels: NonNullable<ExtractionOverrides['channels']> = {};
  for (const entry of values.vdiv ?? []) {
    const match = /^\s*(C[1-4])\s*=\s*(.+)$/i.exec(entry);
    const id = CHANNELS.find(channel => channel === match?.[1]?.toUpperCase());
    if (!id) throw new Error(`Use --vdiv C1=2V, C2=2V, C3=2V or C4=2V. Got ${entry}`);
    channels[id] = { voltsPerDiv: scale(match![2]!, '--vdiv', 'V') };
  }
  const overrides: ExtractionOverrides = {
    profileId, channels,
    secPerDiv: values['sec-per-div'] === undefined ? undefined : scale(values['sec-per-div'], '--sec-per-div', 's'),
    manualQuad: values.deskew === undefined ? undefined : deskew(values.deskew),
  };
  const formats: Output[] = [];
  const table = values.table || values.format || (!values.csv && !values.svg && !values.json);
  const svgOptions = { locale, theme } as const;
  const inputs: string[] = [];
  let stem = 'bode';
  if (values.bode !== undefined) {
    const folder = values.bode;
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.png')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!entries.length) throw new Error(`No PNG files in ${folder}`);
    const captures: ExtractionResult[] = [];
    for (const { name } of entries) {
      const file = join(folder, name);
      inputs.push(file);
      try {
        captures.push(analyzePngBytes(await readFile(file), name, overrides));
      } catch (error) {
        process.stderr.write(`graticule: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    }
    if (!captures.length) throw new Error(`No readable PNG files in ${folder}`);
    const result = analyzeBodeBatch(captures);
    if (values.csv) formats.push({ extension: 'csv', text: renderBodeCsv(result) });
    if (values.svg) formats.push({ extension: 'svg', text: renderBodeSvg(result, svgOptions) });
    if (values.json) formats.push({ extension: 'json', text: JSON.stringify(result, null, 2) + '\n' });
    if (table) formats.push({ extension: tableExtensions[format], text: renderBodeTable(result, format, locale) });
  } else {
    const input = positionals[0]!;
    inputs.push(input);
    const result = analyzePngBytes(await readFile(input), basename(input), overrides);
    stem = basename(input, extname(input));
    if (values.csv) formats.push({ extension: 'csv', text: renderWaveformCsv(result) });
    if (values.svg) formats.push({ extension: 'svg', text: renderWaveformSvg(result, svgOptions) });
    if (values.json) formats.push({ extension: 'json', text: JSON.stringify(result, null, 2) + '\n' });
    if (table) formats.push({ extension: tableExtensions[format], text: renderMeasurementsTable(result, format, locale) });
  }
  await writeOutputs(formats, stem, values.out, locale, inputs);
}

function statExisting(path: string) {
  return stat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
}

async function writeOutputs(outputs: readonly Output[], stem: string, out: string | undefined, locale: Locale,
  inputs: readonly string[]): Promise<void> {
  if (!out) {
    if (outputs.length !== 1) throw new Error(locale === 'fr' ? 'Utilisez --out pour plusieurs formats.' : 'Use --out for multiple formats.');
    const { text } = outputs[0]!;
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  const directory = outputs.length > 1 || (await statExisting(out))?.isDirectory();
  const writes = outputs.map(({ extension, text }) => ({ text, path: directory ? join(out, `${stem}.${extension}`) : out }));
  const inputStats = await Promise.all(inputs.map(statExisting));
  const inputPaths = new Set(inputs.map(input => resolve(input)));
  for (const { path } of writes) {
    const output = await statExisting(path);
    if (inputPaths.has(resolve(path)) || (output && inputStats.some(input => input && input.ino === output.ino && input.dev === output.dev))) {
      throw new Error(`Output would overwrite an input file: ${path}`);
    }
  }
  await mkdir(directory ? out : dirname(out), { recursive: true });
  await Promise.all(writes.map(({ path, text }) => writeFile(path, text)));
}

void run().catch((error: unknown) => {
  process.stderr.write(`graticule: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
