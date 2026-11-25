import type { Dict } from '../i18n';

export const SOURCE_URL = 'https://github.com/SunSinD/Graticule';
export const OFFLINE_COPY_URL = 'https://github.com/SunSinD/Graticule/releases/latest/download/graticule-portable.html';

/** True in the portable HTML file or any page opened from disk, where an offline copy link makes no sense. */
export function isOfflineBuild(): boolean {
  if ((globalThis as { __GRATICULE_PORTABLE__?: boolean }).__GRATICULE_PORTABLE__) return true;
  return typeof location !== 'undefined' && location.protocol === 'file:';
}

interface Props {
  readonly tx: Dict;
  readonly className: string;
  readonly linkClassName?: string;
}

export function SourceLinks({ tx, className, linkClassName }: Props) {
  return (
    <p className={className}>
      <a className={linkClassName} href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        {tx.sourceCode}
      </a>
      {!isOfflineBuild() && (
        <a className={linkClassName} href={OFFLINE_COPY_URL} target="_blank" rel="noopener noreferrer">
          {tx.offlineCopy}
        </a>
      )}
    </p>
  );
}
