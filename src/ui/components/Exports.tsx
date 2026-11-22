import { forwardRef, useRef, useState } from 'react';
import type { TableFormat } from '../../core/export/table';
import type { Dict } from '../i18n';

export interface ExportSource {
  readonly baseName: string;
  readonly svg: () => string;
  readonly csv: () => string;
  readonly table: (format: TableFormat) => string;
}

export interface TitleField {
  readonly value: string;
  readonly placeholder: string;
  readonly onCommit: (value: string) => void;
}

interface Props {
  readonly tx: Dict;
  readonly source: ExportSource | null;
  readonly feedback: string;
  readonly title: TitleField | null;
  readonly onSvg: (src: ExportSource) => void;
  readonly onPng: (src: ExportSource) => void;
  readonly onCsv: (src: ExportSource) => void;
  readonly onCopyPlot: (src: ExportSource) => void;
  readonly onCopyTable: (src: ExportSource, format: TableFormat) => void;
}

function TitleInput({ tx, field, disabled }: { tx: Dict; field: TitleField; disabled: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const skip = useRef(false);
  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const next = draft.trim().slice(0, 120);
    setDraft(null);
    if (next !== field.value) field.onCommit(next);
  };
  return (
    <label className="title-field">
      <span>{tx.title}</span>
      <input
        type="text"
        value={draft ?? field.value}
        placeholder={field.placeholder}
        disabled={disabled}
        maxLength={120}
        onFocus={() => setDraft(field.value)}
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
    </label>
  );
}

export const ExportPanel = forwardRef<HTMLElement, Props>(function ExportPanel(props, ref) {
  const { tx, source, feedback, title } = props;
  const off = source === null;
  const run = (fn: (src: ExportSource) => void) => () => {
    if (source) fn(source);
  };
  const tables: readonly (readonly [TableFormat, string])[] = [
    ['html', tx.copyWord],
    ['markdown', tx.copyMarkdown],
    ['latex', tx.copyLatex],
    ['tsv', tx.copyTsv],
  ];
  return (
    <section ref={ref} className="exports" tabIndex={-1} aria-labelledby="exports-title">
      <div className="section-head">
        <h2 id="exports-title">
          {tx.export} <kbd>E</kbd>
        </h2>
        <span className="feedback small" role="status" aria-live="polite" data-testid="export-feedback">
          {feedback}
        </span>
      </div>
      {title && <TitleInput key={title.placeholder} tx={tx} field={title} disabled={off} />}
      <div className="btn-grid">
        <button type="button" className="btn" disabled={off} onClick={run(props.onSvg)}>
          {tx.downloadSvg}
        </button>
        <button type="button" className="btn" disabled={off} onClick={run(props.onPng)}>
          {tx.downloadPng}
        </button>
        <button type="button" className="btn" disabled={off} onClick={run(props.onCsv)}>
          {tx.downloadCsv}
        </button>
        <button
          type="button"
          className="btn"
          disabled={off}
          onClick={run(props.onCopyPlot)}
          title={tx.copyPlotTitle}
          aria-keyshortcuts="Control+C"
        >
          {tx.copyPlot}
        </button>
      </div>
      <p className="label">{tx.copyTable}</p>
      <div className="btn-grid">
        {tables.map(([format, label]) => (
          <button key={format} type="button" className="btn" disabled={off} onClick={() => source && props.onCopyTable(source, format)}>
            {label}
          </button>
        ))}
      </div>
    </section>
  );
});
