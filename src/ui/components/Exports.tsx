import { forwardRef, useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import type { Dict } from '../i18n';

export interface ExportSource {
  readonly baseName: string;
  readonly svg: () => string;
  readonly csv: () => string;
  readonly table: (format: 'html' | 'markdown' | 'tsv') => string;
}

interface Props {
  readonly tx: Dict;
  readonly source: ExportSource | null;
  readonly onSvg: (src: ExportSource) => void;
  readonly onPng: (src: ExportSource) => Promise<void>;
  readonly onCsv: (src: ExportSource) => void;
  readonly onCopy: (src: ExportSource, format: 'html' | 'markdown' | 'tsv') => Promise<void>;
}

export const ExportPanel = forwardRef<HTMLElement, Props>(function ExportPanel({ tx, source, onSvg, onPng, onCsv, onCopy }, ref) {
  const [feedback, setFeedback] = useState<string>('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flash = (text: string): void => {
    setFeedback(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFeedback(''), 1600);
  };

  const copy = (format: 'html' | 'markdown' | 'tsv') => {
    if (!source) return;
    onCopy(source, format).then(
      () => flash(tx.copied),
      () => flash(tx.copyFailed),
    );
  };

  const off = source === null;
  return (
    <section ref={ref} className="exports" tabIndex={-1} aria-labelledby="exports-title">
      <div className="section-head">
        <h2 id="exports-title">
          {tx.export} <kbd>E</kbd>
        </h2>
        <span className="feedback small" role="status" aria-live="polite">
          {feedback}
        </span>
      </div>
      <div className="btn-row">
        <button type="button" className="btn" disabled={off} onClick={() => source && onSvg(source)}>
          <Download size={16} aria-hidden="true" />
          <span>{tx.downloadSvg}</span>
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => source && void onPng(source)}>
          <Download size={16} aria-hidden="true" />
          <span>{tx.downloadPng}</span>
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => source && onCsv(source)}>
          <Download size={16} aria-hidden="true" />
          <span>{tx.downloadCsv}</span>
        </button>
      </div>
      <p className="label">{tx.copyTable}</p>
      <div className="btn-row">
        <button type="button" className="btn" disabled={off} onClick={() => copy('html')}>
          <Copy size={16} aria-hidden="true" />
          <span>{tx.copyWord}</span>
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => copy('markdown')}>
          {tx.copyMarkdown}
        </button>
        <button type="button" className="btn" disabled={off} onClick={() => copy('tsv')}>
          {tx.copyTsv}
        </button>
      </div>
    </section>
  );
});
