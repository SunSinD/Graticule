import { Camera, Plus } from 'lucide-react';
import type { Dict } from '../i18n';

interface Props {
  readonly tx: Dict;
  readonly onAdd: () => void;
  readonly onCamera?: () => void;
}

export function EmptyState({ tx, onAdd, onCamera }: Props) {
  return (
    <div className="empty">
      <p className="empty-lead">{tx.emptyDrop}</p>
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
      <p className="muted small">{tx.emptyPrivacy}</p>
    </div>
  );
}
