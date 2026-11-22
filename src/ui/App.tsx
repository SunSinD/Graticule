import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodeGateOptions,
  BodePointOverride,
  BodeResult,
  ExtractionOverrides,
  ExtractionResult,
  Locale,
  Rect,
} from '../core/types';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg';
import { renderBodeCsv, renderWaveformCsv } from '../core/export/csv';
import { renderBodeTable, renderMeasurementsTable } from '../core/export/table';
import { analyzeBode, analyzeSingle, recomputeBode } from './engine';
import { fetchSample, filesFromDataTransfer, isImageFile, loadFile, releaseFiles } from './files';
import type { LoadedFile } from './files';
import { baseName, copyPlain, copyRich, downloadBlob, downloadText, svgToPng } from './download';
import { formatDuration, t } from './i18n';
import { TopBar } from './components/TopBar';
import type { AppMode } from './components/TopBar';
import { EmptyState } from './components/EmptyState';
import type { SampleId } from './components/EmptyState';
import { FilePanel } from './components/FilePanel';
import { CaptureView } from './components/CaptureView';
import type { CaptureMode } from './components/CaptureView';
import { BodeView } from './components/BodeView';
import { ProfilePanel, ScaleControls } from './components/Controls';
import type { ProfileChoice } from './components/Controls';
import { BodeSummary, MeasurementsPanel } from './components/Measurements';
import { ExportPanel } from './components/Exports';
import type { ExportSource } from './components/Exports';
import { ShortcutsModal } from './components/ShortcutsModal';

type Theme = 'light' | 'dark';
type PointOverrides = Readonly<Record<string, BodePointOverride>>;

const SWEEP = Array.from({ length: 10 }, (_, i) => `sweep_${String(i + 1).padStart(2, '0')}.png`);
const SAMPLE_FILES: Readonly<Record<SampleId, readonly string[]>> = {
  sine: ['sine_schmitt.png'],
  zener: ['zener_clip.png'],
  sweep: SWEEP,
};

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked, the app still works */
  }
}

function systemDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function withProfile(overrides: ExtractionOverrides, choice: ProfileChoice): ExtractionOverrides {
  if (choice === 'auto') {
    const { profileId: _drop, ...rest } = overrides;
    return rest;
  }
  return { ...overrides, profileId: choice };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => (readPref('graticule.locale') === 'fr' ? 'fr' : 'en'));
  const [theme, setTheme] = useState<Theme | null>(() => {
    const v = readPref('graticule.theme');
    return v === 'light' || v === 'dark' ? v : null;
  });
  const [prefersDark, setPrefersDark] = useState<boolean>(systemDark);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<AppMode>('empty');
  const [files, setFiles] = useState<readonly LoadedFile[]>([]);
  const [profile, setProfile] = useState<ProfileChoice>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overrides, setOverrides] = useState<ExtractionOverrides>({});
  const [single, setSingle] = useState<ExtractionResult | null>(null);
  const [view, setView] = useState<CaptureMode>('clean');
  const [activeSample, setActiveSample] = useState<SampleId | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);

  const [bode, setBode] = useState<BodeResult | null>(null);
  const [gate, setGate] = useState<BodeGateOptions>({});
  const [pointOverrides, setPointOverrides] = useState<PointOverrides>({});
  const [inspectedId, setInspectedId] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const exportsRef = useRef<HTMLElement>(null);
  const reqId = useRef(0);
  const filesRef = useRef<readonly LoadedFile[]>([]);
  const tx = t(locale);
  const dark = theme ? theme === 'dark' : prefersDark;

  useEffect(() => {
    document.documentElement.lang = locale;
    writePref('graticule.locale', locale);
  }, [locale]);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => () => releaseFiles(filesRef.current), []);

  const singleFile = mode === 'single' ? files[0] ?? null : null;
  const effectiveOverrides = useMemo(() => withProfile(overrides, profile), [overrides, profile]);

  useEffect(() => {
    if (!singleFile) return;
    const id = ++reqId.current;
    setBusy(true);
    analyzeSingle(singleFile.bytes, singleFile.name, effectiveOverrides).then(
      (r) => {
        if (id !== reqId.current) return;
        setSingle(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (id !== reqId.current) return;
        setSingle(null);
        setError(message(e));
        setBusy(false);
      },
    );
  }, [singleFile, effectiveOverrides]);

  const bodeFiles = mode === 'bode' ? files : null;
  const gateRef = useRef(gate);
  const pointRef = useRef(pointOverrides);
  gateRef.current = gate;
  pointRef.current = pointOverrides;

  useEffect(() => {
    if (!bodeFiles || bodeFiles.length === 0) return;
    const id = ++reqId.current;
    setBusy(true);
    const per = profile === 'auto' ? undefined : ({ profileId: profile } as ExtractionOverrides);
    const items = bodeFiles.map((f) => ({ fileName: f.name, bytes: f.bytes, ...(per ? { overrides: per } : {}) }));
    analyzeBode(items, gateRef.current, pointRef.current).then(
      (r) => {
        if (id !== reqId.current) return;
        setBode(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (id !== reqId.current) return;
        setBode(null);
        setError(message(e));
        setBusy(false);
      },
    );
  }, [bodeFiles, profile]);

  const recompute = useCallback(
    (nextGate: BodeGateOptions, nextPoints: PointOverrides) => {
      if (!bode) return;
      const id = ++reqId.current;
      recomputeBode(bode, nextGate, nextPoints).then(
        (r) => {
          if (id === reqId.current) setBode(r);
        },
        (e: unknown) => {
          if (id === reqId.current) setError(message(e));
        },
      );
    },
    [bode],
  );

  const resetView = (): void => {
    setOverrides({});
    setSingle(null);
    setBode(null);
    setPointOverrides({});
    setGate({});
    setInspectedId(null);
    setOverlay(false);
    setCropOpen(false);
    setView('clean');
    setError(null);
  };

  const clearFiles = (): void => {
    reqId.current++;
    releaseFiles(filesRef.current);
    filesRef.current = [];
    resetView();
    setFiles([]);
    setActiveSample(null);
    setProfile('auto');
    setBusy(false);
    setMode('empty');
  };

  const loadFiles = useCallback(async (list: readonly LoadedFile[]) => {
    if (list.length === 0) return;
    releaseFiles(filesRef.current);
    filesRef.current = list;
    resetView();
    setFiles(list);
    setMode(list.length > 1 ? 'bode' : 'single');
  }, []);

  const loadRawFiles = useCallback(
    async (raw: readonly File[]) => {
      const images = raw.filter(isImageFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (images.length === 0) {
        if (raw.length > 0) setError(tx.unsupportedFile);
        return;
      }
      const id = ++reqId.current;
      setBusy(true);
      const seen = new Map<string, number>();
      const uniqueName = (rawName: string): string => {
        const count = seen.get(rawName) ?? 0;
        seen.set(rawName, count + 1);
        if (count === 0) return rawName;
        const dot = rawName.lastIndexOf('.');
        return dot > 0 ? `${rawName.slice(0, dot)} (${count + 1})${rawName.slice(dot)}` : `${rawName} (${count + 1})`;
      };
      try {
        const loaded = await Promise.all(images.map((f) => loadFile(f, uniqueName(f.name))));
        if (id !== reqId.current) {
          releaseFiles(loaded);
          return;
        }
        await loadFiles(loaded);
        setActiveSample(null);
      } catch (e) {
        if (id !== reqId.current) return;
        setError(message(e));
        setBusy(false);
      }
    },
    [loadFiles, tx.unsupportedFile],
  );

  const loadSample = useCallback(
    async (id: SampleId) => {
      const req = ++reqId.current;
      setBusy(true);
      try {
        const loaded = await Promise.all(SAMPLE_FILES[id].map((n) => fetchSample(n)));
        if (req !== reqId.current) {
          releaseFiles(loaded);
          return;
        }
        await loadFiles(loaded);
        setActiveSample(id);
      } catch (e) {
        if (req !== reqId.current) return;
        setError(message(e));
        setBusy(false);
      }
    },
    [loadFiles],
  );

  const openPicker = useCallback((folder: boolean) => {
    const input = fileInput.current;
    if (!input) return;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.removeAttribute('webkitdirectory');
    input.click();
  }, []);

  const showCapture = mode === 'single' || (mode === 'bode' && inspectedId !== null);
  const toggleOverlay = useCallback(() => {
    setOverlay((o) => {
      if (!o) setView('original');
      return !o;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && help) {
        setHelp(false);
        return;
      }
      if (isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (help) return;
      const k = e.key.toLowerCase();
      if (k === 'o') {
        e.preventDefault();
        openPicker(false);
      } else if (k === 'e') {
        e.preventDefault();
        const first = exportsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
        (first ?? exportsRef.current)?.focus();
      } else if (k === 't' && showCapture) {
        e.preventDefault();
        toggleOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, openPicker, showCapture, toggleOverlay]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const items = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
      if (items.length === 0) return;
      e.preventDefault();
      void loadRawFiles(items.map((f, i) => (f.name ? f : new File([f], `pasted_${i + 1}.png`, { type: f.type }))));
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadRawFiles]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const list = await filesFromDataTransfer(e.dataTransfer);
    await loadRawFiles(list);
  };

  const inspected = useMemo(
    () => (mode === 'bode' && bode && inspectedId ? bode.points.find((p) => p.id === inspectedId) ?? null : null),
    [mode, bode, inspectedId],
  );
  const inspectedFile = inspected ? files.find((f) => f.name === inspected.fileName) ?? null : null;
  const capture: ExtractionResult | null = mode === 'single' ? single : inspected?.extraction ?? null;
  const captureFile = mode === 'single' ? singleFile : inspectedFile;
  const isUniversal =
    mode === 'single' && (profile === 'universal-fallback' || single?.detection.profileId === 'universal-fallback');
  const cropVisible = mode === 'single' && singleFile !== null && (cropOpen || (isUniversal && !overrides.manualCrop));

  const exportSource: ExportSource | null = useMemo(() => {
    if (showCapture && capture && captureFile) {
      return {
        baseName: baseName(captureFile.name),
        svg: () => renderWaveformSvg(capture, { locale, title: captureFile.name }),
        csv: () => renderWaveformCsv(capture),
        table: (f) => renderMeasurementsTable(capture, f, locale),
      };
    }
    if (mode === 'bode' && bode) {
      return {
        baseName: 'bode',
        svg: () => renderBodeSvg(bode, { locale, title: 'Bode' }),
        csv: () => renderBodeCsv(bode),
        table: (f) => renderBodeTable(bode, f, locale),
      };
    }
    return null;
  }, [showCapture, capture, captureFile, mode, bode, locale]);

  const status = busy
    ? tx.working
    : mode === 'single' && single
      ? tx.extractedSingle(single.traces.filter((tr) => tr.settings.enabled).length, formatDuration(single.elapsedMs, locale))
      : mode === 'bode' && bode
        ? tx.extractedBode(bode.points.length, formatDuration(bode.elapsedMs, locale))
        : '';

  const toggleTheme = (): void => {
    const next: Theme = dark ? 'light' : 'dark';
    setTheme(next);
    writePref('graticule.theme', next);
  };

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <TopBar
        tx={tx}
        mode={mode}
        locale={locale}
        dark={dark}
        onOpen={() => openPicker(false)}
        onLocale={setLocale}
        onTheme={toggleTheme}
        onShortcuts={() => setHelp((h) => !h)}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          void loadRawFiles(list);
        }}
      />

      <FilePanel
        tx={tx}
        mode={mode}
        files={files}
        bode={bode}
        activeName={mode === 'bode' ? inspected?.fileName ?? null : singleFile?.name ?? null}
        onAddFiles={() => openPicker(false)}
        onAddFolder={() => openPicker(true)}
        onSelect={(f) => {
          if (mode !== 'bode' || !bode) return;
          const p = bode.points.find((pt) => pt.fileName === f.name);
          if (p) setInspectedId(p.id);
        }}
        activeSample={activeSample}
        onSample={(id) => void loadSample(id)}
        onClear={clearFiles}
      />

      <main className={`zone center${showCapture ? ' fit' : ''}`}>
        {mode === 'empty' && !busy && <EmptyState tx={tx} onSample={(id) => void loadSample(id)} onOpen={() => openPicker(false)} />}
        {mode === 'empty' && busy && <p className="muted center-msg">{tx.working}</p>}

        {mode === 'bode' && inspectedId !== null && (
          <div className="toolbar">
            <button type="button" className="btn" onClick={() => setInspectedId(null)}>
              {tx.backToBode}
            </button>
            <span className="muted small">{inspected?.fileName}</span>
          </div>
        )}

        {showCapture && captureFile && (
          <CaptureView
            key={captureFile.id}
            tx={tx}
            locale={locale}
            url={captureFile.url}
            fileName={captureFile.name}
            result={capture}
            view={view}
            overlay={overlay}
            cropOpen={cropVisible}
            canCrop={mode === 'single'}
            overrides={overrides}
            onView={(v) => {
              setView(v);
              if (v === 'clean') setOverlay(false);
            }}
            onOverlay={toggleOverlay}
            onCropOpen={(open) => {
              setCropOpen(open);
              if (!open && isUniversal && !overrides.manualCrop) setProfile('auto');
            }}
            onApplyCrop={(crop: Rect, hDivs: number, vDivs: number) => {
              setOverrides((o) => ({ ...o, manualCrop: crop, hDivs, vDivs }));
              setCropOpen(false);
            }}
          />
        )}

        {mode === 'bode' && inspectedId === null && bode && (
          <BodeView
            tx={tx}
            locale={locale}
            result={bode}
            overrides={pointOverrides}
            inspectedId={inspectedId}
            onEdit={(id, key, value) => {
              const prev: Record<string, number | boolean | undefined> = { ...pointOverrides[id] };
              if (value === null) delete prev[key];
              else prev[key] = value;
              const next: Record<string, BodePointOverride> = { ...pointOverrides };
              if (Object.keys(prev).length) next[id] = prev as BodePointOverride;
              else delete next[id];
              setPointOverrides(next);
              recompute(gate, next);
            }}
            onExclude={(id, excluded) => {
              const prev: Record<string, number | boolean | undefined> = { ...pointOverrides[id] };
              if (excluded) prev.excluded = true;
              else delete prev.excluded;
              const next: Record<string, BodePointOverride> = { ...pointOverrides };
              if (Object.keys(prev).length) next[id] = prev as BodePointOverride;
              else delete next[id];
              setPointOverrides(next);
              recompute(gate, next);
            }}
            onInspect={(id) => setInspectedId(id)}
            onReset={() => {
              setPointOverrides({});
              recompute(gate, {});
            }}
          />
        )}

        {error && (
          <p className="error" role="alert">
            {tx.error}: {error}
          </p>
        )}
        {status && (
          <p className="status small muted" aria-live="polite">
            {status}
          </p>
        )}
      </main>

      <aside className="zone right" aria-label={tx.profile}>
        <div className="right-scroll">
          <ProfilePanel tx={tx} choice={profile} result={mode === 'bode' ? inspected?.extraction ?? null : single} onChoice={setProfile} />
          {mode === 'bode' && (
            <BodeSummary
              tx={tx}
              locale={locale}
              result={bode}
              gate={gate}
              onGate={(g) => {
                setGate(g);
                recompute(g, pointOverrides);
              }}
            />
          )}
          {mode !== 'bode' && (
            <ScaleControls tx={tx} locale={locale} result={single} overrides={overrides} disabled={busy && !single} onOverrides={setOverrides} />
          )}
          {(mode !== 'bode' || inspected) && <MeasurementsPanel tx={tx} locale={locale} result={capture} />}
        </div>
        <ExportPanel
          ref={exportsRef}
          tx={tx}
          source={exportSource}
          onSvg={(src) => downloadText(src.svg(), `${src.baseName}.svg`, 'image/svg+xml')}
          onPng={async (src) => downloadBlob(await svgToPng(src.svg(), 2), `${src.baseName}_2x.png`)}
          onCsv={(src) => downloadText(src.csv(), `${src.baseName}.csv`, 'text/csv')}
          onCopy={async (src, f) => {
            if (f === 'html') await copyRich(src.table('html'), src.table('tsv'));
            else await copyPlain(src.table(f));
          }}
        />
      </aside>

      {dragging && (
        <div className="dropzone" aria-hidden="true">
          {tx.dropHere}
        </div>
      )}
      {help && <ShortcutsModal tx={tx} onClose={() => setHelp(false)} />}
    </div>
  );
}
