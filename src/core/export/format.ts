import type { Locale } from '../types.js';

export const GRATICULE_VERSION = '2.0.3';
export const EMPTY_CELL = '\u2014';

export function spreadsheetText(text: string): string {
  return /^ *[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

interface SiPrefix {
  readonly exp: number;
  readonly symbol: string;
}

const SI_PREFIXES: readonly SiPrefix[] = [
  { exp: -12, symbol: 'p' },
  { exp: -9, symbol: 'n' },
  { exp: -6, symbol: '\u00b5' },
  { exp: -3, symbol: 'm' },
  { exp: 0, symbol: '' },
  { exp: 3, symbol: 'k' },
  { exp: 6, symbol: 'M' },
  { exp: 9, symbol: 'G' },
];

interface FixedUnit {
  readonly digits: number;
  readonly space: boolean;
}

const FIXED_UNITS: Readonly<Record<string, FixedUnit>> = {
  '%': { digits: 1, space: false },
  '\u00b0': { digits: 1, space: false },
  deg: { digits: 1, space: true },
  dB: { digits: 2, space: true },
  div: { digits: 2, space: true },
};

export interface EngFormatOptions {
  readonly sig?: number;
  readonly trim?: boolean;
  readonly empty?: string;
  readonly signed?: boolean;
}

export function localizeDecimal(text: string, locale: Locale): string {
  return locale === 'fr' ? text.replace(/\./g, ',') : text;
}

function cleanNegativeZero(text: string): string {
  return /^-0+(\.0+)?$/.test(text) ? text.slice(1) : text;
}

export function trimTrailingZeros(text: string): string {
  if (!text.includes('.') || /e/i.test(text)) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function withSign(text: string, value: number, signed: boolean | undefined): string {
  if (!signed || value <= 0 || text.startsWith('-')) return text;
  return /^0+([.,]0+)?(\s|$)/.test(text) ? text : `+${text}`;
}

export function formatFixed(
  value: number | null | undefined,
  digits: number,
  locale: Locale = 'en',
  empty: string = EMPTY_CELL,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return empty;
  return localizeDecimal(cleanNegativeZero(value.toFixed(digits)), locale);
}

function scaleByPow10(value: number, exp: number): number {
  return exp < 0 ? value * 10 ** -exp : value / 10 ** exp;
}

export function engParts(value: number, sig: number): { readonly mantissa: string; readonly prefix: string } {
  if (value === 0 || !Number.isFinite(value)) return { mantissa: (0).toPrecision(sig), prefix: '' };
  let exp = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  exp = Math.min(9, Math.max(-12, exp));
  let mantissa = scaleByPow10(value, exp).toPrecision(sig);
  if (Math.abs(Number(mantissa)) >= 1000 && exp < 9) {
    exp += 3;
    mantissa = scaleByPow10(value, exp).toPrecision(sig);
  }
  const prefix = SI_PREFIXES.find((p) => p.exp === exp)?.symbol ?? '';
  return { mantissa: cleanNegativeZero(mantissa), prefix };
}

export function formatEng(
  value: number | null | undefined,
  unit: string,
  locale: Locale = 'en',
  options: EngFormatOptions = {},
): string {
  const empty = options.empty ?? EMPTY_CELL;
  if (value === null || value === undefined || !Number.isFinite(value)) return empty;
  const fixed = FIXED_UNITS[unit];
  if (fixed) {
    let text = cleanNegativeZero(value.toFixed(fixed.digits));
    if (options.trim) text = trimTrailingZeros(text);
    text = withSign(text, value, options.signed);
    return `${localizeDecimal(text, locale)}${fixed.space ? ' ' : ''}${unit}`;
  }
  if (unit === 'V²') {
    const raw = cleanNegativeZero(value.toPrecision(options.sig ?? 4));
    const text = withSign(options.trim ? trimTrailingZeros(raw) : raw, value, options.signed);
    return `${localizeDecimal(text, locale)} ${unit}`;
  }
  const { mantissa, prefix } = engParts(value, options.sig ?? 4);
  let text = options.trim ? trimTrailingZeros(mantissa) : mantissa;
  text = withSign(text, value, options.signed);
  const suffix = `${prefix}${unit}`;
  const localized = localizeDecimal(text, locale);
  return suffix ? `${localized} ${suffix}` : localized;
}

export function formatPercent(value: number | null | undefined, locale: Locale = 'en', digits = 1, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_CELL;
  const text = withSign(cleanNegativeZero(value.toFixed(digits)), value, signed);
  return `${localizeDecimal(text, locale)}%`;
}

export function csvNumber(value: number | null | undefined, sig = 9): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const rounded = Number(value.toPrecision(sig));
  return rounded === 0 ? '0' : String(rounded);
}

function cleanFloat(value: number): number {
  return Number(value.toPrecision(12));
}

export function stepScale125(value: number, dir: 1 | -1): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.max(-323, Math.floor(Math.log10(value)));
  const eps = 1e-6;
  for (const coefficient of dir > 0 ? [1, 2, 5, 10, 20] : [5, 2, 1, 0.5, 0.2]) {
    const candidate = Number(`${coefficient}e${exp}`);
    if (!Number.isFinite(candidate) || candidate === 0) continue;
    const ratio = candidate / value;
    if (dir > 0 ? ratio > 1 + eps : ratio < 1 - eps) return candidate;
  }
  return value;
}

const MULTIPLIERS: Readonly<Record<string, number>> = {
  '': 1,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  '\u00b5': 1e-6,
  '\u03bc': 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

const UNIT_SUFFIXES: readonly string[] = ['hz', 'db', 'div', 'v²', 'v2', 'v', 's', '\u00b0', '%', 'a'];

export function parseEngineering(input: string): number | null {
  const text = input.trim().replace(/,/g, '.').replace(/\u2212/g, '-');
  const match = /^([+-]?)\s*((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i.exec(text);
  if (!match) return null;
  const base = Number(match[1]! + match[2]!);
  if (!Number.isFinite(base)) return null;
  let rest = text.slice(match[0].length).replace(/\s+/g, '').replace(/\/div$/i, '');
  const lower = rest.toLowerCase();
  for (const unit of UNIT_SUFFIXES) {
    if (lower.endsWith(unit)) {
      rest = rest.slice(0, rest.length - unit.length);
      break;
    }
  }
  const mult = MULTIPLIERS[rest];
  if (mult === undefined) return null;
  const value = cleanFloat(base * mult);
  return Number.isFinite(value) ? value : null;
}
