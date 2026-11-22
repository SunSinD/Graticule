import type { ChannelId, ExtractionOverrides, ExtractionResult, PlotCursors } from '../core/types';
import type { PhotoQualityReport } from '../core/photoQuality';
import type { ProfileChoice } from './components/Controls';
import { makeUrl, releaseUrl } from './files';

export type ItemState = 'staged' | 'extracting' | 'extracted' | 'error';
export type ChannelLabels = Partial<Record<ChannelId, string>>;

export interface HistoryItem {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly url: string;
  readonly addedAt: number;
  readonly lastUsed: number;
  readonly state: ItemState;
  readonly result: ExtractionResult | null;
  readonly error: string | null;
  readonly overrides: ExtractionOverrides;
  readonly profile: ProfileChoice;
  readonly quality: PhotoQualityReport | null;
  readonly isPhoto?: boolean;
  readonly title?: string;
  readonly channelLabels?: ChannelLabels;
  readonly cursors?: PlotCursors | null;
}

interface StoredItem {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly addedAt: number;
  readonly lastUsed: number;
  readonly result: ExtractionResult | null;
  readonly overrides: ExtractionOverrides;
  readonly profile: ProfileChoice;
  readonly isPhoto?: boolean;
  readonly quality?: PhotoQualityReport | null;
  readonly title?: string;
  readonly channelLabels?: ChannelLabels;
  readonly cursors?: PlotCursors | null;
}

export interface MetaUpdate {
  readonly lastUsed: number;
}

export interface HistoryStore {
  readonly persistent: boolean;
  loadAll(): Promise<HistoryItem[]>;
  /** Resolves true once the write is committed. */
  put(item: HistoryItem): Promise<boolean>;
  /** Updates small fields without the caller rebuilding the whole record. */
  updateMeta(id: string, patch: MetaUpdate): Promise<boolean>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const HISTORY_LIMIT = 50;
const DB_NAME = 'graticule-history';
const STORE = 'items';

export function compareItems(a: HistoryItem, b: HistoryItem): number {
  return b.addedAt - a.addedAt || a.name.localeCompare(b.name, undefined, { numeric: true });
}

export function releaseItems(items: readonly HistoryItem[]): void {
  for (const item of items) releaseUrl(item.url);
}

/** Pure: never revokes anything. Items in `keep` are dropped last, newest names first. */
export function capHistory(items: readonly HistoryItem[], keep: ReadonlySet<string>): HistoryItem[] {
  if (items.length <= HISTORY_LIMIT) return [...items];
  const index = new Map(items.map((item, i) => [item.id, i]));
  const order = [...items].sort((a, b) => {
    const ka = keep.has(a.id) ? 1 : 0;
    const kb = keep.has(b.id) ? 1 : 0;
    if (ka !== kb) return ka - kb;
    if (ka === 1) return index.get(b.id)! - index.get(a.id)!;
    return a.lastUsed - b.lastUsed;
  });
  const drop = new Set(order.slice(0, items.length - HISTORY_LIMIT).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}

/** An extracting item may hold a result from before its new overrides, so it is never saved with them. */
function storedResult(item: HistoryItem): ExtractionResult | null {
  return item.state === 'error' || item.state === 'extracting' ? null : item.result;
}

/**
 * Compares only what is saved to disk. `lastUsed` and the extracting state are left out on purpose,
 * so opening an item or starting an extraction never rewrites the image bytes.
 */
export function storedChange(a: HistoryItem, b: HistoryItem): 'none' | 'cursors' | 'other' {
  const same =
    a.name === b.name &&
    a.bytes === b.bytes &&
    a.addedAt === b.addedAt &&
    storedResult(a) === storedResult(b) &&
    a.overrides === b.overrides &&
    a.profile === b.profile &&
    a.quality === b.quality &&
    a.isPhoto === b.isPhoto &&
    a.title === b.title &&
    a.channelLabels === b.channelLabels;
  if (!same) return 'other';
  return a.cursors === b.cursors ? 'none' : 'cursors';
}

function toStored(item: HistoryItem): StoredItem {
  return {
    id: item.id,
    name: item.name,
    bytes: item.bytes,
    addedAt: item.addedAt,
    lastUsed: item.lastUsed,
    result: storedResult(item),
    overrides: item.overrides,
    profile: item.profile,
    isPhoto: item.isPhoto ?? false,
    quality: item.quality,
    ...(item.title ? { title: item.title } : {}),
    ...(item.channelLabels ? { channelLabels: item.channelLabels } : {}),
    ...(item.cursors ? { cursors: item.cursors } : {}),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function validStored(v: unknown): v is StoredItem {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    v.bytes instanceof Uint8Array &&
    v.bytes.length > 0 &&
    typeof v.addedAt === 'number' &&
    Number.isFinite(v.addedAt) &&
    typeof v.lastUsed === 'number' &&
    Number.isFinite(v.lastUsed)
  );
}

function validResult(v: unknown): ExtractionResult | null {
  if (!isRecord(v)) return null;
  if (!Array.isArray(v.traces) || !Array.isArray(v.measurements) || !Array.isArray(v.comparisons)) return null;
  if (!isRecord(v.detection) || !isRecord(v.timebase)) return null;
  const { warnings, grid } = v.detection;
  if (!Array.isArray(warnings) || !isRecord(grid)) return null;
  if (!isFiniteNumber(grid.hDivs) || !isFiniteNumber(grid.vDivs)) return null;
  return v as unknown as ExtractionResult;
}

function validCursors(v: unknown): PlotCursors | null {
  if (!isRecord(v)) return null;
  const nums = [v.x1, v.x2, v.y1, v.y2];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  if (typeof v.channel !== 'string' || !/^C[1-4]$/.test(v.channel)) return null;
  return v as unknown as PlotCursors;
}

function validLabels(v: unknown): ChannelLabels | undefined {
  if (!isRecord(v)) return undefined;
  const out: ChannelLabels = {};
  for (const ch of ['C1', 'C2', 'C3', 'C4'] as const) {
    const label = v[ch];
    if (typeof label === 'string' && label.trim()) out[ch] = label;
  }
  return Object.keys(out).length ? out : undefined;
}

function fromStored(s: StoredItem): HistoryItem {
  const result = validResult(s.result);
  const quality = isRecord(s.quality) && Array.isArray((s.quality as { issues?: unknown }).issues) ? s.quality : null;
  const labels = validLabels(s.channelLabels);
  const cursors = validCursors(s.cursors);
  return {
    id: s.id,
    name: s.name,
    bytes: s.bytes,
    url: makeUrl(s.bytes),
    addedAt: s.addedAt,
    lastUsed: s.lastUsed,
    state: result ? 'extracted' : 'staged',
    result,
    error: null,
    overrides: isRecord(s.overrides) ? s.overrides : {},
    profile: typeof s.profile === 'string' ? s.profile : 'auto',
    quality,
    isPhoto: s.isPhoto === true,
    ...(typeof s.title === 'string' && s.title.trim() ? { title: s.title } : {}),
    ...(labels ? { channelLabels: labels } : {}),
    ...(cursors ? { cursors } : {}),
  };
}

function loadValid(records: readonly unknown[]): HistoryItem[] {
  const valid = records.filter(validStored).sort((a, b) => b.lastUsed - a.lastUsed);
  const out: HistoryItem[] = [];
  for (const s of valid.slice(0, HISTORY_LIMIT)) {
    try {
      out.push(fromStored(s));
    } catch {
      /* skip a record that cannot be restored */
    }
  }
  return out;
}

function memoryStore(): HistoryStore {
  const map = new Map<string, StoredItem>();
  return {
    persistent: false,
    loadAll: async () => loadValid([...map.values()]),
    put: async (item) => {
      map.set(item.id, toStored(item));
      return true;
    },
    updateMeta: async (id, patch) => {
      const prev = map.get(id);
      if (!prev) return false;
      map.set(id, { ...prev, ...patch });
      return true;
    },
    remove: async (id) => {
      map.delete(id);
    },
    clear: async () => {
      map.clear();
    },
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is not available'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

function isQuota(e: unknown): boolean {
  if (!isRecord(e)) return false;
  return e.name === 'QuotaExceededError' || e.code === 22 || e.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Runs the work in one transaction and resolves only after it commits. */
function commit(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => void, now = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let t: IDBTransaction;
    try {
      t = db.transaction(STORE, mode);
      work(t.objectStore(STORE));
      // Commits right away so a write started as the page closes is not lost.
      if (now && typeof t.commit === 'function') t.commit();
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function idbStore(db: IDBDatabase): HistoryStore {
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  const safe = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      /* quota or private mode, the session keeps working in memory */
    }
  };
  /** Frees room by deleting the least recently used records, never the one being written. */
  const evictOldest = async (keepId: string): Promise<boolean> => {
    const all = (await request(tx('readonly').getAll() as IDBRequest<unknown[]>)).filter(validStored);
    const victims = all
      .filter((r) => r.id !== keepId)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, Math.max(1, Math.ceil(all.length / 4)));
    if (victims.length === 0) return false;
    await commit(db, 'readwrite', (store) => {
      for (const v of victims) store.delete(v.id);
    });
    return true;
  };
  const write = async (id: string, work: (store: IDBObjectStore) => void, now = false): Promise<boolean> => {
    try {
      await commit(db, 'readwrite', work, now);
      return true;
    } catch (e) {
      if (!isQuota(e)) return false;
    }
    try {
      if (!(await evictOldest(id))) return false;
      await commit(db, 'readwrite', work, now);
      return true;
    } catch {
      return false;
    }
  };
  return {
    persistent: true,
    loadAll: async () => {
      const all = await request(tx('readonly').getAll() as IDBRequest<unknown[]>);
      const valid = all.filter(validStored).sort((a, b) => b.lastUsed - a.lastUsed);
      const extra = valid.slice(HISTORY_LIMIT);
      if (extra.length) {
        await safe(async () => {
          const store = tx('readwrite');
          await Promise.all(extra.map((e) => request(store.delete(e.id))));
        });
      }
      return loadValid(valid);
    },
    put: (item) => {
      const record = toStored(item);
      return write(item.id, (store) => store.put(record), true);
    },
    updateMeta: (id, patch) =>
      write(id, (store) => {
        const req = store.get(id);
        req.onsuccess = () => {
          if (validStored(req.result)) store.put({ ...req.result, ...patch });
        };
      }),
    remove: (id) => safe(() => request(tx('readwrite').delete(id))),
    clear: () => safe(() => request(tx('readwrite').clear())),
  };
}

export async function openHistory(): Promise<HistoryStore> {
  try {
    // Reading indexedDB itself can throw in sandboxed frames and some private modes.
    if (typeof indexedDB === 'undefined' || !indexedDB) return memoryStore();
    return idbStore(await openDb());
  } catch {
    return memoryStore();
  }
}
