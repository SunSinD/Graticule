import { Camera, Plus } from 'lucide-react';
import type { Dict } from '../i18n';

interface Props {
  readonly tx: Dict;
  readonly onAdd: () => void;
  readonly onCamera?: () => void;
  readonly onSample?: () => void;
  readonly busy?: boolean;
}

export function EmptyState({ tx, onAdd, onCamera, onSample, busy = false }: Props) {
  return (
    <div className="empty">
      <p className="empty-lead">{onCamera ? tx.emptyTouch : tx.emptyDrop}</p>
      <div className="btn-row">
        <button type="button" className="btn primary" onClick={onAdd}>
          <Plus size={16} aria-hidden="true" />
          <span>{tx.addImages}</span>
        </button>
        {onCamera && (
          <button type="button" className="btn" onClick={onCamera}>
            <Camera size={16} aria-hidden="true" />
            <span>{tx.takePhoto}</span>
          </button>
        )}
      </div>
      {onSample && (
        <button type="button" className="linklike sample-link" disabled={busy} onClick={onSample}>
          {tx.trySample}
        </button>
      )}
      <p className="muted small">{tx.emptyPrivacy}</p>
      <a className="empty-source" href="https://github.com/SunSinD/Graticule" target="_blank" rel="noopener noreferrer">
        {tx.sourceCode}
      </a>
    </div>
  );
}
