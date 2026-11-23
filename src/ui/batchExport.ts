import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { renderWaveformCsv } from '../core/export/csv.js';
import { escapeXml, renderWaveformSvg } from '../core/export/svg.js';
import { renderMeasurementsTable } from '../core/export/table.js';
import type { ChannelId, ExtractionResult, Locale } from '../core/types.js';
import { baseName, svgToPng } from './download.js';

export interface BatchExportEntry {
  readonly fileName: string;
  readonly title?: string;
  readonly channelLabels?: Partial<Record<ChannelId, string>>;
  readonly result: ExtractionResult;
  readonly pngBytes?: Uint8Array;
}

export interface BatchExportOptions {
  readonly locale: Locale;
  readonly onProgress?: (done: number, total: number) => void;
  readonly renderPng?: (svg: string) => Promise<Uint8Array>;
}

function safeStem(name: string): string {
  const ascii = name.trim().normalize('NFKD').replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '');
  return baseName(ascii.slice(0, 200));
}

function uniqueStem(name: string, used: Set<string>): string {
  const stem = safeStem(name);
  let candidate = stem;
  for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
    candidate = stem + '-' + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function inlineText(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ');
}

function markdownLiterals(text: string): string {
  return inlineText(text)
    .replace(/[&\x60~$:@]/g, char => '&#' + char.charCodeAt(0) + ';')
    .replace(/\bwww\./gi, prefix => prefix.slice(0, -1) + '&#46;');
}

function markdownText(text: string): string {
  return markdownLiterals(text.replace(/[\\_*[\]<>|#]/g, '\\$&'));
}

const LATEX_CHARS: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%',
  '$': '\\$', '#': '\\#', '_': '\\_', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}',
  '°': '\\textdegree{}', 'µ': '\\textmu{}', 'μ': '\\textmu{}', '−': '\\ensuremath{-}',
  'Δ': '\\ensuremath{\\Delta}', '→': '\\ensuremath{\\to}', '≤': '\\ensuremath{\\leq}',
};

function latexText(text: string): string {
  return inlineText(text).replace(/[\\{}&%$#_^~<>|°µμ−Δ→≤]/g, char => LATEX_CHARS[char]!);
}

export async function svgToPngBytes(svg: string, scale = 2): Promise<Uint8Array> {
  const png = await svgToPng(svg, scale);
  return new Uint8Array(await png.arrayBuffer());
}

export async function buildBatchReportZip(
  entries: readonly BatchExportEntry[],
  options: BatchExportOptions,
): Promise<Uint8Array> {
  const { locale } = options;
  const renderPng = options.renderPng
    ?? (typeof document !== 'undefined' && typeof Image !== 'undefined' ? svgToPngBytes : undefined);
  const sorted = entries.map(entry => ({ entry, title: entry.title?.trim() || entry.fileName }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
  const files: Zippable = {};
  const stems = new Set<string>();
  const reportTitle = locale === 'fr' ? 'Rapport de laboratoire' : 'Lab report';
  const markdown = ['# ' + reportTitle];
  const latex = ['% Requires \\usepackage{graphicx}', '\\section{' + reportTitle + '}'];
  const html = [
    '<!doctype html>',
    '<html lang="' + locale + '">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>' + reportTitle + '</title>',
    '<style>',
    'body { font: 11pt Calibri, Arial, sans-serif; color: #000; background: #fff; }',
    'h2 { break-after: avoid; }',
    'img { display: block; max-width: 100%; height: auto; margin: 0 0 12pt; break-inside: avoid; }',
    '</style>',
    '</head>',
    '<body>',
    '<h1>' + reportTitle + '</h1>',
  ];

  for (const [index, { entry, title }] of sorted.entries()) {
    const { result, channelLabels } = entry;
    const path = 'captures/' + uniqueStem(title, stems);
    const svg = renderWaveformSvg(result, { theme: 'light', locale, title, channelLabels });
    const png = entry.pngBytes ?? await renderPng?.(svg);
    const figure = path + (png ? '.png' : '.svg');
    files[path + '.svg'] = strToU8(svg);
    if (png) files[figure] = [png, { level: 0 }];
    files[path + '.csv'] = strToU8(renderWaveformCsv(result, channelLabels, title));

    const markdownLabels = channelLabels && Object.fromEntries(Object.entries(channelLabels)
      .map(([channel, label]) => [channel, label === undefined ? undefined : markdownLiterals(label)]));
    const titleMd = markdownText(title);
    markdown.push(
      '## ' + titleMd,
      '![' + titleMd + '](' + figure + ')',
      renderMeasurementsTable(result, 'markdown', locale, markdownLabels, markdownLiterals(title)).trimEnd(),
    );
    latex.push(
      '\\subsection{' + latexText(title) + '}',
      png
        ? '\\begin{center}\n\\includegraphics[width=\\linewidth]{' + figure + '}\n\\end{center}'
        : '\\noindent\\texttt{' + latexText(figure) + '}\\par',
      renderMeasurementsTable(result, 'latex', locale, channelLabels, title).trimEnd(),
    );
    const titleHtml = escapeXml(title);
    html.push(
      '<section>',
      '<h2>' + titleHtml + '</h2>',
      '<img src="' + figure + '" alt="' + titleHtml + '">',
      renderMeasurementsTable(result, 'html', locale, channelLabels, title),
      '</section>',
    );
    options.onProgress?.(index + 1, sorted.length);
  }

  html.push('</body>', '</html>');
  files['report.md'] = strToU8(markdown.join('\n\n') + '\n');
  files['report.tex'] = strToU8(latex.join('\n\n') + '\n');
  files['report.html'] = strToU8(html.join('\n') + '\n');
  return zipSync(files);
}
