import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveResult(stdout);
      else reject(new Error(`CLI failed (${code}): ${stderr || stdout}`));
    });
  });
}

const pipelineMod = await import(pathToFileURL(resolve(root, 'dist-cli/core/pipeline.js')).href);
const csvMod = await import(pathToFileURL(resolve(root, 'dist-cli/core/export/csv.js')).href);

const samples = [
  'tests/fixtures/samples/sine_schmitt.png',
  'tests/fixtures/samples/zener_clip.png',
  'tests/fixtures/samples/sweep_01.png',
  'tests/fixtures/samples/sweep_05.png',
];

for (const sample of samples) {
  const absolute = resolve(root, sample);
  const cliCsv = (await run(process.execPath, ['dist-cli/cli/index.js', absolute, '--csv'])).replace(/\r\n/g, '\n').trimEnd();
  const bytes = new Uint8Array(await readFile(absolute));
  const result = pipelineMod.analyzePngBytes(bytes, basename(absolute));
  const coreCsv = csvMod.renderWaveformCsv(result).replace(/\r\n/g, '\n').trimEnd();

  if (cliCsv !== coreCsv) {
    throw new Error(`Browser/Node CLI CSV parity mismatch for ${sample}`);
  }
  console.log(`Parity verified: ${sample} (${Buffer.byteLength(cliCsv)} bytes)`);
}

// Verify Bode batch CLI vs direct core parity on the complete sample directory.
const sweepDir = resolve(root, 'tests/fixtures/samples');
const sweepFiles = (await readdir(sweepDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const sweepInputs = await Promise.all(
  sweepFiles.map(async (fileName) => ({
    fileName,
    bytes: new Uint8Array(await readFile(resolve(sweepDir, fileName))),
  })),
);
const directBodeCsv = csvMod.renderBodeCsv(pipelineMod.analyzeBodeBatch(sweepInputs)).replace(/\r\n/g, '\n').trimEnd();
const cliBodeCsv = (await run(process.execPath, ['dist-cli/cli/index.js', '--bode', sweepDir, '--csv']))
  .replace(/\r\n/g, '\n')
  .trimEnd();
if (cliBodeCsv !== directBodeCsv) {
  throw new Error('Browser/Node CLI Bode CSV parity mismatch');
}
console.log(`Bode batch CSV verified: ${sweepFiles.length} captures (${Buffer.byteLength(cliBodeCsv)} bytes)`);
