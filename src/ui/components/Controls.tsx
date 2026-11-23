import type { ChannelId, ExtractionOverrides, ExtractionResult, Locale, MathConfig, MathOp, MathTraceResult, ProfileId } from '../../core/types';
import type { Dict } from '../i18n';
import type { ChannelLabels } from '../history';
import { ScaleInput } from './ScaleInput';
import { useRef, useState } from 'react';

export type ProfileChoice = ProfileId | 'auto';

const CHANNELS: readonly ChannelId[] = ['C1', 'C2', 'C3', 'C4'];

export const PROFILE_OPTIONS: readonly (readonly [ProfileId, string])[] = [
  ['siglent-sds2000x-plus', 'Siglent SDS2000X Plus'],
  ['siglent-sds1000x-e', 'Siglent SDS1000X-E'],
  ['rigol-ds1054z', 'Rigol DS1054Z'],
  ['rigol-dho924', 'Rigol DHO924'],
  ['rohde-schwarz-rtb2004', 'Rohde & Schwarz RTB2004'],
  ['tektronix-dpo7104c', 'Tektronix DPO7104C'],
  ['siglent-sds800x-hd', 'Siglent SDS800X HD'],
  ['keysight-dsox1000', 'Keysight DSOX1000'],
];

interface ProfileProps {
  readonly tx: Dict;
  readonly choice: ProfileChoice;
  readonly result: ExtractionResult | null;
  readonly disabled?: boolean;
  readonly onChoice: (choice: ProfileChoice) => void;
}

export function ProfilePanel({ tx, choice, result, disabled, onChoice }: ProfileProps) {
  const d = result?.detection;
  const notes = d ? [d.fallbackReason, ...d.warnings].filter((w, i, all): w is string => !!w && all.indexOf(w) === i) : [];
  return (
    <section>
      <h2>{tx.profile}</h2>
      {d && (
        <p className="badge">
          <span>{d.profileName}</span>
          <span className="num muted">{Math.round(d.confidence * 100)}%</span>
        </p>
      )}
      <select aria-label={tx.profile} value={choice} disabled={disabled} onChange={(e) => onChoice(e.target.value as ProfileChoice)}>
        <option value="auto">{tx.profileAuto}</option>
        {PROFILE_OPTIONS.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
        <option value="universal-fallback">{tx.profileUniversal}</option>
      </select>
      {notes.map((n) => (
        <p key={n} className="note">
          {tx.fallback[n] ?? n.replace(/_/g, ' ')}
        </p>
      ))}
    </section>
  );
}

interface ScaleProps {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly result: ExtractionResult | null;
  readonly overrides: ExtractionOverrides;
  readonly disabled: boolean;
  readonly labels?: ChannelLabels | undefined;
  readonly onOverrides: (next: ExtractionOverrides) => void;
  readonly onLabel?: (ch: ChannelId, label: string) => void;
  readonly math?: MathField | undefined;
}

export interface MathField {
  readonly config: MathConfig | null;
  readonly result: MathTraceResult | null;
  readonly onChange: (config: MathConfig | null) => void;
}

const MATH_OPS: readonly (readonly [MathOp, string])[] = [
  ['sub', '−'],
  ['add', '+'],
  ['mul', '×'],
];

export function mathAutoLabel(config: Pick<MathConfig, 'a' | 'b' | 'op'>): string {
  return `${config.a} ${config.op === 'sub' ? '-' : config.op === 'add' ? '+' : '×'} ${config.b}`;
}

function LabelInput({ id, label, placeholder, value, onCommit }: { id: string; label: string; placeholder: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const next = draft.trim().slice(0, 24);
    setDraft(null);
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id={id}
      type="text"
      className="ch-label"
      aria-label={label}
      placeholder={placeholder}
      maxLength={24}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          skip.current = true;
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

type ChannelPatch = { enabled?: boolean; voltsPerDiv?: number; offsetVolts?: number };

export function ScaleControls({ tx, locale, result, overrides, disabled, labels, onOverrides, onLabel, math }: ScaleProps) {
  const secPerDiv = overrides.secPerDiv ?? result?.timebase.secPerDiv ?? null;
  const patchChannel = (ch: ChannelId, patch: ChannelPatch): void => {
    const prev = overrides.channels?.[ch] ?? {};
    onOverrides({ ...overrides, channels: { ...overrides.channels, [ch]: { ...prev, ...patch } } });
  };
  const rows = CHANNELS.map((ch) => {
    const trace = result?.traces.find((tr) => tr.channel === ch);
    const o = overrides.channels?.[ch];
    const enabled = o?.enabled ?? trace?.settings.enabled ?? false;
    const canToggle = !disabled && Boolean(result);
    return { ch, trace, o, enabled, canToggle, locked: disabled || !result };
  });
  const active = rows.filter((r) => r.enabled);
  const inactive = rows.filter((r) => !r.enabled);
  const sources = active.filter((r) => r.trace?.settings.enabled).map((r) => r.ch);
  const canAddMath = Boolean(math && !math.config && result && !disabled && sources.length >= 2);
  const mathConfig = math?.config ?? null;
  return (
    <section>
      <ScaleInput
        id="time-div"
        label={tx.timePerDiv}
        value={secPerDiv}
        unit="s"
        locale={locale}
        stepper
        disabled={disabled || !result}
        decLabel={tx.decreaseTime}
        incLabel={tx.increaseTime}
        hint={result && !overrides.secPerDiv && result.timebase.source === 'default' ? tx.scaleDefault : null}
        onChange={(v) => onOverrides({ ...overrides, secPerDiv: v })}
      />
      <div className="section-head">
        <h2>{tx.channels}</h2>
        {(inactive.length > 0 || canAddMath) && (
          <div className="chips">
            {canAddMath && math && (
              <button
                type="button"
                className="btn chip"
                aria-label={tx.addMath}
                title={tx.addMath}
                onClick={() => math.onChange({ op: 'sub', a: sources[0]!, b: sources[1]! })}
              >
                + M
              </button>
            )}
            {inactive.map((c) => (
              <button
                key={c.ch}
                type="button"
                className="btn chip"
                disabled={!c.canToggle}
                aria-label={`${tx.enable} ${c.ch}`}
                title={`${tx.enable} ${c.ch}`}
                onClick={() => patchChannel(c.ch, { enabled: true })}
              >
                + {c.ch}
              </button>
            ))}
          </div>
        )}
      </div>
      {active.length > 0 && (
        <div className="channels">
          {active.map(({ ch, trace, o, locked }) => {
            const vdiv = o?.voltsPerDiv ?? trace?.settings.voltsPerDiv ?? 1;
            const off = o?.offsetVolts ?? trace?.settings.offsetVolts ?? 0;
            return (
              <fieldset key={ch} className="channel" disabled={locked}>
                <legend>
                  <label className="inline">
                    <input type="checkbox" checked onChange={(e) => patchChannel(ch, { enabled: e.target.checked })} />
                    <span className="ch">{ch}</span>
                  </label>
                  {onLabel && (
                    <LabelInput
                      id={`label-${ch}`}
                      label={`${tx.channelLabel} ${ch}`}
                      placeholder={tx.channelLabel}
                      value={labels?.[ch] ?? ''}
                      onCommit={(v) => onLabel(ch, v)}
                    />
                  )}
                </legend>
                <ScaleInput
                  id={`vdiv-${ch}`}
                  label={tx.voltsPerDiv}
                  value={vdiv}
                  unit="V"
                  locale={locale}
                  stepper
                  disabled={locked}
                  decLabel={tx.decreaseScale(ch)}
                  incLabel={tx.increaseScale(ch)}
                  hint={trace && !o?.voltsPerDiv && trace.settings.scaleSource === 'default' ? tx.scaleDefault : null}
                  onChange={(v) => patchChannel(ch, { voltsPerDiv: v })}
                />
                <ScaleInput
                  id={`off-${ch}`}
                  label={tx.offset}
                  value={off}
                  unit="V"
                  locale={locale}
                  allowZero
                  disabled={locked}
                  onChange={(v) => patchChannel(ch, { offsetVolts: v })}
                />
              </fieldset>
            );
          })}
          {math && mathConfig && (
            <MathCard tx={tx} locale={locale} field={math} config={mathConfig} sources={sources} disabled={disabled || !result} />
          )}
        </div>
      )}
    </section>
  );
}

interface MathCardProps {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly field: MathField;
  readonly config: MathConfig;
  readonly sources: readonly ChannelId[];
  readonly disabled: boolean;
}

function MathCard({ tx, locale, field, config, sources, disabled }: MathCardProps) {
  const set = (patch: Partial<MathConfig>): void => field.onChange({ ...config, ...patch });
  const options = (current: ChannelId) => (sources.includes(current) ? sources : [current, ...sources]);
  const unit = config.op === 'mul' ? 'V²' : 'V';
  return (
    <fieldset className="channel math" disabled={disabled}>
      <legend>
        <label className="inline" title={tx.removeMath}>
          <input type="checkbox" checked aria-label={tx.removeMath} onChange={() => field.onChange(null)} />
          <span className="ch">M</span>
        </label>
        <LabelInput
          id="label-M"
          label={tx.mathLabel}
          placeholder={mathAutoLabel(config)}
          value={config.label ?? ''}
          onCommit={(v) => {
            const { label: _drop, ...rest } = config;
            field.onChange(v ? { ...rest, label: v } : rest);
          }}
        />
      </legend>
      <div className="math-row">
        <select aria-label={tx.mathA} value={config.a} onChange={(e) => set({ a: e.target.value as ChannelId })}>
          {options(config.a).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select aria-label={tx.mathOp} className="op" value={config.op} onChange={(e) => set({ op: e.target.value as MathOp })}>
          {MATH_OPS.map(([op, sym]) => (
            <option key={op} value={op}>
              {sym}
            </option>
          ))}
        </select>
        <select aria-label={tx.mathB} value={config.b} onChange={(e) => set({ b: e.target.value as ChannelId })}>
          {options(config.b).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <ScaleInput
        id="vdiv-M"
        label={tx.mathVdiv}
        value={config.voltsPerDiv ?? field.result?.voltsPerDiv ?? null}
        unit={unit}
        locale={locale}
        stepper
        disabled={disabled || !field.result}
        decLabel={tx.decreaseScale('M')}
        incLabel={tx.increaseScale('M')}
        hint={config.voltsPerDiv === undefined ? tx.mathAuto : null}
        onChange={(v) => set({ voltsPerDiv: v })}
      />
    </fieldset>
  );
}
