#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { renderBodeCsv, renderWaveformCsv } from '../core/export/csv.js';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg.js';
import { renderBodeTable, renderMeasurementsTable } from '../core/export/table.js';
import { analyzeBodeBatch, analyzePngBytes } from '../core/pipeline.js';
import type { Locale } from '../core/types.js';

const usage = `Usage
  graticule capture.png [--csv | --svg | --json | --table] [--locale en|fr] [--out path]
  graticule --bode folder [--csv | --svg | --json | --table] [--locale en|fr] [--out path]

With no output flag, prints a table. Use --out with a file path for one format
or a directory path for multiple formats.`;

interface Output {
  readonly extension: string;
  readonly text: string;
}

async function run(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      bode: { type: 'string' }, csv: { type: 'boolean' }, svg: { type: 'boolean' },
      json: { type: 'boolean' }, table: { type: 'boolean' }, locale: { type: 'string' },
      out: { type: 'string', short: 'o' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(usage + '\n');
    return;
  }
  if (values.bode ? positionals.length !== 0 : positionals.length !== 1) throw new Error(usage);
  const locale = values.locale ?? 'en';
  if (locale !== 'en' && locale !== 'fr') throw new Error('Use --locale en or --locale fr.');
  const formats: Output[] = [];
  const table = values.table || (!values.csv && !values.svg && !values.json);
  let stem = 'bode';
  if (values.bode) {
    const folder = values.bode;
    const entries = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.png')
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!entries.length) throw new Error(`No PNG files in ${folder}`);
    const captures = await Promise.all(entries.map(async entry => ({
      fileName: entry.name, bytes: await readFile(join(folder, entry.name)),
    })));
    const result = analyzeBodeBatch(captures);
    if (values.csv) formats.push({ extension: 'csv', text: renderBodeCsv(result) });
    if (values.svg) formats.push({ extension: 'svg', text: renderBodeSvg(result, { locale }) });
    if (values.json) formats.push({ extension: 'json', text: JSON.stringify(result, null, 2) + '\n' });
    if (table) formats.push({ extension: 'tsv', text: renderBodeTable(result, 'tsv', locale) });
  } else {
    const input = positionals[0]!;
    const result = analyzePngBytes(await readFile(input), basename(input));
    stem = basename(input, extname(input));
    if (values.csv) formats.push({ extension: 'csv', text: renderWaveformCsv(result) });
    if (values.svg) formats.push({ extension: 'svg', text: renderWaveformSvg(result, { locale }) });
    if (values.json) formats.push({ extension: 'json', text: JSON.stringify(result, null, 2) + '\n' });
    if (table) formats.push({ extension: 'tsv', text: renderMeasurementsTable(result, 'tsv', locale) });
  }
  await writeOutputs(formats, stem, values.out, locale);
}

async function writeOutputs(outputs: readonly Output[], stem: string, out: string | undefined, locale: Locale): Promise<void> {
  if (!out) {
    if (outputs.length !== 1) throw new Error(locale === 'fr' ? 'Utilisez --out pour plusieurs formats.' : 'Use --out for multiple formats.');
    const { text } = outputs[0]!;
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    return;
  }
  const exists = await stat(out).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (outputs.length === 1 && !exists?.isDirectory()) {
    const { text } = outputs[0]!;
    await writeFile(out, text);
    return;
  }
  await mkdir(out, { recursive: true });
  await Promise.all(outputs.map(({ extension, text }) => writeFile(join(out, `${stem}.${extension}`), text)));
}

void run().catch((error: unknown) => {
  process.stderr.write(`graticule: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
