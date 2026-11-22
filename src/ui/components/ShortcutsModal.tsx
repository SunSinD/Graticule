import { useEffect, useRef } from 'react';
import type { Dict } from '../i18n';

interface Props {
  readonly tx: Dict;
  readonly onClose: () => void;
}

export function ShortcutsModal({ tx, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => prev?.focus();
  }, []);
  const rows: readonly (readonly [string, string])[] = [
    ['O', tx.shortcutOpen],
    ['Ctrl+V', tx.shortcutPaste],
    ['E', tx.shortcutExport],
    ['T', tx.shortcutOverlay],
    ['Ctrl+wheel', tx.shortcutZoom],
    ['?', tx.shortcutHelp],
  ];
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="shortcuts-title">{tx.shortcuts}</h2>
          <button type="button" className="btn" onClick={onClose}>
            {tx.close}
          </button>
        </div>
        <dl className="keys">
          {rows.map(([k, label]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
