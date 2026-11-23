import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BodePoint, BodePointOverride, BodeResult, Locale } from '../../core/types';
import { renderBodeSvg } from '../../core/export/svg';
import { formatDb, formatDeg, formatHertz, formatVolts, parseNumber, reasonLabel } from '../i18n';
import type { Dict } from '../i18n';
import { svgRatio, useCtrlWheelZoom, ZoomControl } from './ZoomControl';

const ZOOM_MAX = 250;

type EditKey = 'frequencyHz' | 'vinVpp' | 'voutVpp' | 'gainDb' | 'phaseDeg';

interface Props {
  readonly tx: Dict;
  readonly locale: Locale;
  readonly dark: boolean;
  readonly result: BodeResult;
  readonly title?: string;
  /** Controlled zoom in percent, so it survives leaving the view to inspect a capture. */
  readonly zoom?: number;
  readonly onZoom?: (zoom: number) => void;
  readonly overrides: Readonly<Record<string, BodePointOverride>>;
  readonly inspectedId: string | null;
  readonly focusId?: string | null;
  readonly onFocused?: () => void;
  readonly onEdit: (id: string, key: EditKey, value: number | null) => void;
  readonly onExclude: (id: string, excluded: boolean) => void;
  readonly onInspect: (id: string) => void;
  readonly onReset: () => void;
  /** Builds the zip lab report from every selected capture, as on the staged screen. */
  readonly onExportAll?: (() => void) | undefined;
  readonly exportBusy?: boolean;
}

interface CellProps {
  readonly label: string;
  readonly display: string;
  readonly allowNegative: boolean;
  readonly onCommit: (value: number | null) => void;
}

function EditCell({ label, display, allowNegative, onCommit }: CellProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = display === '—' ? '' : display;
  const push = (text: string): void => {
    if (text.trim() === shown.trim()) return;
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
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) push(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          // Reverts but keeps focus, so Tab still moves to the next cell.
          e.preventDefault();
          e.stopPropagation();
          setDraft(shown);
        }
      }}
    />
  );
}

function plainNumber(text: string): string {
  return text.replace(/\s*(dB|°)$/, '');
}

export function BodeView(props: Props) {
  const { tx, locale, dark, result, overrides, inspectedId, focusId, onFocused, onEdit, onExclude, onInspect, onReset } = props;
  const plotTitle = props.title?.trim() || 'Bode';
  const svg = useMemo(
    () => renderBodeSvg(result, { locale, title: plotTitle, theme: dark ? 'dark' : 'light' }),
    [result, locale, dark, plotTitle],
  );
  const hasEdits = Object.keys(overrides).length > 0;
  const [ownZoom, setOwnZoom] = useState(100);
  const zoom = props.zoom ?? ownZoom;
  const setZoom = props.onZoom ?? setOwnZoom;
  const viewport = useRef<HTMLDivElement>(null);
  useCtrlWheelZoom(viewport, zoom, ZOOM_MAX, setZoom);
  const table = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    if (!focusId) return;
    const buttons = table.current?.querySelectorAll<HTMLButtonElement>('td.file .linklike') ?? [];
    for (const b of buttons) {
      if (b.dataset.point === focusId) {
        b.focus();
        break;
      }
    }
    onFocused?.();
  }, [focusId, onFocused]);

  const row = (p: BodePoint) => {
    const excluded = overrides[p.id]?.excluded === true;
    const reasons = p.rejectionReasons.map((r) => reasonLabel(r, locale));
    const warnings = p.warnings.map((w) => reasonLabel(w, locale));
    const cell = (key: EditKey, display: string, allowNegative: boolean) => (
      <td>
        <EditCell
          label={`${p.fileName} ${tx.cellLabels[key] ?? key}`}
          display={display}
          allowNegative={allowNegative}
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
          <button type="button" className="linklike" data-point={p.id} onClick={() => onInspect(p.id)} title={tx.inspect}>
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
      <div className="toolbar">
        {props.onExportAll && (
          <button type="button" className="btn" disabled={props.exportBusy} onClick={props.onExportAll}>
            {tx.exportAll}
          </button>
        )}
        <span className="grow" />
        <ZoomControl tx={tx} value={zoom} max={ZOOM_MAX} onChange={setZoom} />
      </div>
      <div ref={viewport} className="viewport paper">
        <div
          className="canvas plot"
          style={{ '--ar': svgRatio(svg, 4 / 3), '--z': zoom / 100 } as CSSProperties}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
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
          <tbody ref={table}>{result.points.map(row)}</tbody>
        </table>
      </div>
    </div>
  );
}
