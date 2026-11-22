import type { Dict } from '../i18n';

export type SampleId = 'sine' | 'zener' | 'sweep';

interface Props {
  readonly tx: Dict;
  readonly onSample: (id: SampleId) => void;
  readonly onOpen: () => void;
}

export function sampleLabel(tx: Dict, id: SampleId): string {
  return id === 'sine' ? tx.sampleSine : id === 'zener' ? tx.sampleZener : tx.sampleSweep;
}

export const SAMPLE_IDS: readonly SampleId[] = ['sine', 'zener', 'sweep'];

export function EmptyState({ tx, onSample, onOpen }: Props) {
  return (
    <div className="empty">
      <p className="empty-lead">{tx.emptyDrop}</p>
      <button type="button" className="btn" onClick={onOpen}>
        {tx.open}
      </button>
      <div className="empty-samples">
        <span className="muted">{tx.emptyTry}</span>
        {SAMPLE_IDS.map((id) => (
          <button key={id} type="button" className="btn" onClick={() => onSample(id)}>
            {sampleLabel(tx, id)}
          </button>
        ))}
      </div>
      <p className="muted small">{tx.emptyPrivacy}</p>
    </div>
  );
}
