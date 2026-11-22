import { useEffect, useRef, useState } from 'react';
import { Camera, FolderPlus, Plus, X } from 'lucide-react';
import type { HistoryItem } from '../history';
import type { Dict } from '../i18n';

interface Props {
  readonly tx: Dict;
  readonly items: readonly HistoryItem[];
  readonly activeId: string | null;
  readonly selected: ReadonlySet<string>;
  readonly rejected: ReadonlySet<string>;
  readonly keepHistory: boolean;
  readonly onAdd: () => void;
  readonly onAddFolder: () => void;
  readonly onCamera?: () => void;
  readonly onOpen: (id: string) => void;
  readonly onToggle: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
  readonly onKeepHistory: (keep: boolean) => void;
}

function StateMark({ item, rejected, tx }: { item: HistoryItem; rejected: boolean; tx: Dict }) {
  if (item.state === 'extracting') return <span className="muted small">{tx.stateExtracting}</span>;
  if (item.state === 'error') return <span className="muted small">{tx.stateError}</span>;
  if (rejected) return <span className="muted small">{tx.rejected}</span>;
  return (
    <span
      className={item.state === 'extracted' ? 'dot on' : 'dot'}
      title={item.state === 'extracted' ? tx.stateExtracted : tx.stateStaged}
      aria-label={item.state === 'extracted' ? tx.stateExtracted : tx.stateStaged}
    />
  );
}

function ClearButton({ tx, onClear }: { tx: Dict; onClear: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const reset = (): void => {
    window.clearTimeout(timer.current);
    setConfirming(false);
  };
  if (!confirming) {
    return (
      <button
        type="button"
        className="btn chip"
        onClick={() => {
          setConfirming(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setConfirming(false), 4000);
        }}
      >
        {tx.clear}
      </button>
    );
  }
  return (
    <div className="chips">
      <button type="button" className="btn chip" onClick={reset}>
        {tx.cancel}
      </button>
      <button
        type="button"
        className="btn chip danger"
        autoFocus
        onClick={() => {
          reset();
          onClear();
        }}
      >
        {tx.confirmClear}
      </button>
    </div>
  );
}

export function FilePanel(props: Props) {
  const { tx, items, activeId, selected, rejected, keepHistory } = props;
  return (
    <aside className="zone left" aria-label={tx.history}>
      <section className="left-scroll">
        <div className="add-bar">
          <button type="button" className="btn grow" onClick={props.onAdd} title={tx.addTitle}>
            <Plus size={16} aria-hidden="true" />
            <span>{tx.add}</span>
          </button>
          <button type="button" className="btn icon" onClick={props.onAddFolder} aria-label={tx.addFolder} title={tx.addFolder}>
            <FolderPlus size={16} aria-hidden="true" />
          </button>
          {props.onCamera && (
            <button type="button" className="btn icon" onClick={props.onCamera} aria-label={tx.takePhoto} title={tx.takePhoto}>
              <Camera size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="section-head">
          <h2>{tx.history}</h2>
          {items.length > 0 && <ClearButton tx={tx} onClear={props.onClear} />}
        </div>
        {items.length === 0 ? (
          <p className="muted small">{tx.historyEmpty}</p>
        ) : (
          <ul className="files">
            {items.map((item) => {
              const isSel = selected.has(item.id);
              return (
                <li key={item.id} className={`file-item${activeId === item.id ? ' sel' : ''}${isSel ? ' checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={isSel}
                    aria-label={`${tx.selectForBode} ${item.name}`}
                    title={tx.selectForBode}
                    onChange={() => props.onToggle(item.id)}
                  />
                  <button
                    type="button"
                    className="file-row"
                    aria-current={activeId === item.id ? 'true' : undefined}
                    onClick={() => props.onOpen(item.id)}
                    title={item.name}
                  >
                    <span className="name">{item.name}</span>
                    <StateMark item={item} rejected={rejected.has(item.id)} tx={tx} />
                  </button>
                  <button
                    type="button"
                    className="btn icon ghost remove"
                    aria-label={`${tx.remove} ${item.name}`}
                    title={tx.remove}
                    onClick={() => props.onRemove(item.id)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="keep-history">
        <label className="inline" title={tx.keepHistoryHint}>
          <input type="checkbox" checked={keepHistory} onChange={(e) => props.onKeepHistory(e.target.checked)} />
          <span>{tx.keepHistory}</span>
        </label>
      </section>
    </aside>
  );
}
