import { useMemo, useState } from 'react';
import type { BodePoint, BodePointOverride, BodeResult, Locale } from '../../core/types';
import { renderBodeSvg } from '../../core/export/svg';
import { formatDb, formatDeg, formatHertz, formatVolts, parseNumber, reasonLabel } from '../i18n';
import type { Dict } from '../i18n';

type EditKey = 'frequencyHz' | 'vinVpp' | 'voutVpp' | 'gainDb' | 'phaseDeg';

interface Props {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly result: BodeResult;
  readonly overrides: Readonly<Record<string, BodePointOverride>>;
  readonly inspectedId: string | null;
  readonly onEdit: (id: string, key: EditKey, value: number | null) => void;
  readonly onExclude: (id: string, excluded: boolean) => void;
  readonly onInspect: (id: string) => void;
  readonly onReset: () => void;
}

interface CellProps {
  readonly label: string;
  readonly display: string;
  readonly allowNegative: boolean;
  readonly commitOnBlurOnly?: boolean;
  readonly onCommit: (value: number | null) => void;
}

function EditCell({ label, display, allowNegative, commitOnBlurOnly, onCommit }: CellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = display === '—' ? '' : display;
  const push = (text: string): void => {
    if (text.trim() === '') {
      onCommit(null);
      return;
    }
    const v = parseNumber(text);
    if (v === null || !Number.isFinite(v)) return;
    if (!allowNegative && v <= 0) return;
    onCommit(v);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="cell num"
      aria-label={label}
      placeholder={'—'}
      value={draft ?? shown}
      onFocus={() => setDraft(shown)}
      onChange={(e) => {
        setDraft(e.target.value);
        if (!commitOnBlurOnly) push(e.target.value);
      }}
      onBlur={() => {
        if (commitOnBlurOnly && draft !== null) push(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (commitOnBlurOnly && draft !== null) push(draft);
          e.currentTarget.blur();
        }
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

function plainNumber(text: string): string {
  return text.replace(/\s*(dB|°)$/, '');
}

export function BodeView({ tx, locale, result, overrides, inspectedId, onEdit, onExclude, onInspect, onReset }: Props) {
  const svg = useMemo(() => renderBodeSvg(result, { locale, title: 'Bode' }), [result, locale]);
  const hasEdits = Object.keys(overrides).length > 0;

  const row = (p: BodePoint) => {
    const excluded = overrides[p.id]?.excluded === true;
    const reasons = p.rejectionReasons.map((r) => reasonLabel(r, locale));
    const warnings = p.warnings.map((w) => reasonLabel(w, locale));
    const cell = (key: EditKey, display: string, allowNegative: boolean) => (
      <td>
        <EditCell
          label={`${p.fileName} ${key}`}
          display={display}
          allowNegative={allowNegative}
          commitOnBlurOnly={key === 'frequencyHz'}
          onCommit={(v) => onEdit(p.id, key, v)}
        />
      </td>
    );
    return (
      <tr
        key={p.id}
        className={`${p.accepted ? 'ok' : 'rej'}${inspectedId === p.id ? ' sel' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('input, button, label, select')) return;
          onInspect(p.id);
        }}
      >
        <td>
          <input
            type="checkbox"
            checked={!excluded}
            aria-label={`${tx.includePoint} ${p.fileName}`}
            onChange={(e) => onExclude(p.id, !e.target.checked)}
          />
        </td>
        <td className="file">
          <button type="button" className="linklike" onClick={() => onInspect(p.id)} title={tx.inspect}>
            {p.fileName}
          </button>
          {p.edited && <span className="tag">{tx.edited}</span>}
        </td>
        {cell('frequencyHz', formatHertz(p.frequencyHz, locale), false)}
        {cell('vinVpp', formatVolts(p.vinVpp, locale), false)}
        {cell('voutVpp', formatVolts(p.voutVpp, locale), false)}
        {cell('gainDb', plainNumber(formatDb(p.gainDb, locale)), true)}
        {cell('phaseDeg', plainNumber(formatDeg(p.phaseDeg, locale)), true)}
        <td className="status">
          <span className={p.accepted ? 'dot on' : 'dot'} aria-hidden="true" />
          <span>{p.accepted ? tx.accepted : tx.rejected}</span>
          {reasons.length > 0 && <span className="reason">{reasons.join(', ')}</span>}
          {p.accepted && warnings.length > 0 && <span className="reason">{warnings.join(', ')}</span>}
        </td>
      </tr>
    );
  };

  return (
    <div className="bode">
      <div className="paper" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="toolbar">
        <span className="muted small grow">{tx.tableHint}</span>
        {hasEdits && (
          <button type="button" className="btn" onClick={onReset}>
            {tx.resetEdits}
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="grid-table bode-table">
          <thead>
            <tr>
              <th>{tx.colUse}</th>
              <th>{tx.colFile}</th>
              <th className="r">{tx.colFreq}</th>
              <th className="r">{tx.colVin}</th>
              <th className="r">{tx.colVout}</th>
              <th className="r">{tx.colGain}</th>
              <th className="r">{tx.colPhase}</th>
              <th>{tx.colStatus}</th>
            </tr>
          </thead>
          <tbody>{result.points.map(row)}</tbody>
        </table>
      </div>
    </div>
  );
}
