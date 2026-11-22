import type { ExtractionOverrides, ExtractionResult } from '../core/types';
import type { PhotoQualityReport } from '../core/photoQuality';
import type { ProfileChoice } from './components/Controls';
import { makeUrl, releaseUrl } from './files';

export type ItemState = 'staged' | 'extracting' | 'extracted' | 'error';

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
}

export interface HistoryStore {
  readonly persistent: boolean;
  loadAll(): Promise<HistoryItem[]>;
  put(item: HistoryItem): Promise<void>;
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

export function capHistory(items: readonly HistoryItem[], keep: ReadonlySet<string>): HistoryItem[] {
  if (items.length <= HISTORY_LIMIT) return [...items];
  const drop = new Set(
    [...items]
      .filter((i) => !keep.has(i.id))
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, items.length - HISTORY_LIMIT)
      .map((i) => i.id),
  );
  releaseItems(items.filter((i) => drop.has(i.id)));
  return items.filter((i) => !drop.has(i.id));
}

function toStored(item: HistoryItem): StoredItem {
  return {
    id: item.id,
    name: item.name,
    bytes: item.bytes,
    addedAt: item.addedAt,
    lastUsed: item.lastUsed,
    result: item.state === 'error' ? null : item.result,
    overrides: item.overrides,
    profile: item.profile,
  };
}

function fromStored(s: StoredItem): HistoryItem {
  return {
    id: s.id,
    name: s.name,
    bytes: s.bytes,
    url: makeUrl(s.bytes),
    addedAt: s.addedAt,
    lastUsed: s.lastUsed,
    state: s.result ? 'extracted' : 'staged',
    result: s.result,
    error: null,
    overrides: s.overrides ?? {},
    profile: s.profile ?? 'auto',
    quality: null,
  };
}

function memoryStore(): HistoryStore {
  const map = new Map<string, StoredItem>();
  return {
    persistent: false,
    loadAll: async () => [...map.values()].map(fromStored),
    put: async (item) => {
      map.set(item.id, toStored(item));
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

function idbStore(db: IDBDatabase): HistoryStore {
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  const safe = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      /* quota or private mode, the session keeps working in memory */
    }
  };
  return {
    persistent: true,
    loadAll: async () => {
      const all = await request(tx('readonly').getAll() as IDBRequest<StoredItem[]>);
      const sorted = [...all].sort((a, b) => b.lastUsed - a.lastUsed);
      const extra = sorted.slice(HISTORY_LIMIT);
      if (extra.length) {
        const store = tx('readwrite');
        for (const e of extra) store.delete(e.id);
      }
      return sorted.slice(0, HISTORY_LIMIT).map(fromStored);
    },
    put: (item) => safe(() => request(tx('readwrite').put(toStored(item)))),
    remove: (id) => safe(() => request(tx('readwrite').delete(id))),
    clear: () => safe(() => request(tx('readwrite').clear())),
  };
}

export async function openHistory(): Promise<HistoryStore> {
  if (typeof indexedDB === 'undefined') return memoryStore();
  try {
    return idbStore(await openDb());
  } catch {
    return memoryStore();
  }
}
