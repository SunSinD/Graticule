import type { ChannelId, ExtractionOverrides, ExtractionResult, Locale, ProfileId } from '../../core/types';
import type { Dict } from '../i18n';
import type { ChannelLabels } from '../history';
import { ScaleInput } from './ScaleInput';
import { useState } from 'react';

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
}

function LabelInput({ id, label, placeholder, value, onCommit }: { id: string; label: string; placeholder: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
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
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

type ChannelPatch = { enabled?: boolean; voltsPerDiv?: number; offsetVolts?: number };

export function ScaleControls({ tx, locale, result, overrides, disabled, labels, onOverrides, onLabel }: ScaleProps) {
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
        {inactive.length > 0 && (
          <div className="chips">
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
        </div>
      )}
    </section>
  );
}
