import { Camera, Moon, Plus, Sun } from 'lucide-react';
import type { Locale } from '../../core/types';
import type { Dict } from '../i18n';

export type AppMode = 'empty' | 'single' | 'bode';

interface Props {
  readonly tx: Dict;
  readonly mode: AppMode;
  readonly locale: Locale;
  readonly dark: boolean;
  readonly onLocale: (locale: Locale) => void;
  readonly onTheme: () => void;
  readonly onShortcuts?: (() => void) | undefined;
  readonly onAdd: () => void;
  readonly onCamera?: (() => void) | undefined;
}

export function TopBar({ tx, mode, locale, dark, onLocale, onTheme, onShortcuts, onAdd, onCamera }: Props) {
  return (
    <header className="topbar">
      <span className="wordmark">Graticule</span>
      {mode !== 'empty' && (
        <span className="mode" aria-label={tx.mode}>
          {mode === 'bode' ? tx.modeBode : tx.modeSingle}
        </span>
      )}
      <span className="spacer" />
      {mode !== 'empty' && (
        <button type="button" className="btn icon compact-only" onClick={onAdd} aria-label={tx.add} title={tx.addTitle}>
          <Plus size={16} aria-hidden="true" />
        </button>
      )}
      {mode !== 'empty' && onCamera && (
        <button type="button" className="btn icon compact-only" onClick={onCamera} aria-label={tx.takePhoto} title={tx.takePhoto}>
          <Camera size={16} aria-hidden="true" />
        </button>
      )}
      <div className="seg" role="group" aria-label={tx.language}>
        {(['en', 'fr'] as const).map((l) => (
          <button key={l} type="button" className="btn" aria-pressed={locale === l} onClick={() => onLocale(l)}>
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn icon"
        onClick={onTheme}
        aria-label={dark ? tx.themeToLight : tx.themeToDark}
        title={dark ? tx.themeToLight : tx.themeToDark}
      >
        {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      </button>
      {onShortcuts && (
        <button
          type="button"
          className="btn icon wide-only"
          onClick={onShortcuts}
          aria-label={tx.shortcuts}
          title={tx.shortcuts}
          aria-keyshortcuts="?"
        >
          ?
        </button>
      )}
    </header>
  );
}
