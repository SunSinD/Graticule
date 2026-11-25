import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { Locale } from '../../core/types';
import { formatEng, parseNumber, stepScale125 } from '../i18n';

interface Props {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: 'V' | 'V²' | 's';
  readonly locale: Locale;
  readonly disabled?: boolean;
  readonly stepper?: boolean;
  readonly allowZero?: boolean;
  readonly decLabel?: string;
  readonly incLabel?: string;
  readonly hint?: string | null;
  readonly uncalibrated?: boolean;
  readonly onChange: (value: number) => void;
}

type Unit = Props['unit'];

const RANGE: Readonly<Record<Unit, readonly [number, number]>> = {
  s: [1e-12, 1e4],
  V: [1e-12, 1e4],
  'V²': [1e-24, 1e8],
};

/** True for a typed value a scope could really use. Typos such as 1e-30 or 5e9 are refused. */
export function acceptScale(v: number | null, unit: Unit, allowZero = false): v is number {
  if (v === null || !Number.isFinite(v)) return false;
  if (v === 0) return allowZero;
  if (v < 0 && !allowZero) return false;
  const [lo, hi] = RANGE[unit];
  const size = Math.abs(v);
  return size >= lo && size <= hi;
}

const UNIT_TAIL = /(hz|db|div|v²|v2|v|s|°|%|a)$/;
const UNIT_OK: Readonly<Record<Unit, readonly string[]>> = {
  s: ['s', 'div'],
  V: ['v', 'div'],
  'V²': ['v²', 'v2', 'div'],
};

/** False when the text ends in a unit that does not belong in this field, such as ms in a volt field. */
export function unitFits(text: string, unit: Unit): boolean {
  const tail = UNIT_TAIL.exec(text.trim().replace(/\s+/g, '').replace(/\/div$/i, '').toLowerCase());
  return !tail || UNIT_OK[unit].includes(tail[1]!);
}

/** Parses a typed scale, refusing a unit from another kind of field. */
export function parseScale(text: string, unit: Unit): number | null {
  return unitFits(text, unit) ? parseNumber(text) : null;
}

/** The next 1 2 5 step, kept inside the range the field accepts. */
export function stepWithin(value: number, dir: 1 | -1, unit: Unit): number {
  const [lo, hi] = RANGE[unit];
  const next = Math.min(hi, Math.max(lo, stepScale125(value, dir)));
  return (dir > 0 ? next > value : next < value) ? next : value;
}

/** True when a stepper button can still move the value in that direction. */
export function canStep(value: number | null, dir: 1 | -1, unit: Unit): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  return stepWithin(value, dir, unit) !== value;
}

export function ScaleInput(props: Props) {
  const { id, label, value, unit, locale, disabled, stepper, allowZero, decLabel, incLabel, hint, uncalibrated, onChange } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value === null ? '' : formatEng(value, unit, locale, { sig: 4, trim: true, empty: '' });

  const commit = (confirmDefault = false): void => {
    if (draft === null && !(confirmDefault && uncalibrated)) return;
    setDraft(null);
    const v = draft === null || draft.trim() === shown ? value : parseScale(draft, unit);
    if (!acceptScale(v, unit, allowZero)) return;
    if (v !== value || uncalibrated) onChange(v);
  };

  const step = (dir: 1 | -1): void => {
    if (!canStep(value, dir, unit)) return;
    onChange(stepWithin(value!, dir, unit));
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={stepper ? 'stepper' : 'stepper solo'}>
        {stepper && (
          <button type="button" className="btn icon" aria-label={decLabel} title={decLabel} disabled={disabled || !canStep(value, -1, unit)} onClick={() => step(-1)}>
            <Minus size={16} aria-hidden="true" />
          </button>
        )}
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="num"
          disabled={disabled}
          value={draft ?? shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
        {stepper && (
          <button type="button" className="btn icon" aria-label={incLabel} title={incLabel} disabled={disabled || !canStep(value, 1, unit)} onClick={() => step(1)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
