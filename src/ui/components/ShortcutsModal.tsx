import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Dict } from '../i18n';

interface Props {
  readonly tx: Dict;
  readonly onClose: () => void;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function ShortcutsModal({ tx, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => prev?.focus();
  }, []);

  const trap = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || !ref.current) return;
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) {
      e.preventDefault();
      ref.current.focus();
      return;
    }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const rows: readonly (readonly [string, string])[] = [
    ['O', tx.shortcutOpen],
    ['Ctrl+V', tx.shortcutPaste],
    ['E', tx.shortcutExport],
    ['1 2 3 4 5', tx.shortcutViews],
    ['T', tx.shortcutOverlay],
    ['C', tx.shortcutCursors],
    ['Ctrl+C', tx.shortcutCopy],
    [tx.keyCtrlWheel, tx.shortcutZoom],
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
        onKeyDown={trap}
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
