import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { computeMathTrace } from '../../src/core/math.js';
import { analyzePngBytes } from '../../src/core/pipeline.js';
import { buildBatchReportZip, emptyCaptureNote, svgToPngBytes } from '../../src/ui/batchExport.js';
import { formatWarning } from '../../src/ui/i18n.js';
import type { BatchExportEntry } from '../../src/ui/batchExport.js';
import * as download from '../../src/ui/download.js';
import { sample } from '../core/fixtures.js';

const pngBytes = Uint8Array.from(sample('sine_schmitt.png'));
const result = analyzePngBytes(pngBytes, 'source.png');

function capture(fileName: string, title?: string): BatchExportEntry {
  return { fileName, title, result };
}

function read(files: Record<string, Uint8Array>, name: string): string {
  return strFromU8(files[name]!);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('buildBatchReportZip', () => {
  test('writes all formats in stable numeric title order and reports progress for each capture', async () => {
    const entries = [
      capture('first.png', 'Scope 10'),
      capture('second.png', ' scope 2 '),
      capture('third.png', 'Scope 2'),
    ];
    const onProgress = vi.fn();
    const renderPng = vi.fn(async () => pngBytes);
    const files = unzipSync(await buildBatchReportZip(entries, { locale: 'en', onProgress, renderPng }));

    expect(Object.keys(files)).toEqual([
      'captures/scope-2.svg', 'captures/scope-2.png', 'captures/scope-2.csv',
      'captures/Scope-2-2.svg', 'captures/Scope-2-2.png', 'captures/Scope-2-2.csv',
      'captures/Scope-10.svg', 'captures/Scope-10.png', 'captures/Scope-10.csv',
      'report.md', 'report.tex', 'report.html',
    ]);
    expect(files['captures/scope-2.png']).toEqual(pngBytes);
    expect(read(files, 'captures/scope-2.svg')).toContain('fill="#ffffff"');
    expect(read(files, 'captures/scope-2.csv')).toContain('# title: scope 2\n');
    expect(renderPng.mock.calls).toEqual([
      [read(files, 'captures/scope-2.svg')],
      [read(files, 'captures/Scope-2-2.svg')],
      [read(files, 'captures/Scope-10.svg')],
    ]);
    expect(onProgress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(entries[0]?.title).toBe('Scope 10');

    const markdown = read(files, 'report.md');
    expect(markdown.match(/^## .+$/gm)).toEqual(['## scope 2', '## Scope 2', '## Scope 10']);
    expect(markdown).toContain('![scope 2](captures/scope-2.png)');
    expect(markdown).toContain('| Measurement |');
    const latex = read(files, 'report.tex');
    expect(latex).toContain('\\includegraphics[width=\\linewidth]{captures/scope-2.png}');
    expect(latex).toContain('\\begin{tabular}');
    const html = read(files, 'report.html');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<img src="captures/scope-2.png" alt="scope 2">');
    expect(html).toContain('<table ');
  });

  test('deduplicates stems, sanitizes paths and preserves existing PNGs', async () => {
    const entries = [
      { ...capture('cap.png'), pngBytes },
      { ...capture('cap.jpg', '   '), pngBytes },
      { ...capture('..\\../CON.png'), pngBytes },
      { ...capture('LPT1.png'), pngBytes },
    ];
    const renderPng = vi.fn(async () => pngBytes);
    const files = unzipSync(await buildBatchReportZip(entries, { locale: 'en', renderPng }));

    expect(Object.keys(files).filter(name => name.endsWith('.png'))).toEqual(expect.arrayContaining([
      'captures/cap.png', 'captures/cap-2.png', 'captures/_CON.png', 'captures/_LPT1.png',
    ]));
    expect(Object.keys(files)).toHaveLength(15);
    expect(files['captures/cap.png']).toEqual(pngBytes);
    expect(files['captures/cap-2.png']).toEqual(pngBytes);
    expect(renderPng).not.toHaveBeenCalled();
  });

  test('escapes titles and channel labels in the reports and SVG', async () => {
    const title = '<script>&" %_#$ [capture]';
    const channelLabels = { C1: '<script>&" %_#$ `input`' };
    const entry = { ...capture('source.png', title), channelLabels, pngBytes };
    const files = unzipSync(await buildBatchReportZip([entry], { locale: 'fr' }));
    const svgPath = Object.keys(files).find(name => name.endsWith('.svg'))!;
    const svg = read(files, svgPath);
    const html = read(files, 'report.html');
    const markdown = read(files, 'report.md');
    const latex = read(files, 'report.tex');

    expect(svg).toContain('&lt;script&gt;&amp;&quot; %_#$ [capture]');
    expect(svg).toContain('&lt;script&gt;&amp;&quot; %_#$ `input`');
    expect(svg).not.toContain('<script>');
    expect(html).toContain('lang="fr"');
    expect(html).toContain('<h2>&lt;script&gt;&amp;&quot; %_#$ [capture]</h2>');
    expect(html).toContain('&lt;script&gt;&amp;&quot; %_#$ `input`');
    expect(html).not.toContain('<script>');
    expect(markdown).toContain('\\<script\\>&#38;" %\\_\\#&#36; \\[capture\\]');
    expect(markdown).toContain('\\`input\\`');
    expect(markdown).not.toContain('&amp;#');
    expect(markdown).not.toContain('<script>');
    const escaped = '\\textless{}script\\textgreater{}\\&" \\%\\_\\#\\$';
    expect(latex).toContain('\\subsection{' + escaped + ' [capture]}');
    expect(latex).toContain(escaped + ' `input`');
    expect(latex).not.toContain('<script>');
  });

  test('uses the SVG in the reports when the Node environment has no PNG renderer', async () => {
    const files = unzipSync(await buildBatchReportZip([capture('cap.png')], { locale: 'en' }));

    expect(Object.keys(files)).toEqual(['captures/cap.svg', 'captures/cap.csv', 'report.md', 'report.tex', 'report.html']);
    expect(read(files, 'report.md')).toContain('![cap.png](captures/cap.svg)');
    expect(read(files, 'report.html')).toContain('<img src="captures/cap.svg"');
    expect(read(files, 'report.tex')).toContain('\\texttt{captures/cap.svg}');
    expect(read(files, 'report.tex')).not.toContain('\\includegraphics');
  });

  test('propagates PNG rendering failures without reporting an incomplete capture', async () => {
    const onProgress = vi.fn();
    const error = new Error('Could not render SVG');
    const renderPng = vi.fn().mockResolvedValueOnce(pngBytes).mockRejectedValueOnce(error);

    await expect(buildBatchReportZip([capture('1.png'), capture('2.png')], { locale: 'en', onProgress, renderPng }))
      .rejects.toBe(error);
    expect(onProgress.mock.calls).toEqual([[1, 2]]);
  });

  test('includes the Math trace in the plot, CSV and every report table', async () => {
    const math = computeMathTrace(result, { op: 'sub', a: 'C1', b: 'C2', label: 'Vdiff' });
    expect(math).not.toBeNull();
    const entry = { ...capture('cap.png', 'With math'), math, pngBytes };
    const files = unzipSync(await buildBatchReportZip([entry], { locale: 'en' }));

    expect(read(files, 'captures/With-math.svg')).toContain('Vdiff (V)');
    const csv = read(files, 'captures/With-math.csv');
    expect(csv).toContain('# M: Vdiff C1 sub C2');
    expect(csv).toMatch(/^.*,m_v,m_status$/m);
    expect(read(files, 'report.md')).toContain('Vdiff (V)');
    expect(read(files, 'report.tex')).toContain('Vdiff (V)');
    expect(read(files, 'report.html')).toContain('Vdiff (V)');

    const plain = unzipSync(await buildBatchReportZip([{ ...entry, math: null }], { locale: 'en' }));
    expect(read(plain, 'captures/With-math.csv')).not.toContain('# M:');
    expect(read(plain, 'report.md')).not.toContain('Vdiff');
  });

  test('explains a digital only capture in every report and leaves normal captures alone', async () => {
    const digital = {
      ...result,
      traces: [],
      detection: { ...result.detection, digitalOnly: true, warnings: ['digital_only'] },
    };
    const entries = [{ ...capture('logic.png'), result: digital, pngBytes }, { ...capture('sine.png'), pngBytes }];
    const en = unzipSync(await buildBatchReportZip(entries, { locale: 'en' }));
    const note = 'Note: this capture has no analog traces, so the plot and table are empty. Only digital channels were found.';

    expect(read(en, 'report.md')).toContain('> ' + note);
    expect(read(en, 'report.tex')).toContain('\\textit{' + note + '}');
    expect(read(en, 'report.html')).toContain('<p class="note">' + note + '</p>');
    for (const name of ['report.md', 'report.tex', 'report.html']) {
      expect(read(en, name).split('no analog traces')).toHaveLength(2);
    }

    const fr = unzipSync(await buildBatchReportZip(entries, { locale: 'fr' }));
    const noteFr = 'aucune trace analogique dans cette capture, le graphique et le tableau sont donc vides. '
      + 'Seuls des canaux numériques ont été trouvés.';
    expect(read(fr, 'report.md')).toContain(noteFr);
    expect(read(fr, 'report.tex')).toContain(noteFr);
    expect(read(fr, 'report.html')).toContain(noteFr);
  });

  test('creates a readable empty report without a progress event', async () => {
    const onProgress = vi.fn();
    const files = unzipSync(await buildBatchReportZip([], { locale: 'fr', onProgress }));

    expect(Object.keys(files)).toEqual(['report.md', 'report.tex', 'report.html']);
    expect(read(files, 'report.md')).toBe('# Rapport de laboratoire\n');
    expect(onProgress).not.toHaveBeenCalled();
  });

  test('strips the image extension before cleaning non ASCII and very long file names', async () => {
    const long = 'a'.repeat(198) + '.png';
    const files = unzipSync(await buildBatchReportZip(
      [{ ...capture('波形.png'), pngBytes }, { ...capture('Été.heif'), pngBytes }, { ...capture(long), pngBytes }],
      { locale: 'en' },
    ));
    const stems = Object.keys(files).filter((name) => name.endsWith('.csv')).map((name) => name.slice('captures/'.length, -4));

    expect(stems).toContain('graticule');
    expect(stems).toContain('Ete');
    const longStem = stems.find((stem) => stem.startsWith('aaa'))!;
    expect(longStem).toBe('a'.repeat(198));
    expect(stems.some((stem) => stem === 'png' || stem.endsWith('.p') || stem.endsWith('.png'))).toBe(false);
  });

  test('writes en and em dashes as LaTeX dashes', async () => {
    const files = unzipSync(await buildBatchReportZip([{ ...capture('a.png', 'Lab 3 – part 2 — final'), pngBytes }], { locale: 'en' }));

    expect(read(files, 'report.tex')).toContain('\\subsection{Lab 3 -- part 2 --- final}');
  });

  test('turns channel warning codes into clean sentences in both languages', () => {
    const empty = {
      ...result,
      traces: [],
      detection: { ...result.detection, warnings: ['zero_marker_mismatch:C1', 'unsupported_channel_unit:C3'] },
    };

    const en = emptyCaptureNote(empty, 'en')!;
    expect(en).toContain('C1: the offset on screen does not match the zero marker. Check the zero level.');
    expect(en).toContain('C3 is not in volts, so it was left out.');
    expect(en).not.toMatch(/zero marker mismatch|unsupported channel unit|_/);

    const fr = emptyCaptureNote(empty, 'fr')!;
    expect(fr).toContain('C1 : le décalage affiché ne correspond pas au repère du zéro.');
    expect(fr).toContain('C3 n’est pas en volts, il a donc été ignoré.');

    expect(formatWarning('digital_only', 'en')).toBe('Only digital channels were found.');
    expect(formatWarning('new_warning:C2', 'en')).toBe('C2: new warning');
  });
});

test('uses the shared PNG renderer at 2x by default and forwards a custom scale', async () => {
  const render = vi.spyOn(download, 'svgToPng').mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  vi.stubGlobal('document', {});
  vi.stubGlobal('Image', class {});

  expect(await svgToPngBytes('<svg/>', 3)).toEqual(new Uint8Array([112, 110, 103]));
  const files = unzipSync(await buildBatchReportZip([capture('cap.png')], { locale: 'en' }));

  expect(render.mock.calls).toEqual([['<svg/>', 3], [read(files, 'captures/cap.svg'), 2]]);
  expect(files['captures/cap.png']).toEqual(new Uint8Array([112, 110, 103]));
});
