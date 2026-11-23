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

export function ScaleInput(props: Props) {
  const { id, label, value, unit, locale, disabled, stepper, allowZero, decLabel, incLabel, hint, onChange } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = value === null ? '' : formatEng(value, unit, locale, { sig: 4, trim: true, empty: '' });

  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === shown) return;
    const v = parseNumber(draft);
    if (!acceptScale(v, unit, allowZero)) return;
    if (v !== value) onChange(v);
  };

  const step = (dir: 1 | -1): void => {
    if (value === null) return;
    onChange(stepScale125(value, dir));
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={stepper ? 'stepper' : 'stepper solo'}>
        {stepper && (
          <button type="button" className="btn icon" aria-label={decLabel} title={decLabel} disabled={disabled || value === null} onClick={() => step(-1)}>
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
          onFocus={() => setDraft(shown)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDraft(shown);
            }
          }}
        />
        {stepper && (
          <button type="button" className="btn icon" aria-label={incLabel} title={incLabel} disabled={disabled || value === null} onClick={() => step(1)}>
            <Plus size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
