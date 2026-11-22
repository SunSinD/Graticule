import type { ChannelId, ExtractionOverrides, ExtractionResult, Locale, ProfileId } from '../../core/types';
import type { Dict } from '../i18n';
import { ScaleInput } from './ScaleInput';

export type ProfileChoice = ProfileId | 'auto';

const CHANNELS: readonly ChannelId[] = ['C1', 'C2', 'C3', 'C4'];

interface ProfileProps {
  readonly tx: Dict;
  readonly choice: ProfileChoice;
  readonly result: ExtractionResult | null;
  readonly onChoice: (choice: ProfileChoice) => void;
}

export function ProfilePanel({ tx, choice, result, onChoice }: ProfileProps) {
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
      <select aria-label="Profile" value={choice} onChange={(e) => onChoice(e.target.value as ProfileChoice)}>
        <option value="auto">{tx.profileAuto}</option>
        <option value="siglent-sds2000x-plus">Siglent SDS2000X Plus</option>
        <option value="rigol-ds1054z">Rigol DS1054Z</option>
        <option value="universal-fallback">Universal</option>
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
  readonly onOverrides: (next: ExtractionOverrides) => void;
}

type ChannelPatch = { enabled?: boolean; voltsPerDiv?: number; offsetVolts?: number };

export function ScaleControls({ tx, locale, result, overrides, disabled, onOverrides }: ScaleProps) {
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
