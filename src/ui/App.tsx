import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodeGateOptions,
  BodePointOverride,
  BodeResult,
  ChannelId,
  ExtractionOverrides,
  ExtractionResult,
  Locale,
  PlotCursors,
  Quad,
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
import { HISTORY_LIMIT, capHistory, compareItems, openHistory, releaseItems, storedChange } from './history';
import type { ChannelLabels, HistoryItem, HistoryStore, ItemState } from './history';
import { baseName, copyImage, copyPlain, copyRich, downloadBlob, downloadText, svgToPng } from './download';
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
import type { ExportSource, TitleField } from './components/Exports';
import { ShortcutsModal } from './components/ShortcutsModal';
import { resolveCursors } from './components/Cursors';

type Theme = 'light' | 'dark';
type PointOverrides = Readonly<Record<string, BodePointOverride>>;
type Source = 'pick' | 'camera';
type MetaPatch = Pick<Partial<HistoryItem>, 'title' | 'channelLabels' | 'cursors'>;

interface BodeSession {
  readonly state: ItemState;
  readonly result: BodeResult | null;
  readonly error: string | null;
  readonly gate: BodeGateOptions;
  readonly points: PointOverrides;
  readonly pointItems: Readonly<Record<string, string>>;
  readonly profile?: ProfileChoice;
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
  const [feedback, setFeedback] = useState('');

  const [items, setItems] = useState<readonly HistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [historyReady, setHistoryReady] = useState(false);

  const [view, setView] = useState<CaptureMode>('original');
  const [overlay, setOverlay] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [forceQuad, setForceQuad] = useState(false);
  const [cropDismissed, setCropDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [cursorsOn, setCursorsOn] = useState(false);

  const [bodeProfile, setBodeProfile] = useState<ProfileChoice>('auto');
  const [sessions, setSessions] = useState<Readonly<Record<string, BodeSession>>>({});
  const [inspectedId, setInspectedId] = useState<string | null>(null);

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
  const liveUrls = useRef<Set<string>>(new Set());
  const singleReq = useRef<Map<string, number>>(new Map());
  const bodeReq = useRef<Map<string, number>>(new Map());
  const recomputeReq = useRef<Map<string, number>>(new Map());
  const sessionsRef = useRef<Readonly<Record<string, BodeSession>>>({});
  const keepRef = useRef(keepHistory);
  const feedbackTimer = useRef<number | undefined>(undefined);
  itemsRef.current = items;
  activeRef.current = activeId;
  selectedRef.current = selected;
  keepRef.current = keepHistory;

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

  useEffect(
    () => () => {
      releaseItems(itemsRef.current);
      window.clearTimeout(feedbackTimer.current);
      for (const timer of cursorSaves.current.values()) window.clearTimeout(timer);
    },
    [],
  );

  // Object URLs are revoked here, after React commits, never inside a state updater.
  useEffect(() => {
    const now = new Set(items.map((i) => i.url));
    for (const url of liveUrls.current) if (!now.has(url)) releaseUrl(url);
    liveUrls.current = now;
  }, [items]);

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
    const cancelCursorSave = (id: string): void => {
      const timer = cursorSaves.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      cursorSaves.current.delete(id);
    };
    const save = (item: HistoryItem): void => {
      void store.put(item).then((ok) => {
        if (!ok || storeRef.current !== store) return;
        // Removed while the write was running, so the removal effect never saw it as saved.
        if (!itemsRef.current.some((i) => i.id === item.id)) void store.remove(item.id);
        else if (keepRef.current) persisted.current.set(item.id, item);
      });
    };
    for (const item of items) {
      const was = prev.get(item.id);
      if (was && item.state === 'extracting') {
        next.set(item.id, was);
        continue;
      }
      const change = was ? storedChange(was, item) : 'other';
      if (change === 'other') {
        if (was) next.set(item.id, was);
        cancelCursorSave(item.id);
        save(item);
      } else if (change === 'cursors' && was) {
        next.set(item.id, was);
        cancelCursorSave(item.id);
        const id = item.id;
        cursorSaves.current.set(
          id,
          window.setTimeout(() => {
            cursorSaves.current.delete(id);
            const latest = itemsRef.current.find((i) => i.id === id);
            if (latest && storeRef.current === store && persisted.current.has(id)) save(latest);
          }, CURSOR_SAVE_DELAY),
        );
      } else {
        next.set(item.id, item);
        if (was && was.lastUsed !== item.lastUsed) void store.updateMeta(item.id, { lastUsed: item.lastUsed });
      }
    }
    for (const id of prev.keys()) {
      if (!next.has(id)) {
        cancelCursorSave(id);
        void store.remove(id);
      }
    }
    persisted.current = next;
  }, [items, keepHistory, historyReady]);

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
    setOverlay(false);
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
      patchItem(id, patch);
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
          if (recomputeReq.current.get(key) === req) setSession(key, { result: r, error: null });
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
          if (latest.gate !== gate || latest.points !== points) recompute(key, r, latest.gate, latest.points);
          const cache = new Map<string, ExtractionResult>();
          for (const p of r.points) {
            const itemId = pointItems[p.id];
            if (itemId) cache.set(itemId, p.extraction);
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
    },
    [openItem],
  );

  const clearAll = (): void => {
    singleReq.current.clear();
    bodeReq.current.clear();
    recomputeReq.current.clear();
    sessionsRef.current = {};
    replaceIdRef.current = null;
    persisted.current = new Map();
    for (const timer of cursorSaves.current.values()) window.clearTimeout(timer);
    cursorSaves.current.clear();
    void storeRef.current?.clear();
    setItems([]);
    setSelected([]);
    setActiveId(null);
    setSessions({});
    setNotice(null);
    setCropDismissed(new Set());
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
      const images = raw
        .filter(isImageFile)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, HISTORY_LIMIT);
      if (images.length === 0) {
        if (raw.length > 0) setNotice(tx.unsupportedFile);
        return;
      }
      setAdding(true);
      setNotice(null);
      const added: HistoryItem[] = [];
      try {
        const now = Date.now();
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
            isPhoto: photo,
          });
        }
        const replaceId = replaceIdRef.current;
        replaceIdRef.current = null;
        if (replaceId) singleReq.current.delete(replaceId);
        const keep = new Set(added.map((i) => i.id));
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
      } catch (e) {
        releaseItems(added);
        setNotice(message(e));
      } finally {
        setAdding(false);
      }
    },
    [tx.unsupportedFile],
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
  const cursorsShown = cursorsOn && mode === 'single' && view === 'clean' && !cropVisible && Boolean(activeItem?.result);
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

  const toggleOverlay = useCallback(() => {
    setOverlay((o) => {
      if (!o) setView('original');
      return !o;
    });
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
    setOverlay(false);
    setCropOpen(false);
    setForceQuad(false);
    setCursorsOn(true);
  }, [cursorsShown, cropVisible]);

  const extractActive = useCallback(() => {
    const item = itemsRef.current.find((i) => i.id === activeRef.current);
    if (item) runSingle(item, true);
  }, [runSingle]);

  const exportSource: ExportSource | null = useMemo(() => {
    if (showCapture && capture) {
      const labels = captureLabels;
      const svgCursors = cursors ?? undefined;
      return {
        baseName: baseName(captureTitle),
        svg: () =>
          renderWaveformSvg(capture, {
            locale,
            title: captureTitle,
            ...(labels ? { channelLabels: labels } : {}),
            ...(svgCursors ? { cursors: svgCursors } : {}),
          }),
        csv: () => renderWaveformCsv(capture, labels),
        table: (f) => renderMeasurementsTable(capture, f, locale, labels, captureTitle),
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
  }, [showCapture, capture, captureName, captureTitle, captureLabels, cursors, mode, bode, locale]);

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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, openPicker, showCapture, capture, toggleOverlay, toggleCursors, mode, exportSource, copyPlot, cropVisible]);

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

  const onDrop = async (e: React.DragEvent) => {
    setDragging(false);
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    replaceIdRef.current = null;
    const list = await filesFromDataTransfer(e.dataTransfer);
    await addFiles(list, 'pick');
  };

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

  const titleField: TitleField | null =
    mode === 'single' && activeItem
      ? {
          value: activeItem.title ?? '',
          placeholder: activeItem.name,
          onCommit: (v) => updateMeta(activeItem.id, { title: v || undefined }),
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
          <EmptyState tx={tx} onAdd={() => openPicker(false)} onCamera={canUseCamera ? () => openCamera() : undefined} />
        )}
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
                    setOverlay(false);
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
            dark={dark}
            url={captureItem.url}
            fileName={captureName}
            title={captureTitle}
            channelLabels={captureLabels}
            result={capture}
            extracting={mode === 'single' && activeItem?.state === 'extracting'}
            view={view}
            overlay={overlay}
            cropOpen={cropVisible}
            canCrop={mode === 'single'}
            isPhoto={captureItem.isPhoto === true}
            forceQuad={forceQuad}
            overrides={mode === 'single' ? activeItem?.overrides ?? {} : {}}
            cursors={cursors}
            onExtract={mode === 'single' && !quality ? extractActive : null}
            onView={(v) => {
              if (v === 'clean' && cropVisible) dismissCrop(false);
              setView(v);
              if (v === 'clean') setOverlay(false);
            }}
            onOverlay={toggleOverlay}
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
            <button
              type="button"
              className="btn primary"
              disabled={session?.state === 'extracting'}
              onClick={() => runBode(bodeKey, selectedItems, sessionProfile)}
            >
              {session?.state === 'extracting' ? tx.working : tx.extractBode(selectedItems.length)}
            </button>
          </div>
        )}

        {mode === 'bode' && bodeKey && session && bode && !inspected && (
          <BodeView
            tx={tx}
            locale={locale}
            dark={dark}
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
              labels={activeItem?.channelLabels}
              onOverrides={(next) => activeItem && updateItem(activeItem.id, { overrides: next })}
              onLabel={activeItem ? setLabel : undefined}
            />
          )}
          {(mode !== 'bode' || inspected) && <MeasurementsPanel tx={tx} locale={locale} result={capture} labels={captureLabels} />}
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
            let job: Promise<void>;
            try {
              job = f === 'html' ? copyRich(src.table('html'), src.table('tsv')) : copyPlain(src.table(f));
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
