import { FilePlus, FolderPlus } from 'lucide-react';
import type { BodeResult } from '../../core/types';
import type { LoadedFile } from '../files';
import type { Dict } from '../i18n';
import { SAMPLE_IDS, sampleLabel } from './EmptyState';
import type { SampleId } from './EmptyState';
import type { AppMode } from './TopBar';

interface Props {
  readonly tx: Dict;
  readonly mode: AppMode;
  readonly files: readonly LoadedFile[];
  readonly bode: BodeResult | null;
  readonly activeName: string | null;
  readonly onAddFiles: () => void;
  readonly onAddFolder: () => void;
  readonly onSelect: (file: LoadedFile) => void;
  readonly activeSample: SampleId | null;
  readonly onSample: (id: SampleId) => void;
  readonly onClear: () => void;
}

export function FilePanel({ tx, mode, files, bode, activeName, onAddFiles, onAddFolder, onSelect, activeSample, onSample, onClear }: Props) {
  const statusFor = (name: string): boolean | null => {
    if (!bode) return null;
    const p = bode.points.find((pt) => pt.fileName === name);
    return p ? p.accepted : null;
  };
  return (
    <aside className="zone left" aria-label={tx.files}>
      <section className="left-scroll">
        <div className="section-head">
          <h2>{tx.files}</h2>
          {files.length > 0 && (
            <button type="button" className="btn chip" onClick={onClear}>
              {tx.clear}
            </button>
          )}
        </div>
        {files.length > 0 && (
          <ul className="files">
            {files.map((f) => {
              const s = mode === 'bode' ? statusFor(f.name) : null;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    className={`file-row${activeName === f.name ? ' sel' : ''}`}
                    onClick={() => onSelect(f)}
                    title={s === null ? f.name : `${f.name} ${s ? tx.accepted : tx.rejected}`}
                  >
                    {s !== null && <span className={s ? 'dot on' : 'dot'} aria-hidden="true" />}
                    <span className="name">{f.name}</span>
                    {s === false && <span className="muted small">{tx.rejected}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="stack">
          <button type="button" className="btn" onClick={onAddFiles}>
            <FilePlus size={16} aria-hidden="true" />
            <span>{tx.addFiles}</span>
          </button>
          <button type="button" className="btn" onClick={onAddFolder}>
            <FolderPlus size={16} aria-hidden="true" />
            <span>{tx.addFolder}</span>
          </button>
        </div>
      </section>
      {mode !== 'empty' && (
        <section className="samples">
          <h2>{tx.samples}</h2>
          <div className="sample-list">
            {SAMPLE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className={`sample-item${activeSample === id ? ' sel' : ''}`}
                aria-current={activeSample === id ? 'true' : undefined}
                onClick={() => onSample(id)}
              >
                {sampleLabel(tx, id)}
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
