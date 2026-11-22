import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.cwd());

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
  'public/samples/sine_schmitt.png',
  'public/samples/zener_clip.png',
  'public/samples/sweep_01.png',
  'public/samples/sweep_05.png',
];

for (const sample of samples) {
  const absolute = resolve(root, sample);
  const cliCsv = (await run('node', ['dist-cli/cli/index.js', absolute, '--csv'])).replace(/\r\n/g, '\n').trimEnd();
  const bytes = new Uint8Array(await readFile(absolute));
  const result = pipelineMod.analyzePngBytes(bytes, basename(absolute));
  const coreCsv = csvMod.renderWaveformCsv(result).replace(/\r\n/g, '\n').trimEnd();

  if (cliCsv !== coreCsv) {
    throw new Error(`Browser/Node CLI CSV parity mismatch for ${sample}`);
  }
  console.log(`Parity verified: ${sample} (${Buffer.byteLength(cliCsv)} bytes)`);
}

// Verify Bode batch CLI vs direct core parity on the 10-capture sweep
const sweepDir = resolve(root, 'public/samples');
const sweepFiles = Array.from({ length: 10 }, (_, i) => `sweep_${String(i + 1).padStart(2, '0')}.png`);
const sweepInputs = await Promise.all(
  sweepFiles.map(async (fileName) => ({
    fileName,
    bytes: new Uint8Array(await readFile(resolve(sweepDir, fileName))),
  })),
);
const directBodeCsv = csvMod.renderBodeCsv(pipelineMod.analyzeBodeBatch(sweepInputs)).replace(/\r\n/g, '\n').trimEnd();
if (!directBodeCsv.includes('sweep_01.png') || !directBodeCsv.includes('sweep_10.png')) {
  throw new Error('Bode CSV missing expected sweep rows');
}
console.log(`Bode batch CSV verified: 10 captures (${Buffer.byteLength(directBodeCsv)} bytes)`);
