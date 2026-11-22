import fs from 'node:fs';
import path from 'node:path';

const FORBIDDEN = [
  { char: '\u2014', name: 'em dash' },
  { char: '\u2013', name: 'en dash' },
  { char: '-', name: 'hyphen' },
  { char: ';', name: 'semicolon' },
  { char: '\u2022', name: 'separator dot' },
];

function stripAllowedSegments(line) {
  let s = line;
  // Remove markdown table separator rows (e.g. | --- | --- |)
  if (/^\s*\|?[\s|:-]+\|?\s*$/.test(s) && s.includes('-')) return '';
  // Remove fenced code blocks handled by caller; remove inline code `...`
  s = s.replace(/`[^`]*`/g, ' ');
  // Remove markdown links [label](url) -> keep label only so URLs/paths are preserved
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Remove bare URLs
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // Remove leading markdown bullet marker "- "
  s = s.replace(/^\s*-\s+/, '');
  // Remove CLI flags or file paths with slashes like src/core/foo-bar.ts
  s = s.replace(/\b[\w.]+\/[\w./-]+\b/g, ' ');
  // Remove negative numbers like -3 dB or -180
  s = s.replace(/(^|\s)-\d+(\.\d+)?/g, '$1 ');
  return s;
}

export function checkMarkdownProse(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const errors = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const prose = stripAllowedSegments(line);
    for (const rule of FORBIDDEN) {
      const idx = prose.indexOf(rule.char);
      if (idx !== -1) {
        errors.push({
          file: filePath,
          line: i + 1,
          rule: rule.name,
          excerpt: line.trim(),
        });
      }
    }
  }
  return errors;
}

const targets = process.argv.slice(2);
const files = targets.length > 0
  ? targets
  : ['README.md', 'RELEASE_NOTES.md'].filter((f) => fs.existsSync(path.resolve(f)));

let failed = false;
for (const f of files) {
  const errs = checkMarkdownProse(path.resolve(f));
  if (errs.length > 0) {
    failed = true;
    for (const e of errs) {
      console.error(`${e.file}:${e.line}: forbidden ${e.rule} in prose -> ${e.excerpt}`);
    }
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log(`Prose check passed (${files.join(', ')})`);
}
