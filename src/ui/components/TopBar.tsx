import { FolderOpen, Moon, Sun } from 'lucide-react';
import type { Locale } from '../../core/types';
import type { Dict } from '../i18n';

export type AppMode = 'empty' | 'single' | 'bode';

interface Props {
  readonly tx: Dict;
  readonly mode: AppMode;
  readonly locale: Locale;
  readonly dark: boolean;
  readonly onOpen: () => void;
  readonly onLocale: (locale: Locale) => void;
  readonly onTheme: () => void;
  readonly onShortcuts: () => void;
}

export function TopBar({ tx, mode, locale, dark, onOpen, onLocale, onTheme, onShortcuts }: Props) {
  return (
    <header className="topbar">
      <span className="wordmark">Graticule</span>
      <span className="mode" aria-label={tx.mode}>
        {mode === 'bode' ? tx.modeBode : tx.modeSingle}
      </span>
      <span className="spacer" />
      <button type="button" className="btn" onClick={onOpen} title={tx.openTitle} aria-keyshortcuts="O">
        <FolderOpen size={16} aria-hidden="true" />
        <span>{tx.open}</span>
        <kbd>O</kbd>
      </button>
      <div className="seg" role="group" aria-label="Language">
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
      <button
        type="button"
        className="btn icon"
        onClick={onShortcuts}
        aria-label={tx.shortcuts}
        title={tx.shortcuts}
        aria-keyshortcuts="?"
      >
        ?
      </button>
    </header>
  );
}
