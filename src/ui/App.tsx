import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodeGateOptions,
  BodePointOverride,
  BodeResult,
  ChannelId,
  ExtractionOverrides,
  ExtractionResult,
  Locale,
  MathConfig,
  MathTraceResult,
  PlotCursors,
  Quad,
  Rect,
  XyAxisId,
} from '../core/types';
import type { SpectrumWindow } from '../core/spectrum';
import { decodePng } from '../core/png';
import { assessPhotoQuality } from '../core/photoQuality';
import type { PhotoQualityReport } from '../core/photoQuality';
import { renderBodeSvg, renderWaveformSvg } from '../core/export/svg';
import { renderBodeCsv, renderWaveformCsv } from '../core/export/csv';
import { renderBodeTable, renderMeasurementsTable } from '../core/export/table';
import { analyzeBode, analyzeSingle, recomputeBode } from './engine';
import { filesFromDataTransfer, isImageFile, isPhotoLike, loadFile, releaseUrl } from './files';
import type { LoadedFile } from './files';
import { HISTORY_LIMIT, capHistory, compareItems, nextRev, openHistory, releaseItems, storedChange } from './history';
import type { ChannelLabels, HistoryItem, HistoryStore, ItemState } from './history';
import { baseName, copyImage, copyPlain, copyRich, downloadBlob, downloadText, svgToPng } from './download';
import { formatDuration, reasonLabel, t } from './i18n';
import { TopBar } from './components/TopBar';
import type { AppMode } from './components/TopBar';
import { EmptyState } from './components/EmptyState';
import { FilePanel } from './components/FilePanel';
import { CaptureView } from './components/CaptureView';
import type { AxisOption, CaptureMode, FftControls, SpectrumScale, XyControls } from './components/CaptureView';
import { BodeView } from './components/BodeView';
import { ProfilePanel, ScaleControls, mathAutoLabel } from './components/Controls';
import type { MathField, ProfileChoice } from './components/Controls';
import { BodeSummary, MeasurementsPanel } from './components/Measurements';
import { ExportPanel } from './components/Exports';
import type { ExportSource, TitleField } from './components/Exports';
import { ShortcutsModal } from './components/ShortcutsModal';
import { resolveCursors } from './components/Cursors';

type Theme = 'light' | 'dark';
type PointOverrides = Readonly<Record<string, BodePointOverride>>;
type Source = 'pick' | 'camera';
type MetaPatch = Pick<Partial<HistoryItem>, 'title' | 'channelLabels' | 'cursors'>;
type Analysis = typeof import('./analysis');
interface PendingCursors {
  readonly cursors: PlotCursors | null | undefined;
  /** When the cursors moved, so a newer cursor on disk is never overwritten by this one. */
  readonly rev: number;
  /** Changes on every write attempt, so only the newest attempt can clear this entry. */
  readonly token: symbol;
}

interface BodeSession {
  readonly state: ItemState;
  readonly result: BodeResult | null;
  readonly error: string | null;
  readonly gate: BodeGateOptions;
  readonly points: PointOverrides;
  readonly pointItems: Readonly<Record<string, string>>;
  readonly profile?: ProfileChoice;
  readonly title?: string;
}

interface BatchProgress {
  readonly phase: 'extract' | 'zip';
  readonly done: number;
  readonly total: number;
}

interface FftSettings {
  readonly channel: XyAxisId | null;
  readonly window: SpectrumWindow;
  readonly scale: SpectrumScale;
}

const VIEW_KEYS: Readonly<Record<string, CaptureMode>> = { '1': 'original', '2': 'overlay', '3': 'clean', '4': 'xy', '5': 'fft' };

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = (): void => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function enabledChannels(result: ExtractionResult | null): ChannelId[] {
  return result ? result.traces.filter((tr) => tr.settings.enabled).map((tr) => tr.channel) : [];
}

/** Keeps a saved math setup usable when one of its channels was turned off since. */
function usableMath(config: MathConfig | null | undefined, channels: readonly ChannelId[]): MathConfig | null {
  if (!config || channels.length < 2) return null;
  const a = channels.includes(config.a) ? config.a : channels.find((c) => c !== config.b) ?? channels[0]!;
  const b = channels.includes(config.b) && config.b !== a ? config.b : channels.find((c) => c !== a) ?? channels[1]!;
  return a === config.a && b === config.b ? config : { ...config, a, b };
}

const STAGED_SESSION: BodeSession = { state: 'staged', result: null, error: null, gate: {}, points: {}, pointItems: {} };
const CURSOR_SAVE_DELAY = 600;

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

function isMobileOrTablet(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }).userAgentData;
  if (uaData?.mobile === true || uaData?.platform === 'Android') return true;
  const ua = navigator.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
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

function hasTextSelection(): boolean {
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return Boolean(sel && !sel.isCollapsed && sel.toString().trim());
}

function hasFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types ?? []).includes('Files'));
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

function hasManualBox(o: ExtractionOverrides): boolean {
  return Boolean(o.manualCrop || o.manualQuad);
}

function SettingsFold({ compact, label, children }: { compact: boolean; label: string; children: React.ReactNode }) {
  if (!compact) return <>{children}</>;
  return (
    <details className="settings">
      <summary>{label}</summary>
      {children}
    </details>
  );
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
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  const [items, setItems] = useState<readonly HistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  const [view, setView] = useState<CaptureMode>('original');
  const [mathById, setMathById] = useState<Readonly<Record<string, MathConfig>>>({});
  const [xyAxes, setXyAxes] = useState<readonly [XyAxisId, XyAxisId] | null>(null);
  const [fftSettings, setFftSettings] = useState<FftSettings>({ channel: null, window: 'hann', scale: 'dbv' });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const compact = useMedia('(max-width: 1000px)');
  const narrow = useMedia('(max-width: 640px)');
  const [cropOpen, setCropOpen] = useState(false);
  const [forceQuad, setForceQuad] = useState(false);
  const [cropDismissed, setCropDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [cursorsOn, setCursorsOn] = useState(false);

  const [bodeProfile, setBodeProfile] = useState<ProfileChoice>('auto');
  const [sessions, setSessions] = useState<Readonly<Record<string, BodeSession>>>({});
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [bodeZoom, setBodeZoom] = useState<Readonly<Record<string, number>>>({});

  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const replaceIdRef = useRef<string | null>(null);
  const exportsRef = useRef<HTMLElement>(null);
  const itemsRef = useRef<readonly HistoryItem[]>([]);
  const activeRef = useRef<string | null>(null);
  const selectedRef = useRef<readonly string[]>([]);
  const storeRef = useRef<HistoryStore | null>(null);
  const persisted = useRef<Map<string, HistoryItem>>(new Map());
  const cursorSaves = useRef<Map<string, number>>(new Map());
  // Cursor moves not yet confirmed on disk, kept until their save commits so pagehide can still write them.
  const pendingCursors = useRef<Map<string, PendingCursors>>(new Map());
  const saveSeq = useRef<Map<string, number>>(new Map());
  const inFlightSave = useRef<Map<string, HistoryItem>>(new Map());
  // Snapshots that did not fit on disk. They are not retried until their saved fields change.
  const failedSave = useRef<Map<string, HistoryItem>>(new Map());
  const batchRef = useRef(false);
  const batchTokenRef = useRef(0);
  const mathByIdRef = useRef<Readonly<Record<string, MathConfig>>>({});
  const analysisRef = useRef<Analysis | null>(null);
  const analysisLoad = useRef<Promise<Analysis> | null>(null);
  const liveUrls = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const flushCursorSaves = useRef<() => void>(() => undefined);
  const singleReq = useRef<Map<string, number>>(new Map());
  const bodeReq = useRef<Map<string, number>>(new Map());
  const recomputeReq = useRef<Map<string, number>>(new Map());
  const sessionsRef = useRef<Readonly<Record<string, BodeSession>>>({});
  const keepRef = useRef(keepHistory);
  const feedbackTimer = useRef<number | undefined>(undefined);
  const backRef = useRef<HTMLButtonElement>(null);
  const dismissCropRef = useRef<(resetProfile: boolean) => void>(() => undefined);
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  itemsRef.current = items;
  activeRef.current = activeId;
  selectedRef.current = selected;
  keepRef.current = keepHistory;
  mathByIdRef.current = mathById;
  analysisRef.current = analysis;

  const canUseCamera = useMemo(isMobileOrTablet, []);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const urls = new Set(liveUrls.current);
      for (const item of itemsRef.current) urls.add(item.url);
      for (const url of urls) releaseUrl(url);
      liveUrls.current = new Set();
      window.clearTimeout(feedbackTimer.current);
      for (const timer of cursorSaves.current.values()) window.clearTimeout(timer);
      cursorSaves.current.clear();
      pendingCursors.current.clear();
    };
  }, []);

  // Object URLs are revoked here, after React commits, never inside a state updater.
  useEffect(() => {
    const now = new Set(items.map((i) => i.url));
    for (const url of liveUrls.current) if (!now.has(url)) releaseUrl(url);
    liveUrls.current = now;
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let store: HistoryStore | null = null;
      try {
        store = await openHistory();
      } catch {
        store = null;
      }
      if (cancelled) return;
      storeRef.current = store;
      if (!store) {
        setHistoryReady(true);
        return;
      }
      if (readPref('graticule.keepHistory') === '0') {
        try {
          await store.clear();
        } catch {
          /* nothing to clear when storage is blocked */
        }
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
        // Registered as live so the URL effect revokes any that capHistory drops.
        for (const i of loaded) liveUrls.current.add(i.url);
        setItems((prev) => {
          const have = new Set(prev.map((i) => i.id));
          return capHistory([...prev, ...loaded.filter((i) => !have.has(i.id))].sort(compareItems), have);
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
    const stopCursorTimer = (id: string): void => {
      const timer = cursorSaves.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      cursorSaves.current.delete(id);
    };
    const cancelCursorSave = (id: string): void => {
      stopCursorTimer(id);
      pendingCursors.current.delete(id);
    };
    const save = (item: HistoryItem): void => {
      const id = item.id;
      // The same snapshot is already being written, so later renders do not queue it again.
      if (inFlightSave.current.get(id) === item) return;
      inFlightSave.current.set(id, item);
      const settle = (): void => {
        if (inFlightSave.current.get(id) === item) inFlightSave.current.delete(id);
      };
      const seq = (saveSeq.current.get(id) ?? 0) + 1;
      saveSeq.current.set(id, seq);
      // Captures the user is looking at are never deleted to make room for another one.
      const keep = new Set([...selectedRef.current, ...(activeRef.current ? [activeRef.current] : [])]);
      void store.put(item, keep).then(({ ok, evicted }) => {
        settle();
        if (storeRef.current !== store) return;
        for (const gone of evicted) {
          // Deleted from disk to make room. It stays in this session but is not written back,
          // otherwise it would push out another capture in turn.
          persisted.current.delete(gone);
          const live = itemsRef.current.find((i) => i.id === gone);
          if (live) failedSave.current.set(gone, live);
        }
        if (!ok) {
          if (saveSeq.current.get(id) === seq) failedSave.current.set(id, item);
          return;
        }
        failedSave.current.delete(id);
        // This save carried the newest cursor move, so that move no longer waits on its own.
        if (storeRef.current === store && pendingCursors.current.get(id)?.cursors === item.cursors) cancelCursorSave(id);
        const latest = itemsRef.current.find((i) => i.id === id);
        // Removed, or history turned off, while the write was running.
        if (!latest || !keepRef.current) {
          void store.remove(id);
          return;
        }
        // A newer write for this item is still running and will finish the job.
        if (saveSeq.current.get(id) !== seq) return;
        persisted.current.set(id, item);
        // The item changed while this write ran, and nothing newer was saved for it.
        if (latest !== item && latest.state !== 'extracting' && storedChange(item, latest) !== 'none') {
          stopCursorTimer(id);
          save(latest);
        }
      }, settle);
    };
    const flushCursor = (id: string, urgent = false): void => {
      stopCursorTimer(id);
      const pending = pendingCursors.current.get(id);
      if (!pending) return;
      if (storeRef.current !== store || !keepRef.current || !persisted.current.has(id)) {
        pendingCursors.current.delete(id);
        return;
      }
      const token = Symbol('cursors');
      pendingCursors.current.set(id, { ...pending, token });
      void store.updateCursors(id, pending.cursors ?? null, urgent, pending.rev).then((ok) => {
        // A failed write keeps the move, so a queued save or the next pagehide still writes it.
        if (!ok) return;
        // A newer move, another attempt, a full save or a remove took over while this one waited.
        if (pendingCursors.current.get(id)?.token !== token) return;
        pendingCursors.current.delete(id);
        if (storeRef.current !== store) return;
        const was = persisted.current.get(id);
        if (was) persisted.current.set(id, { ...was, cursors: pending.cursors, cursorsAt: pending.rev });
      });
    };
    flushCursorSaves.current = () => {
      for (const id of [...pendingCursors.current.keys()]) flushCursor(id, true);
    };
    for (const item of items) {
      const was = prev.get(item.id);
      const change = was ? storedChange(was, item) : 'other';
      const failed = failedSave.current.get(item.id);
      const id = item.id;
      const pend = pendingCursors.current.get(id);
      // Notes a cursor move that is not on disk yet. The same move already waiting or saving is
      // left alone, so an unrelated render does not restart it. True when the move is new.
      const track = (): boolean => {
        if (pend?.cursors === item.cursors) return false;
        pendingCursors.current.set(id, { cursors: item.cursors, rev: item.cursorsAt ?? nextRev(), token: Symbol('cursors') });
        return true;
      };
      const schedule = (): void => {
        stopCursorTimer(id);
        cursorSaves.current.set(id, window.setTimeout(() => flushCursor(id), CURSOR_SAVE_DELAY));
      };
      if (was && item.state === 'extracting') {
        // The capture is not saved while it extracts again, but a cursor move still is: it stays
        // tracked, so its timer or a pagehide still writes it if the tab reloads before the end.
        next.set(id, was);
        if ((pend || item.cursors !== was.cursors) && track()) schedule();
        continue;
      }
      if (change !== 'none' && failed && storedChange(failed, item) === 'none') {
        // Same snapshot that already failed to save, so it is not written again on every render.
        // A cursor move stays pending, since its small cursor record may still fit at pagehide.
        if (was) next.set(id, was);
        stopCursorTimer(id);
      } else if (change === 'other') {
        if (was) next.set(id, was);
        // The full save carries the cursors too, but it may wait behind another tab's lock, so a
        // cursor move stays pending for pagehide until a save with it commits.
        stopCursorTimer(id);
        if (was && (pend || item.cursors !== was.cursors)) track();
        save(item);
      } else if (change === 'cursors' && was) {
        next.set(id, was);
        if (track()) schedule();
      } else {
        next.set(item.id, item);
        // The cursors went back to the saved ones while an older move still waits, so it is replaced.
        if (pend && track()) schedule();
        if (was && was.lastUsed !== item.lastUsed) void store.updateMeta(item.id, { lastUsed: item.lastUsed });
      }
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) {
        cancelCursorSave(id);
        void store.remove(id);
      }
    }
    const live = new Set(items.map((i) => i.id));
    for (const id of [...failedSave.current.keys()]) if (!live.has(id)) failedSave.current.delete(id);
    persisted.current = next;
  }, [items, keepHistory, historyReady]);

  useEffect(() => {
    const flush = (): void => {
      if (pendingCursors.current.size > 0) flushCursorSaves.current();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const flash = useCallback((text: string) => {
    setFeedback(text);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(''), 2000);
  }, []);

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
    const all = sessionsRef.current;
    const next = { ...all, [key]: { ...(all[key] ?? STAGED_SESSION), ...patch } };
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const resetCaptureView = (nextView: CaptureMode): void => {
    setView(nextView);
    setCropOpen(false);
    setForceQuad(false);
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
      if (item.result || item.state === 'extracting' || item.state === 'error') runSingle(next, false);
    },
    [runSingle],
  );

  const updateMeta = useCallback(
    (id: string, patch: MetaPatch) => {
      patchItem(id, 'cursors' in patch ? { ...patch, cursorsAt: nextRev() } : patch);
    },
    [patchItem],
  );

  const recompute = useCallback(
    (key: string, current: BodeResult, gate: BodeGateOptions, points: PointOverrides) => {
      const req = (recomputeReq.current.get(key) ?? 0) + 1;
      recomputeReq.current.set(key, req);
      setSession(key, { gate, points });
      recomputeBode(current, gate, points).then(
        (r) => {
          if (recomputeReq.current.get(key) !== req) return;
          const cleaned: Record<string, BodePointOverride> = {};
          for (const p of r.points) {
            if (p.override && Object.keys(p.override).length > 0) cleaned[p.id] = p.override;
          }
          setSession(key, { result: r, points: cleaned, error: null });
        },
        (e: unknown) => {
          if (recomputeReq.current.get(key) === req) setSession(key, { error: message(e) });
        },
      );
    },
    [setSession],
  );

  const runBode = useCallback(
    (key: string, list: readonly HistoryItem[], profile: ProfileChoice) => {
      const req = (bodeReq.current.get(key) ?? 0) + 1;
      bodeReq.current.set(key, req);
      const { gate, points } = sessionsRef.current[key] ?? STAGED_SESSION;
      const choiceFor = (i: HistoryItem): ProfileChoice => (profile === 'auto' ? i.profile : profile);
      const input = list.map((i) => ({ fileName: i.name, bytes: i.bytes, overrides: withProfile(i.overrides, choiceFor(i)) }));
      const pointItems = pointItemMap(list);
      setSession(key, { state: 'extracting', error: null, profile });
      analyzeBode(input, gate, points).then(
        (r) => {
          if (bodeReq.current.get(key) !== req) return;
          // Any recompute still running was based on the old result.
          recomputeReq.current.set(key, (recomputeReq.current.get(key) ?? 0) + 1);
          const latest = sessionsRef.current[key] ?? STAGED_SESSION;
          setSession(key, { state: 'extracted', result: r, error: null, pointItems });
          // Analysis does not prefer manual frequencies, so any point edits are applied again on top.
          if (latest.gate !== gate || latest.points !== points || Object.keys(latest.points).length > 0) {
            recompute(key, r, latest.gate, latest.points);
          }
          const cache = new Map<string, ExtractionResult>();
          for (const p of r.points) {
            const itemId = pointItems[p.id];
            if (itemId && p.extraction) cache.set(itemId, p.extraction);
          }
          setItems((all) =>
            all.map((i) => {
              const ex = cache.get(i.id);
              if (!ex || i.result || i.state === 'extracting' || Object.keys(i.overrides).length > 0) return i;
              return { ...i, state: 'extracted', result: ex, error: null, profile: choiceFor(i) };
            }),
          );
        },
        (e: unknown) => {
          if (bodeReq.current.get(key) !== req) return;
          setSession(key, { state: 'error', result: null, error: message(e) });
        },
      );
    },
    [setSession, recompute],
  );

  const openItem = useCallback((id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item) return;
    setActiveId(id);
    setSelected([]);
    setNotice(null);
    setFileNote(null);
    resetCaptureView(item.result ? 'clean' : 'original');
    const now = Date.now();
    setItems((list) => list.map((i) => (i.id === id ? { ...i, lastUsed: now } : i)));
  }, []);

  const toggleSelect = useCallback(
    (id: string) => {
      const cur = selectedRef.current;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      setInspectedId(null);
      setNotice(null);
      setFileNote(null);
      if (next.length === 1 && cur.length >= 2) {
        openItem(next[0]!);
        return;
      }
      selectedRef.current = next;
      setSelected(next);
      if (next.length >= 2) {
        activeRef.current = null;
        setActiveId(null);
        setCropOpen(false);
        setForceQuad(false);
      }
    },
    [openItem],
  );

  const removeItem = useCallback(
    (id: string) => {
      if (!itemsRef.current.some((i) => i.id === id)) return;
      singleReq.current.delete(id);
      if (replaceIdRef.current === id) replaceIdRef.current = null;
      const nextSel = selectedRef.current.filter((x) => x !== id);
      const nothingOpen = activeRef.current === null || activeRef.current === id;
      if (nextSel.length === 1 && nothingOpen) {
        openItem(nextSel[0]!);
      } else {
        setSelected(nextSel);
        if (activeRef.current === id) setActiveId(null);
      }
      setItems((list) => list.filter((i) => i.id !== id));
      setMathById((all) => {
        if (!(id in all)) return all;
        const next = { ...all };
        delete next[id];
        return next;
      });
    },
    [openItem],
  );

  const clearAll = (): void => {
    // Stops a running Export all: it checks this token after every await.
    batchTokenRef.current++;
    batchRef.current = false;
    setBatch(null);
    singleReq.current.clear();
    bodeReq.current.clear();
    recomputeReq.current.clear();
    sessionsRef.current = {};
    replaceIdRef.current = null;
    persisted.current = new Map();
    inFlightSave.current.clear();
    failedSave.current.clear();
    for (const timer of cursorSaves.current.values()) window.clearTimeout(timer);
    cursorSaves.current.clear();
    pendingCursors.current.clear();
    void storeRef.current?.clear();
    setItems([]);
    setSelected([]);
    setActiveId(null);
    setSessions({});
    setBodeZoom({});
    setMathById({});
    setNotice(null);
    setFileNote(null);
    setCropDismissed(new Set());
    resetCaptureView('original');
  };

  const onKeepHistory = (keep: boolean): void => {
    setKeepHistory(keep);
    writePref('graticule.keepHistory', keep ? '1' : '0');
    persisted.current = new Map();
    // A write that started before this switch may land before a clear, so the item is written again.
    inFlightSave.current.clear();
    failedSave.current.clear();
    for (const timer of cursorSaves.current.values()) window.clearTimeout(timer);
    cursorSaves.current.clear();
    pendingCursors.current.clear();
    if (!keep) void storeRef.current?.clear();
  };

  const addFiles = useCallback(
    async (raw: readonly File[], source: Source) => {
      // Consumed first so a failed or empty pick can never delete the open capture later.
      const replaceId = replaceIdRef.current;
      replaceIdRef.current = null;
      const images = raw
        .filter(isImageFile)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, HISTORY_LIMIT);
      if (images.length === 0) {
        if (raw.length > 0) {
          setNotice(tx.unsupportedFile);
          setFileNote(null);
        }
        return;
      }
      setAdding(true);
      setNotice(null);
      setFileNote(null);
      const added: HistoryItem[] = [];
      const skipped: string[] = [];
      let committed = false;
      try {
        const now = Date.now();
        for (const f of images) {
          const name = f.name || 'photo.png';
          let loaded: LoadedFile;
          try {
            loaded = await loadFile(f, name, { photo: source === 'camera' });
          } catch {
            if (!mountedRef.current) {
              releaseItems(added);
              return;
            }
            skipped.push(name);
            continue;
          }
          if (!mountedRef.current) {
            releaseUrl(loaded.url);
            releaseItems(added);
            return;
          }
          const { hasExif, ...file } = loaded;
          const photo = source === 'camera' || isPhotoLike(f) || hasExif;
          added.push({
            ...file,
            addedAt: now,
            lastUsed: now,
            state: 'staged',
            result: null,
            error: null,
            overrides: {},
            profile: 'auto',
            quality: photo ? checkPhoto(loaded.bytes) : null,
            isPhoto: photo,
          });
        }
        if (added.length === 0) {
          setFileNote(tx.filesUnreadable(skipped));
          return;
        }
        if (replaceId) singleReq.current.delete(replaceId);
        const keep = new Set(added.map((i) => i.id));
        // Registered before the update so the URL effect revokes any that capHistory drops.
        for (const i of added) liveUrls.current.add(i.url);
        committed = true;
        setItems((list) => {
          const base = replaceId ? list.filter((i) => i.id !== replaceId) : list;
          return capHistory([...added, ...base].sort(compareItems), keep);
        });
        if (added.length === 1) {
          setActiveId(added[0]!.id);
          setSelected([]);
        } else {
          setActiveId(null);
          setSelected(added.map((i) => i.id));
        }
        resetCaptureView('original');
        if (skipped.length > 0) setFileNote(tx.filesSkipped(skipped));
      } catch (e) {
        if (!committed) releaseItems(added);
        if (mountedRef.current) setNotice(`${tx.error}: ${message(e)}`);
      } finally {
        if (mountedRef.current) setAdding(false);
      }
    },
    [tx],
  );

  const openPicker = useCallback((folder: boolean, replaceId: string | null = null) => {
    const input = fileInput.current;
    if (!input) return;
    replaceIdRef.current = replaceId;
    if (folder) input.setAttribute('webkitdirectory', '');
    else input.removeAttribute('webkitdirectory');
    input.click();
  }, []);

  const openCamera = useCallback((replaceId: string | null = null) => {
    replaceIdRef.current = replaceId;
    cameraInput.current?.click();
  }, []);

  const inspected = useMemo(
    () => (mode === 'bode' && bode && inspectedId ? bode.points.find((p) => p.id === inspectedId) ?? null : null),
    [mode, bode, inspectedId],
  );
  const inspectedItem = inspected && session ? items.find((i) => i.id === session.pointItems[inspected.id]) ?? null : null;
  const showCapture = mode === 'single' || inspected !== null;
  const capture: ExtractionResult | null = mode === 'single' ? activeItem?.result ?? null : inspected?.extraction ?? null;
  const captureItem = mode === 'single' ? activeItem : inspectedItem;
  const captureName = captureItem?.name ?? inspected?.fileName ?? '';
  const captureTitle = captureItem?.title?.trim() || captureName;
  const captureLabels: ChannelLabels | undefined = captureItem?.channelLabels;
  const sessionProfile: ProfileChoice = session?.profile ?? bodeProfile;
  const profileChoice: ProfileChoice = mode === 'single' ? activeItem?.profile ?? 'auto' : sessionProfile;
  const isUniversal =
    mode === 'single' &&
    (activeItem?.profile === 'universal-fallback' || activeItem?.result?.detection.profileId === 'universal-fallback');
  const autoCrop =
    isUniversal && activeItem !== null && !hasManualBox(activeItem.overrides) && !cropDismissed.has(activeItem.id);
  const cropVisible = mode === 'single' && activeItem !== null && (cropOpen || autoCrop);

  // A failed load is forgotten so the next call tries again instead of staying broken.
  const loadAnalysis = useCallback((): Promise<Analysis> => {
    if (analysisRef.current) return Promise.resolve(analysisRef.current);
    if (!analysisLoad.current) {
      analysisLoad.current = import('./analysis').then(
        (mod) => {
          if (mountedRef.current) setAnalysis(mod);
          return mod;
        },
        (e: unknown) => {
          analysisLoad.current = null;
          throw e;
        },
      );
    }
    return analysisLoad.current;
  }, []);

  const requestAnalysis = useCallback(() => {
    if (analysisRef.current) return;
    loadAnalysis().catch((e: unknown) => {
      if (mountedRef.current) setNotice(message(e));
    });
  }, [loadAnalysis]);

  const hasAnyResult = capture !== null || items.some((i) => i.result !== null);
  useEffect(() => {
    if (!hasAnyResult || analysis) return;
    loadAnalysis().catch(() => undefined);
  }, [hasAnyResult, analysis, loadAnalysis]);

  const channels = useMemo(() => enabledChannels(capture), [capture]);
  // An inspected Bode capture has no Math controls, so a Math setup from single view stays out of it.
  const storedMath = mode === 'single' && captureItem ? mathById[captureItem.id] ?? null : null;
  const mathConfig = useMemo(() => usableMath(storedMath, channels), [storedMath, channels]);
  const math: MathTraceResult | null = useMemo(() => {
    if (!analysis || !capture || !mathConfig) return null;
    try {
      return analysis.computeMathTrace(capture, { ...mathConfig, label: mathConfig.label?.trim() || mathAutoLabel(mathConfig) });
    } catch {
      return null;
    }
  }, [analysis, capture, mathConfig]);
  const axisName = useCallback(
    (axis: string): string => (axis === 'M' ? math?.label ?? 'M' : captureLabels?.[axis as ChannelId]?.trim() || axis),
    [math, captureLabels],
  );
  const axes: readonly AxisOption[] = useMemo(() => {
    const ids: XyAxisId[] = [...channels, ...(math ? (['M'] as const) : [])];
    return ids.map((id) => ({ id, label: axisName(id) }));
  }, [channels, math, axisName]);
  const axisIds = axes.map((a) => a.id);
  const xyReady = axes.length >= 2;
  const hasAxes = axes.length > 0;
  const effectiveView: CaptureMode = !capture
    ? 'original'
    : (view === 'xy' && !xyReady) || (view === 'fft' && !hasAxes)
      ? 'clean'
      : view;
  // Stored view drops back to Clean so turning a channel back on later does not jump to XY or FFT.
  useEffect(() => {
    if ((view === 'xy' && !xyReady) || (view === 'fft' && !hasAxes)) setView('clean');
  }, [view, xyReady, hasAxes]);
  const xyX: XyAxisId = xyAxes && axisIds.includes(xyAxes[0]) ? xyAxes[0] : axisIds[0] ?? 'C1';
  const xyY: XyAxisId =
    xyAxes && axisIds.includes(xyAxes[1]) && xyAxes[1] !== xyX ? xyAxes[1] : axisIds.find((a) => a !== xyX) ?? 'C2';
  const fftChannel: XyAxisId =
    fftSettings.channel && axisIds.includes(fftSettings.channel) ? fftSettings.channel : axisIds[0] ?? 'C1';

  const xyResult = useMemo(() => {
    if (!analysis || !capture || effectiveView !== 'xy' || !xyReady) return null;
    try {
      return analysis.computeXyPlot(capture, xyX, xyY, math);
    } catch {
      return null;
    }
  }, [analysis, capture, effectiveView, xyReady, xyX, xyY, math]);
  const spectrum = useMemo(() => {
    if (!analysis || !capture || effectiveView !== 'fft' || !hasAxes) return null;
    try {
      return analysis.computeSpectrum(capture, { channel: fftChannel, window: fftSettings.window, math });
    } catch {
      return null;
    }
  }, [analysis, capture, effectiveView, hasAxes, fftChannel, fftSettings.window, math]);

  const xyTitle = `${captureTitle} (XY)`;
  const fftTitle = `${captureTitle} (FFT ${axisName(fftChannel)})`;
  const xyLabelX = axisName(xyX);
  const xyLabelY = axisName(xyY);
  const xySvg = useMemo(
    () =>
      analysis && xyResult
        ? analysis.renderXySvg(xyResult, {
            locale,
            title: xyTitle,
            xLabel: xyLabelX,
            yLabel: xyLabelY,
            theme: dark ? 'dark' : 'light',
            ...(narrow ? { width: 420, height: 400 } : {}),
          })
        : '',
    [analysis, xyResult, dark, locale, xyTitle, xyLabelX, xyLabelY, narrow],
  );
  const fftSvg = useMemo(
    () =>
      analysis && spectrum
        ? analysis.renderSpectrumSvg(spectrum, {
            locale,
            title: fftTitle,
            scale: fftSettings.scale,
            theme: dark ? 'dark' : 'light',
            ...(narrow ? { width: 460, height: 340 } : {}),
          })
        : '',
    [analysis, spectrum, dark, locale, fftTitle, fftSettings.scale, narrow],
  );
  const xyControls: XyControls | null = xyReady
    ? { axes, x: xyX, y: xyY, svg: xySvg, onAxes: (x, y) => setXyAxes([x, y]) }
    : null;
  const fftControls: FftControls | null =
    hasAxes
      ? {
          axes,
          channel: fftChannel,
          window: fftSettings.window,
          scale: fftSettings.scale,
          svg: fftSvg,
          onChannel: (channel) => setFftSettings((s) => ({ ...s, channel })),
          onWindow: (window) => setFftSettings((s) => ({ ...s, window })),
          onScale: (scale) => setFftSettings((s) => ({ ...s, scale })),
        }
      : null;
  const mathField: MathField | undefined = captureItem
    ? {
        config: mathConfig,
        result: math,
        onChange: (config) => {
          if (config) requestAnalysis();
          const id = captureItem.id;
          setMathById((all) => {
            const next = { ...all };
            if (config) next[id] = config;
            else delete next[id];
            return next;
          });
        },
      }
    : undefined;

  const cursorsShown = cursorsOn && mode === 'single' && effectiveView === 'clean' && !cropVisible && Boolean(activeItem?.result);
  const cursors: PlotCursors | null =
    cursorsShown && activeItem?.result ? resolveCursors(activeItem.result, activeItem.cursors) : null;

  const rejectedIds = useMemo(() => {
    const out = new Set<string>();
    if (!bode || !session) return out;
    for (const p of bode.points) if (!p.accepted && session.pointItems[p.id]) out.add(session.pointItems[p.id]!);
    return out;
  }, [bode, session]);

  const dismissCrop = (resetProfile: boolean): void => {
    setCropOpen(false);
    setForceQuad(false);
    if (!activeItem) return;
    const id = activeItem.id;
    setCropDismissed((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    if (resetProfile && activeItem.profile === 'universal-fallback' && !hasManualBox(activeItem.overrides)) {
      updateItem(id, { profile: 'auto' });
    }
  };

  dismissCropRef.current = dismissCrop;

  const selectView = (v: CaptureMode): void => {
    if (v !== 'original' && v !== 'overlay' && cropVisible) dismissCrop(false);
    if (v === 'xy' || v === 'fft') requestAnalysis();
    setView(v);
  };
  const selectViewRef = useRef(selectView);
  selectViewRef.current = selectView;

  const shownPointId = inspected?.id ?? null;
  useEffect(() => {
    if (shownPointId !== null) backRef.current?.focus();
  }, [shownPointId]);

  const toggleOverlay = useCallback(() => {
    setView((v) => (v === 'overlay' ? 'clean' : 'overlay'));
  }, []);

  const toggleCursors = useCallback(() => {
    const item = itemsRef.current.find((i) => i.id === activeRef.current);
    if (!item?.result) return;
    if (cursorsShown) {
      setCursorsOn(false);
      return;
    }
    if (cropVisible) return;
    setView('clean');
    setCropOpen(false);
    setForceQuad(false);
    setCursorsOn(true);
  }, [cursorsShown, cropVisible]);

  const exportAll = useCallback(
    async (list: readonly HistoryItem[]) => {
      if (batchRef.current || list.length === 0) return;
      batchRef.current = true;
      const token = ++batchTokenRef.current;
      // False once Clear ran or the app unmounted, so nothing more is extracted, shown or downloaded.
      const live = (): boolean => mountedRef.current && batchTokenRef.current === token;
      const current = (id: string): HistoryItem | undefined => itemsRef.current.find((i) => i.id === id);
      const cancelled = new Error('cancelled');
      const total = list.length;
      const ready: { id: string; result: ExtractionResult }[] = [];
      const failed: string[] = [];
      setNotice(null);
      setFileNote(null);
      setBatch({ phase: 'extract', done: 0, total });
      try {
        for (const [index, original] of list.entries()) {
          const item = current(original.id);
          // Removed while the batch ran.
          if (item) {
            let result = item.result;
            if (!result) {
              const id = item.id;
              const req = (singleReq.current.get(id) ?? 0) + 1;
              singleReq.current.set(id, req);
              patchItem(id, { state: 'extracting', error: null });
              try {
                result = await analyzeSingle(item.bytes, item.name, withProfile(item.overrides, item.profile));
                if (singleReq.current.get(id) === req) patchItem(id, { state: 'extracted', result, error: null });
              } catch (e) {
                if (singleReq.current.get(id) === req) patchItem(id, { state: 'error', result: null, error: message(e) });
                result = null;
                if (live() && current(id)) failed.push(current(id)!.name);
              }
              if (!live()) return;
            }
            if (result && current(item.id)) ready.push({ id: item.id, result });
          }
          setBatch({ phase: 'extract', done: index + 1, total });
        }
        if (ready.length === 0) {
          if (failed.length > 0) setFileNote(tx.filesUnreadable(failed));
          return;
        }
        const { buildBatchReportZip, svgToPngBytes } = await import('./batchExport');
        if (!live()) return;
        const mathConfigs = mathByIdRef.current;
        let mathTools: Analysis | null = null;
        if (ready.some(({ id }) => mathConfigs[id])) {
          try {
            mathTools = await loadAnalysis();
          } catch {
            mathTools = null;
          }
          if (!live()) return;
        }
        // Read again now so title, label and Math edits made during the batch are in the report.
        const entries = ready.flatMap(({ id, result }) => {
          const item = current(id);
          if (!item) return [];
          const config = usableMath(mathConfigs[id], enabledChannels(result));
          let math: MathTraceResult | null = null;
          if (mathTools && config) {
            try {
              math = mathTools.computeMathTrace(result, { ...config, label: config.label?.trim() || mathAutoLabel(config) });
            } catch {
              math = null;
            }
          }
          return [{
            fileName: item.name,
            result,
            ...(item.title ? { title: item.title } : {}),
            ...(item.channelLabels ? { channelLabels: item.channelLabels } : {}),
            ...(math ? { math } : {}),
          }];
        });
        if (entries.length === 0) return;
        setBatch({ phase: 'zip', done: 0, total: entries.length });
        const zip = await buildBatchReportZip(entries, {
          locale,
          renderPng: async (svg) => {
            if (!live()) throw cancelled;
            const png = await svgToPngBytes(svg, 2);
            if (!live()) throw cancelled;
            return png;
          },
          onProgress: (done, count) => {
            if (live()) setBatch({ phase: 'zip', done, total: count });
          },
        });
        if (!live()) return;
        downloadBlob(new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), 'graticule-report.zip');
        flash(tx.zipReady);
        if (failed.length > 0) setFileNote(tx.zipSkipped(failed));
      } catch (e) {
        if (live() && e !== cancelled) setNotice(message(e));
      } finally {
        // After Clear, a newer batch may already own these.
        if (batchTokenRef.current === token) {
          batchRef.current = false;
          if (mountedRef.current) setBatch(null);
        }
      }
    },
    [patchItem, locale, tx, flash, loadAnalysis],
  );

  const extractActive = useCallback(() => {
    const item = itemsRef.current.find((i) => i.id === activeRef.current);
    if (item) runSingle(item, true);
  }, [runSingle]);

  const exportSource: ExportSource | null = useMemo(() => {
    if (showCapture && capture) {
      const labels = captureLabels;
      const svgCursors = cursors ?? undefined;
      const base = baseName(captureTitle);
      if (effectiveView === 'xy') {
        if (!analysis || !xyResult) return null;
        const xy = xyResult;
        return {
          baseName: `${base}_xy`,
          svg: () => analysis.renderXySvg(xy, { locale, title: xyTitle, xLabel: xyLabelX, yLabel: xyLabelY }),
          csv: () => analysis.renderXyCsv(xy, captureTitle || undefined),
        };
      }
      if (effectiveView === 'fft') {
        if (!analysis || !spectrum) return null;
        const spec = spectrum;
        return {
          baseName: `${base}_fft`,
          svg: () => analysis.renderSpectrumSvg(spec, { locale, title: fftTitle, scale: fftSettings.scale }),
          csv: () => analysis.renderSpectrumCsv(spec, captureTitle || undefined),
          table: (f) => analysis.renderSpectrumTable(spec, locale, f, fftTitle),
        };
      }
      return {
        baseName: base,
        svg: () =>
          renderWaveformSvg(capture, {
            locale,
            title: captureTitle,
            math,
            ...(labels ? { channelLabels: labels } : {}),
            ...(svgCursors ? { cursors: svgCursors } : {}),
          }),
        csv: () => renderWaveformCsv(capture, labels, captureTitle || undefined, math),
        table: (f) => renderMeasurementsTable(capture, f, locale, labels, captureTitle, math),
      };
    }
    // An inspected Bode capture with no extraction has nothing to export, never the whole Bode plot.
    if (showCapture) return null;
    if (mode === 'bode' && bode) {
      const named = session?.title?.trim() ?? '';
      return {
        baseName: named ? baseName(named) : 'bode',
        svg: () => renderBodeSvg(bode, { locale, title: named || 'Bode' }),
        csv: () => renderBodeCsv(bode, named || undefined),
        table: (f) => renderBodeTable(bode, f, locale, named || undefined),
      };
    }
    return null;
  }, [
    showCapture,
    capture,
    captureTitle,
    captureLabels,
    cursors,
    mode,
    bode,
    session?.title,
    locale,
    effectiveView,
    analysis,
    xyResult,
    spectrum,
    xyTitle,
    xyLabelX,
    xyLabelY,
    fftTitle,
    fftSettings.scale,
    math,
  ]);

  const copyPlot = useCallback(
    (src: ExportSource) => {
      let png: Promise<Blob>;
      try {
        png = svgToPng(src.svg(), 2);
      } catch {
        flash(tx.copyFailed);
        return;
      }
      copyImage(png).then(
        () => flash(tx.plotCopied),
        () => flash(tx.copyFailed),
      );
    },
    [flash, tx.copyFailed, tx.plotCopied],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && help) {
        setHelp(false);
        return;
      }
      if (e.key === 'Escape' && cropVisible && !e.defaultPrevented && !isTyping(e.target)) {
        e.preventDefault();
        dismissCropRef.current(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
        if (help || isTyping(e.target) || hasTextSelection() || !exportSource) return;
        e.preventDefault();
        copyPlot(exportSource);
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
        const first = exportsRef.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)');
        (first ?? exportsRef.current)?.focus();
      } else if (k === 't' && showCapture && capture) {
        e.preventDefault();
        toggleOverlay();
      } else if (k === 'c' && mode === 'single' && capture && !cropVisible) {
        e.preventDefault();
        toggleCursors();
      } else if (VIEW_KEYS[k] && showCapture && capture) {
        const next = VIEW_KEYS[k]!;
        if (next === 'xy' && !xyReady) return;
        if (next === 'fft' && !hasAxes) return;
        e.preventDefault();
        selectViewRef.current(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, openPicker, showCapture, capture, toggleOverlay, toggleCursors, mode, exportSource, copyPlot, cropVisible, xyReady, hasAxes]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
      if (files.length === 0) return;
      e.preventDefault();
      replaceIdRef.current = null;
      void addFiles(
        files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted_${Date.now()}_${i + 1}.png`, { type: f.type }))),
        'pick',
      );
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const sampleBusy = useRef(false);
  const loadSample = useCallback(async () => {
    if (adding || sampleBusy.current) return;
    sampleBusy.current = true;
    replaceIdRef.current = null;
    try {
      const { sampleFile } = await import('./sample');
      if (!mountedRef.current) return;
      await addFiles([sampleFile()], 'pick');
    } catch (e) {
      if (mountedRef.current) setNotice(message(e));
    } finally {
      sampleBusy.current = false;
    }
  }, [adding, addFiles]);

  const onDrop = async (e: React.DragEvent) => {
    setDragging(false);
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    replaceIdRef.current = null;
    const list = await filesFromDataTransfer(e.dataTransfer);
    await addFiles(list, 'pick');
  };

  const extracting = mode === 'single' ? activeItem?.state === 'extracting' : session?.state === 'extracting';
  const status = batch
    ? batch.phase === 'extract'
      ? tx.extractingProgress(batch.done, batch.total)
      : tx.exportingProgress(batch.done, batch.total)
    : adding || extracting
      ? tx.working
      : mode === 'single' && activeItem?.result && activeItem.state === 'extracted'
        ? tx.extractedSingle(
            activeItem.result.traces.filter((tr) => tr.settings.enabled).length,
            formatDuration(activeItem.result.elapsedMs, locale),
          )
        : mode === 'bode' && bode
          ? tx.extractedBode(bode.points.length, formatDuration(bode.elapsedMs, locale))
          : '';
  // Only a capture's own read or extraction error gets the "could not read this file" prefix.
  const fileError = mode === 'single' ? activeItem?.error ?? null : session?.error ?? null;
  const error = notice ?? (fileError ? `${tx.error}: ${fileError}` : null);

  const toggleTheme = (): void => {
    const next: Theme = dark ? 'light' : 'dark';
    setTheme(next);
    writePref('graticule.theme', next);
  };

  const quality = mode === 'single' ? activeItem?.quality ?? null : null;

  const titleField: TitleField | null =
    mode === 'single' && activeItem
      ? {
          value: activeItem.title ?? '',
          placeholder: activeItem.name,
          onCommit: (v) => updateMeta(activeItem.id, { title: v || undefined }),
        }
      : mode === 'bode' && bodeKey && bode && !inspected
        ? {
            value: session?.title ?? '',
            placeholder: 'Bode',
            onCommit: (v) => setSession(bodeKey, { title: v || undefined }),
          }
        : null;

  const setLabel = (ch: ChannelId, label: string): void => {
    if (!activeItem) return;
    const next: Record<string, string> = { ...activeItem.channelLabels };
    if (label) next[ch] = label;
    else delete next[ch];
    updateMeta(activeItem.id, { channelLabels: Object.keys(next).length ? (next as ChannelLabels) : undefined });
  };

  return (
    <div
      className={`app mode-${mode}${items.length === 0 ? ' no-history' : ''}${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
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
        onShortcuts={canUseCamera ? undefined : () => setHelp((h) => !h)}
        onAdd={() => openPicker(false)}
        onCamera={canUseCamera ? () => openCamera() : undefined}
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
      {canUseCamera && (
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
      )}

      <FilePanel
        tx={tx}
        items={items}
        activeId={mode === 'single' ? activeId : inspectedItem?.id ?? null}
        selected={new Set(selected)}
        rejected={mode === 'bode' ? rejectedIds : new Set()}
        keepHistory={keepHistory}
        onAdd={() => openPicker(false)}
        onAddFolder={() => openPicker(true)}
        onCamera={canUseCamera ? () => openCamera() : undefined}
        onOpen={openItem}
        onToggle={toggleSelect}
        onRemove={removeItem}
        onClear={clearAll}
        onKeepHistory={onKeepHistory}
      />

      <main className={`zone center${showCapture ? ' fit' : ''}`}>
        {mode === 'empty' && !adding && (
          <EmptyState
            tx={tx}
            onAdd={() => openPicker(false)}
            onCamera={canUseCamera ? () => openCamera() : undefined}
            onSample={items.length === 0 ? () => void loadSample() : undefined}
            busy={adding}
          />
        )}
        {mode === 'empty' && adding && <p className="muted center-msg">{tx.working}</p>}

        {compact && items.length >= 2 && (
          <select
            className="switcher"
            aria-label={tx.captureSwitch}
            value={mode === 'single' && activeId ? activeId : ''}
            onChange={(e) => {
              if (e.target.value) openItem(e.target.value);
            }}
          >
            {(mode !== 'single' || !activeId) && (
              <option value="">{mode === 'bode' ? tx.nSelected(selected.length) : tx.captureSwitch}</option>
            )}
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title?.trim() || i.name}
              </option>
            ))}
          </select>
        )}

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
                  if (canUseCamera) openCamera(activeItem.id);
                  else openPicker(false, activeItem.id);
                }}
              >
                {canUseCamera ? tx.photoRetake : tx.photoChooseAnother}
              </button>
              {quality.issues.includes('tilted') && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    patchItem(activeItem.id, { quality: null });
                    setView('original');
                    setForceQuad(true);
                    setCropOpen(true);
                  }}
                >
                  {tx.photoStraighten}
                </button>
              )}
              <button type="button" className="btn" onClick={() => patchItem(activeItem.id, { quality: null })}>
                {tx.photoUseAnyway}
              </button>
            </div>
          </div>
        )}

        {mode === 'bode' && inspected && (
          <div className="toolbar">
            <button
              ref={backRef}
              type="button"
              className="btn"
              onClick={() => {
                setReturnFocusId(inspectedId);
                setInspectedId(null);
              }}
            >
              {tx.backToBode}
            </button>
            <span className="muted small">{captureName}</span>
          </div>
        )}

        {mode === 'bode' && inspected && !inspected.extraction && (
          <div className="banner" role="alert" data-testid="inspect-failed">
            <p className="banner-title">{tx.inspectFailed}</p>
            {inspected.rejectionReasons.length > 0 && (
              <ul className="banner-list">
                {inspected.rejectionReasons.map((r) => (
                  <li key={r}>{reasonLabel(r, locale)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showCapture && captureItem && (
          <CaptureView
            key={captureItem.id}
            tx={tx}
            locale={locale}
            dark={dark}
            url={captureItem.url}
            fileName={captureName}
            title={captureTitle}
            channelLabels={captureLabels}
            result={capture}
            extracting={mode === 'single' && activeItem?.state === 'extracting'}
            view={effectiveView}
            math={math}
            xy={xyReady ? xyControls : null}
            fft={hasAxes ? fftControls : null}
            cropOpen={cropVisible}
            canCrop={mode === 'single'}
            isPhoto={captureItem.isPhoto === true}
            forceQuad={forceQuad}
            overrides={mode === 'single' ? activeItem?.overrides ?? {} : {}}
            cursors={cursors}
            onExtract={mode === 'single' && !quality ? extractActive : null}
            onView={selectView}
            onCursors={mode === 'single' ? toggleCursors : null}
            onCursorsChange={(c) => activeItem && updateMeta(activeItem.id, { cursors: c })}
            onCropOpen={(open) => {
              if (open) {
                setCropOpen(true);
                setCursorsOn(false);
              } else {
                dismissCrop(true);
              }
            }}
            onApplyCrop={(crop: Rect, hDivs: number, vDivs: number) => {
              if (activeItem) {
                const { manualQuad: _q, ...rest } = activeItem.overrides;
                updateItem(activeItem.id, { overrides: { ...rest, manualCrop: crop, hDivs, vDivs } });
              }
              setCropOpen(false);
              setForceQuad(false);
            }}
            onApplyQuad={(quad: Quad, hDivs: number, vDivs: number) => {
              if (activeItem) {
                const { manualCrop: _c, ...rest } = activeItem.overrides;
                updateItem(activeItem.id, { overrides: { ...rest, manualQuad: quad, hDivs, vDivs } });
              }
              setCropOpen(false);
              setForceQuad(false);
            }}
          />
        )}

        {mode === 'bode' && bodeKey && !bode && (
          <div className="empty">
            <p className="empty-lead">{tx.bodeStaged(selectedItems.length)}</p>
            <div className="btn-row pair">
              <button
                type="button"
                className="btn primary"
                disabled={session?.state === 'extracting' || batch !== null}
                onClick={() => runBode(bodeKey, selectedItems, sessionProfile)}
              >
                {session?.state === 'extracting' ? tx.working : tx.extractBode(selectedItems.length)}
              </button>
              <button
                type="button"
                className="btn"
                disabled={session?.state === 'extracting' || batch !== null}
                onClick={() => void exportAll(selectedItems)}
              >
                {tx.exportAll}
              </button>
            </div>
          </div>
        )}

        {mode === 'bode' && bodeKey && session && bode && !inspected && (
          <BodeView
            tx={tx}
            locale={locale}
            dark={dark}
            result={bode}
            title={session.title}
            zoom={bodeZoom[bodeKey] ?? 100}
            onZoom={(z) => setBodeZoom((all) => ({ ...all, [bodeKey]: z }))}
            overrides={session.points}
            inspectedId={inspectedId}
            focusId={returnFocusId}
            onFocused={() => setReturnFocusId(null)}
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
              setReturnFocusId(null);
              setInspectedId(id);
              setView('clean');
            }}
            onReset={() => recompute(bodeKey, bode, session.gate, {})}
          />
        )}

        {fileNote && (
          <p className="error" role="alert" data-testid="file-note">
            {fileNote}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
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
          <SettingsFold compact={compact} label={tx.settings}>
          <ProfilePanel
            tx={tx}
            choice={profileChoice}
            disabled={mode === 'empty'}
            result={mode === 'bode' ? inspected?.extraction ?? null : activeItem?.result ?? null}
            onChoice={(choice) => {
              if (mode === 'single' && activeItem) {
                if (choice === 'universal-fallback') {
                  const id = activeItem.id;
                  setCropDismissed((prev) => {
                    if (!prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                  });
                }
                updateItem(activeItem.id, { profile: choice });
              } else {
                setBodeProfile(choice);
                if (!bodeKey) return;
                if (session?.result || session?.state === 'extracting') runBode(bodeKey, selectedItems, choice);
                else setSession(bodeKey, { profile: choice });
              }
            }}
          />
          {mode !== 'bode' && (
            <ScaleControls
              tx={tx}
              locale={locale}
              result={activeItem?.result ?? null}
              overrides={activeItem?.overrides ?? {}}
              disabled={false}
              labels={activeItem?.channelLabels}
              onOverrides={(next) => activeItem && updateItem(activeItem.id, { overrides: next })}
              onLabel={activeItem ? setLabel : undefined}
              math={mode === 'single' ? mathField : undefined}
            />
          )}
          </SettingsFold>
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
          {(mode !== 'bode' || inspected) && (
            <MeasurementsPanel
              tx={tx}
              locale={locale}
              result={capture}
              labels={captureLabels}
              math={math}
              xy={effectiveView === 'xy' ? xyResult : null}
              spectrum={effectiveView === 'fft' ? spectrum : null}
              axisLabel={axisName}
            />
          )}
        </div>
        <ExportPanel
          ref={exportsRef}
          tx={tx}
          source={exportSource}
          feedback={feedback}
          title={titleField}
          onSvg={(src) => {
            try {
              downloadText(src.svg(), `${src.baseName}.svg`, 'image/svg+xml');
            } catch {
              flash(tx.exportFailed);
            }
          }}
          onPng={(src) => {
            let png: Promise<Blob>;
            try {
              png = svgToPng(src.svg(), 2);
            } catch {
              flash(tx.exportFailed);
              return;
            }
            png.then(
              (blob) => downloadBlob(blob, `${src.baseName}_2x.png`),
              () => flash(tx.exportFailed),
            );
          }}
          onCsv={(src) => {
            try {
              downloadText(src.csv(), `${src.baseName}.csv`, 'text/csv');
            } catch {
              flash(tx.exportFailed);
            }
          }}
          onCopyPlot={copyPlot}
          onCopyTable={(src, f) => {
            const table = src.table;
            if (!table) return;
            let job: Promise<void>;
            try {
              job = f === 'html' ? copyRich(table('html'), table('tsv')) : copyPlain(table(f));
            } catch {
              flash(tx.copyFailed);
              return;
            }
            job.then(
              () => flash(tx.copied),
              () => flash(tx.copyFailed),
            );
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
