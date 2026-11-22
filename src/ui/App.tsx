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
import { decodePng } from '../core/png';
import { assessPhotoQuality } from '../core/photoQuality';
import type { PhotoQualityReport } from '../core/photoQuality';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg';
import { renderBodeCsv, renderWaveformCsv } from '../core/export/csv';
import { renderBodeTable, renderMeasurementsTable } from '../core/export/table';
import { analyzeBode, analyzeSingle, recomputeBode } from './engine';
import { filesFromDataTransfer, isImageFile, isPhotoLike, loadFile, releaseUrl } from './files';
import { capHistory, compareItems, openHistory, releaseItems } from './history';
import type { HistoryItem, HistoryStore, ItemState } from './history';
import { baseName, copyPlain, copyRich, downloadBlob, downloadText, svgToPng } from './download';
import { formatDuration, t } from './i18n';
import { TopBar } from './components/TopBar';
import type { AppMode } from './components/TopBar';
import { EmptyState } from './components/EmptyState';
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
type Source = 'pick' | 'camera';

interface BodeSession {
  readonly state: ItemState;
  readonly result: BodeResult | null;
  readonly error: string | null;
  readonly gate: BodeGateOptions;
  readonly points: PointOverrides;
  readonly pointItems: Readonly<Record<string, string>>;
}

const STAGED_SESSION: BodeSession = { state: 'staged', result: null, error: null, gate: {}, points: {}, pointItems: {} };

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
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return type !== 'checkbox' && type !== 'range';
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
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

function byName(a: HistoryItem, b: HistoryItem): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

function checkPhoto(bytes: Uint8Array): PhotoQualityReport | null {
  try {
    const report = assessPhotoQuality(decodePng(bytes));
    return report.passed ? null : report;
  } catch {
    return null;
  }
}

function pointItemMap(list: readonly HistoryItem[]): Record<string, string> {
  const used = new Set<string>();
  const map: Record<string, string> = {};
  for (const item of list) {
    let id = item.name;
    let suffix = 2;
    while (used.has(id)) id = `${item.name}#${suffix++}`;
    used.add(id);
    map[id] = item.id;
  }
  return map;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => (readPref('graticule.locale') === 'fr' ? 'fr' : 'en'));
  const [theme, setTheme] = useState<Theme | null>(() => {
    const v = readPref('graticule.theme');
    return v === 'light' || v === 'dark' ? v : null;
  });
  const [prefersDark, setPrefersDark] = useState<boolean>(systemDark);
  const [keepHistory, setKeepHistory] = useState<boolean>(() => readPref('graticule.keepHistory') !== '0');
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [items, setItems] = useState<readonly HistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  const [view, setView] = useState<CaptureMode>('original');
  const [overlay, setOverlay] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);

  const [bodeProfile, setBodeProfile] = useState<ProfileChoice>('auto');
  const [sessions, setSessions] = useState<Readonly<Record<string, BodeSession>>>({});
  const [inspectedId, setInspectedId] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const exportsRef = useRef<HTMLElement>(null);
  const itemsRef = useRef<readonly HistoryItem[]>([]);
  const activeRef = useRef<string | null>(null);
  const selectedRef = useRef<readonly string[]>([]);
  const storeRef = useRef<HistoryStore | null>(null);
  const persisted = useRef<Map<string, HistoryItem>>(new Map());
  const singleReq = useRef<Map<string, number>>(new Map());
  const bodeReq = useRef<Map<string, number>>(new Map());
  itemsRef.current = items;
  activeRef.current = activeId;
  selectedRef.current = selected;

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

  useEffect(() => () => releaseItems(itemsRef.current), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await openHistory();
      if (cancelled) return;
      storeRef.current = store;
      if (readPref('graticule.keepHistory') === '0') {
        await store.clear();
      } else {
        let loaded: HistoryItem[] = [];
        try {
          loaded = await store.loadAll();
        } catch {
          loaded = [];
        }
        if (cancelled) {
          releaseItems(loaded);
          return;
        }
        persisted.current = new Map(loaded.map((i) => [i.id, i]));
        setItems((prev) => {
          const have = new Set(prev.map((i) => i.id));
          return [...prev, ...loaded.filter((i) => !have.has(i.id))].sort(compareItems);
        });
      }
      if (!cancelled) setHistoryReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const store = storeRef.current;
    if (!store || !historyReady || !keepHistory) return;
    const prev = persisted.current;
    const next = new Map<string, HistoryItem>();
    for (const item of items) {
      next.set(item.id, item);
      if (prev.get(item.id) !== item) void store.put(item);
    }
    for (const id of prev.keys()) if (!next.has(id)) void store.remove(id);
    persisted.current = next;
  }, [items, keepHistory, historyReady]);

  const patchItem = useCallback((id: string, patch: Partial<HistoryItem>) => {
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  const mode: AppMode = selected.length >= 2 ? 'bode' : activeId ? 'single' : 'empty';
  const activeItem = mode === 'single' ? items.find((i) => i.id === activeId) ?? null : null;

  const selectedItems = useMemo(() => {
    if (selected.length < 2) return [];
    const set = new Set(selected);
    return items.filter((i) => set.has(i.id)).sort(byName);
  }, [items, selected]);
  const bodeKey = mode === 'bode' ? selectedItems.map((i) => i.id).join('|') : null;
  const session = bodeKey ? sessions[bodeKey] ?? STAGED_SESSION : null;
  const bode = session?.result ?? null;

  const setSession = useCallback((key: string, patch: Partial<BodeSession>) => {
    setSessions((all) => ({ ...all, [key]: { ...(all[key] ?? STAGED_SESSION), ...patch } }));
  }, []);

  const resetCaptureView = (nextView: CaptureMode): void => {
    setView(nextView);
    setOverlay(false);
    setCropOpen(false);
    setInspectedId(null);
  };

  const runSingle = useCallback(
    (item: HistoryItem, showClean: boolean) => {
      const id = item.id;
      const req = (singleReq.current.get(id) ?? 0) + 1;
      singleReq.current.set(id, req);
      patchItem(id, { state: 'extracting', error: null });
      analyzeSingle(item.bytes, item.name, withProfile(item.overrides, item.profile)).then(
        (r) => {
          if (singleReq.current.get(id) !== req) return;
          patchItem(id, { state: 'extracted', result: r, error: null });
          if (showClean && activeRef.current === id) setView('clean');
        },
        (e: unknown) => {
          if (singleReq.current.get(id) !== req) return;
          patchItem(id, { state: 'error', result: null, error: message(e) });
          if (activeRef.current === id) setView('original');
        },
      );
    },
    [patchItem],
  );

  const updateItem = useCallback(
    (id: string, patch: Pick<Partial<HistoryItem>, 'overrides' | 'profile'>) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item) return;
      const next: HistoryItem = { ...item, ...patch };
      setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
      if (item.result || item.state === 'extracting') runSingle(next, false);
    },
    [runSingle],
  );

  const runBode = useCallback(
    (key: string, list: readonly HistoryItem[], profile: ProfileChoice, gate: BodeGateOptions, points: PointOverrides) => {
      const req = (bodeReq.current.get(key) ?? 0) + 1;
      bodeReq.current.set(key, req);
      const per = profile === 'auto' ? undefined : ({ profileId: profile } as ExtractionOverrides);
      const input = list.map((i) => ({ fileName: i.name, bytes: i.bytes, ...(per ? { overrides: per } : {}) }));
      const pointItems = pointItemMap(list);
      setSession(key, { state: 'extracting', error: null });
      analyzeBode(input, gate, points).then(
        (r) => {
          if (bodeReq.current.get(key) !== req) return;
          setSession(key, { state: 'extracted', result: r, error: null, gate, points, pointItems });
          const cache = new Map<string, ExtractionResult>();
          for (const p of r.points) {
            const itemId = pointItems[p.id];
            if (itemId) cache.set(itemId, p.extraction);
          }
          setItems((all) =>
            all.map((i) => {
              const ex = cache.get(i.id);
              if (!ex || i.result || i.state === 'extracting') return i;
              return { ...i, state: 'extracted', result: ex, error: null, profile };
            }),
          );
        },
        (e: unknown) => {
          if (bodeReq.current.get(key) !== req) return;
          setSession(key, { state: 'error', result: null, error: message(e) });
        },
      );
    },
    [setSession],
  );

  const recompute = useCallback(
    (key: string, current: BodeResult, gate: BodeGateOptions, points: PointOverrides) => {
      const req = (bodeReq.current.get(key) ?? 0) + 1;
      bodeReq.current.set(key, req);
      setSession(key, { gate, points });
      recomputeBode(current, gate, points).then(
        (r) => {
          if (bodeReq.current.get(key) === req) setSession(key, { result: r });
        },
        (e: unknown) => {
          if (bodeReq.current.get(key) === req) setSession(key, { error: message(e) });
        },
      );
    },
    [setSession],
  );

  const openItem = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;
    setActiveId(id);
    setSelected([]);
    setNotice(null);
    resetCaptureView(item.result ? 'clean' : 'original');
    const now = Date.now();
    setItems((list) => list.map((i) => (i.id === id ? { ...i, lastUsed: now } : i)));
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
    setInspectedId(null);
    setNotice(null);
  }, []);

  const removeItem = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;
    releaseUrl(item.url);
    singleReq.current.delete(id);
    setItems((list) => list.filter((i) => i.id !== id));
    setSelected((sel) => sel.filter((x) => x !== id));
    if (activeRef.current === id) setActiveId(null);
  }, []);

  const clearAll = (): void => {
    releaseItems(itemsRef.current);
    singleReq.current.clear();
    bodeReq.current.clear();
    persisted.current = new Map();
    void storeRef.current?.clear();
    setItems([]);
    setSelected([]);
    setActiveId(null);
    setSessions({});
    setNotice(null);
    resetCaptureView('original');
  };

  const onKeepHistory = (keep: boolean): void => {
    setKeepHistory(keep);
    writePref('graticule.keepHistory', keep ? '1' : '0');
    persisted.current = new Map();
    if (!keep) void storeRef.current?.clear();
  };

  const addFiles = useCallback(
    async (raw: readonly File[], source: Source) => {
      const images = raw.filter(isImageFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      if (images.length === 0) {
        if (raw.length > 0) setNotice(tx.unsupportedFile);
        return;
      }
      setAdding(true);
      setNotice(null);
      try {
        const now = Date.now();
        const added: HistoryItem[] = [];
        for (const f of images) {
          const photo = source === 'camera' || isPhotoLike(f);
          const loaded = await loadFile(f, f.name || 'photo.png', { photo: source === 'camera' });
          added.push({
            ...loaded,
            addedAt: now,
            lastUsed: now,
            state: 'staged',
            result: null,
            error: null,
            overrides: {},
            profile: 'auto',
            quality: photo ? checkPhoto(loaded.bytes) : null,
          });
        }
        const keep = new Set(added.map((i) => i.id));
        setItems((list) => capHistory([...added, ...list].sort(compareItems), keep));
        if (added.length === 1) {
          setActiveId(added[0]!.id);
          setSelected([]);
        } else {
          setActiveId(null);
          setSelected(added.map((i) => i.id));
        }
        resetCaptureView('original');
      } catch (e) {
        setNotice(message(e));
      } finally {
        setAdding(false);
      }
    },
    [tx.unsupportedFile],
  );

  const openPicker = useCallback((folder: boolean) => {
    const input = fileInput.current;
    if (!input) return;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.removeAttribute('webkitdirectory');
    input.click();
  }, []);

  const openCamera = useCallback(() => cameraInput.current?.click(), []);

  const inspected = useMemo(
    () => (mode === 'bode' && bode && inspectedId ? bode.points.find((p) => p.id === inspectedId) ?? null : null),
    [mode, bode, inspectedId],
  );
  const inspectedItem = inspected && session ? items.find((i) => i.id === session.pointItems[inspected.id]) ?? null : null;
  const showCapture = mode === 'single' || inspected !== null;
  const capture: ExtractionResult | null = mode === 'single' ? activeItem?.result ?? null : inspected?.extraction ?? null;
  const captureItem = mode === 'single' ? activeItem : inspectedItem;
  const captureName = captureItem?.name ?? inspected?.fileName ?? '';
  const profileChoice: ProfileChoice = mode === 'single' ? activeItem?.profile ?? 'auto' : bodeProfile;
  const isUniversal =
    mode === 'single' &&
    (activeItem?.profile === 'universal-fallback' || activeItem?.result?.detection.profileId === 'universal-fallback');
  const cropVisible = mode === 'single' && activeItem !== null && (cropOpen || (isUniversal && !activeItem.overrides.manualCrop));

  const rejectedIds = useMemo(() => {
    const out = new Set<string>();
    if (!bode || !session) return out;
    for (const p of bode.points) if (!p.accepted && session.pointItems[p.id]) out.add(session.pointItems[p.id]!);
    return out;
  }, [bode, session]);

  const toggleOverlay = useCallback(() => {
    setOverlay((o) => {
      if (!o) setView('original');
      return !o;
    });
  }, []);

  const extractActive = useCallback(() => {
    const item = itemsRef.current.find((i) => i.id === activeRef.current);
    if (item) runSingle(item, true);
  }, [runSingle]);

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
      } else if (k === 't' && showCapture && capture) {
        e.preventDefault();
        toggleOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, openPicker, showCapture, capture, toggleOverlay]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(
        files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted_${Date.now()}_${i + 1}.png`, { type: f.type }))),
        'pick',
      );
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const list = await filesFromDataTransfer(e.dataTransfer);
    await addFiles(list, 'pick');
  };

  const exportSource: ExportSource | null = useMemo(() => {
    if (showCapture && capture) {
      return {
        baseName: baseName(captureName),
        svg: () => renderWaveformSvg(capture, { locale, title: captureName }),
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
  }, [showCapture, capture, captureName, mode, bode, locale]);

  const extracting = mode === 'single' ? activeItem?.state === 'extracting' : session?.state === 'extracting';
  const status =
    adding || extracting
      ? tx.working
      : mode === 'single' && activeItem?.result && activeItem.state === 'extracted'
        ? tx.extractedSingle(
            activeItem.result.traces.filter((tr) => tr.settings.enabled).length,
            formatDuration(activeItem.result.elapsedMs, locale),
          )
        : mode === 'bode' && bode
          ? tx.extractedBode(bode.points.length, formatDuration(bode.elapsedMs, locale))
          : '';
  const error = notice ?? (mode === 'single' ? activeItem?.error ?? null : session?.error ?? null);

  const toggleTheme = (): void => {
    const next: Theme = dark ? 'light' : 'dark';
    setTheme(next);
    writePref('graticule.theme', next);
  };

  const quality = mode === 'single' ? activeItem?.quality ?? null : null;

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
        data-testid="file-input"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          void addFiles(list, 'pick');
        }}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        data-testid="camera-input"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          void addFiles(list, 'camera');
        }}
      />

      <FilePanel
        tx={tx}
        items={items}
        activeId={mode === 'single' ? activeId : inspectedItem?.id ?? null}
        selected={new Set(selected)}
        rejected={mode === 'bode' ? rejectedIds : new Set()}
        keepHistory={keepHistory}
        onAdd={() => openPicker(false)}
        onAddFolder={() => openPicker(true)}
        onCamera={openCamera}
        onOpen={openItem}
        onToggle={toggleSelect}
        onRemove={removeItem}
        onClear={clearAll}
        onKeepHistory={onKeepHistory}
      />

      <main className={`zone center${showCapture ? ' fit' : ''}`}>
        {mode === 'empty' && !adding && <EmptyState tx={tx} onAdd={() => openPicker(false)} onCamera={openCamera} />}
        {mode === 'empty' && adding && <p className="muted center-msg">{tx.working}</p>}

        {quality && activeItem && (
          <div className="banner" role="alert">
            <p className="banner-title">{tx.photoTitle}</p>
            <ul className="banner-list">
              {quality.issues.map((issue) => (
                <li key={issue}>{tx.photoIssues[issue] ?? issue.replace(/_/g, ' ')}</li>
              ))}
            </ul>
            <div className="btn-row">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  removeItem(activeItem.id);
                  openCamera();
                }}
              >
                {tx.photoRetake}
              </button>
              <button type="button" className="btn" onClick={() => patchItem(activeItem.id, { quality: null })}>
                {tx.photoUseAnyway}
              </button>
            </div>
          </div>
        )}

        {mode === 'bode' && inspected && (
          <div className="toolbar">
            <button type="button" className="btn" onClick={() => setInspectedId(null)}>
              {tx.backToBode}
            </button>
            <span className="muted small">{captureName}</span>
          </div>
        )}

        {showCapture && captureItem && (
          <CaptureView
            key={captureItem.id}
            tx={tx}
            locale={locale}
            url={captureItem.url}
            fileName={captureName}
            result={capture}
            extracting={mode === 'single' && activeItem?.state === 'extracting'}
            view={view}
            overlay={overlay}
            cropOpen={cropVisible}
            canCrop={mode === 'single'}
            overrides={mode === 'single' ? activeItem?.overrides ?? {} : {}}
            onExtract={mode === 'single' && !quality ? extractActive : null}
            onView={(v) => {
              setView(v);
              if (v === 'clean') setOverlay(false);
            }}
            onOverlay={toggleOverlay}
            onCropOpen={(open) => {
              setCropOpen(open);
              if (!open && isUniversal && activeItem && !activeItem.overrides.manualCrop) updateItem(activeItem.id, { profile: 'auto' });
            }}
            onApplyCrop={(crop: Rect, hDivs: number, vDivs: number) => {
              if (activeItem) updateItem(activeItem.id, { overrides: { ...activeItem.overrides, manualCrop: crop, hDivs, vDivs } });
              setCropOpen(false);
            }}
          />
        )}

        {mode === 'bode' && bodeKey && !bode && (
          <div className="empty">
            <p className="empty-lead">{tx.bodeStaged(selectedItems.length)}</p>
            <button
              type="button"
              className="btn primary"
              disabled={session?.state === 'extracting'}
              onClick={() => runBode(bodeKey, selectedItems, bodeProfile, session?.gate ?? {}, session?.points ?? {})}
            >
              {session?.state === 'extracting' ? tx.working : tx.extractBode(selectedItems.length)}
            </button>
          </div>
        )}

        {mode === 'bode' && bodeKey && session && bode && !inspected && (
          <BodeView
            tx={tx}
            locale={locale}
            result={bode}
            overrides={session.points}
            inspectedId={inspectedId}
            onEdit={(id, key, value) => {
              const prev: Record<string, number | boolean | undefined> = { ...session.points[id] };
              if (value === null) delete prev[key];
              else prev[key] = value;
              const next: Record<string, BodePointOverride> = { ...session.points };
              if (Object.keys(prev).length) next[id] = prev as BodePointOverride;
              else delete next[id];
              recompute(bodeKey, bode, session.gate, next);
            }}
            onExclude={(id, excluded) => {
              const prev: Record<string, number | boolean | undefined> = { ...session.points[id] };
              if (excluded) prev.excluded = true;
              else delete prev.excluded;
              const next: Record<string, BodePointOverride> = { ...session.points };
              if (Object.keys(prev).length) next[id] = prev as BodePointOverride;
              else delete next[id];
              recompute(bodeKey, bode, session.gate, next);
            }}
            onInspect={(id) => {
              setInspectedId(id);
              setView('clean');
              setOverlay(false);
            }}
            onReset={() => recompute(bodeKey, bode, session.gate, {})}
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
          <ProfilePanel
            tx={tx}
            choice={profileChoice}
            result={mode === 'bode' ? inspected?.extraction ?? null : activeItem?.result ?? null}
            onChoice={(choice) => {
              if (mode === 'single' && activeItem) {
                updateItem(activeItem.id, { profile: choice });
              } else {
                setBodeProfile(choice);
                if (bodeKey && session?.result) runBode(bodeKey, selectedItems, choice, session.gate, session.points);
              }
            }}
          />
          {mode === 'bode' && (
            <BodeSummary
              tx={tx}
              locale={locale}
              result={bode}
              gate={session?.gate ?? {}}
              onGate={(g) => {
                if (!bodeKey) return;
                if (bode && session) recompute(bodeKey, bode, g, session.points);
                else setSession(bodeKey, { gate: g });
              }}
            />
          )}
          {mode !== 'bode' && (
            <ScaleControls
              tx={tx}
              locale={locale}
              result={activeItem?.result ?? null}
              overrides={activeItem?.overrides ?? {}}
              disabled={false}
              onOverrides={(next) => activeItem && updateItem(activeItem.id, { overrides: next })}
            />
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
