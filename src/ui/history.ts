import type { ChannelId, ExtractionOverrides, ExtractionResult, PlotCursors } from '../core/types';
import type { PhotoQualityReport } from '../core/photoQuality';
import type { ProfileChoice } from './components/Controls';
import { makeUrl, newId, releaseUrl } from './files';

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
  /** When these cursors were last moved, from `nextRev`. Newer cursors on disk always win over older ones. */
  readonly cursorsAt?: number;
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
  readonly cursorsAt?: number;
}

export interface MetaUpdate {
  readonly lastUsed: number;
}

export interface PutResult {
  /** True once the write is committed. */
  readonly ok: boolean;
  /** Older records deleted to make room. Only set when the write committed with them. */
  readonly evicted: readonly string[];
}

export interface HistoryStore {
  readonly persistent: boolean;
  loadAll(): Promise<HistoryItem[]>;
  /** Records in `protectedIds` are never deleted to make room for this one. */
  put(item: HistoryItem, protectedIds?: ReadonlySet<string>): Promise<PutResult>;
  /** Updates small fields without the caller rebuilding the whole record. */
  updateMeta(id: string, patch: MetaUpdate): Promise<boolean>;
  /**
   * Changes only the cursors of a saved capture, so a newer title from another tab is kept and a
   * capture deleted in another tab never comes back. Set `urgent` during pagehide to write before
   * the tab closes. `rev` is when the cursors moved. Resolves true once committed or when newer
   * cursors, from this tab or another one, are already on disk, and false if the write failed or
   * the capture is gone.
   */
  updateCursors(id: string, cursors: PlotCursors | null, urgent?: boolean, rev?: number): Promise<boolean>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const HISTORY_LIMIT = 50;
const DB_NAME = 'graticule-history';
const STORE = 'items';
/**
 * A cursor move saved as the tab closes goes into its own small record next to the capture, since
 * there is no time left to read the capture and write it back. Each move gets its own key, with its
 * revision in it, so an older move written late never overwrites a newer one from another tab. The
 * newest one is applied on load only while the capture still exists, and any later full save of the
 * capture replaces them all. Older versions wrote one `cursors:<id>` record, which is still read.
 */
const CURSOR_PREFIX = 'cursors:';
const cursorKey = (id: string, rev: number): string =>
  `${CURSOR_PREFIX}${id}:${String(Math.max(0, Math.floor(rev))).padStart(16, '0')}:${newId()}`;

let lastRev = 0;
/** A cursor revision: the time, but always above the last one handed out in this tab. */
export const nextRev = (): number => (lastRev = Math.max(Date.now(), lastRev + 1));

interface CursorRecord {
  readonly id: string;
  /** The capture these cursors belong to. Missing on the older `cursors:<id>` records. */
  readonly itemId?: string;
  readonly cursors: PlotCursors | null;
  readonly updatedAt?: number;
}

const revOf = (v: { readonly cursorsAt?: unknown } | undefined): number => (isFiniteNumber(v?.cursorsAt) ? v.cursorsAt : 0);
const sideRev = (v: CursorRecord | undefined): number => (isFiniteNumber(v?.updatedAt) ? v.updatedAt : 0);

function isCursorRecord(v: unknown): v is CursorRecord {
  return isRecord(v) && typeof v.id === 'string' && v.id.startsWith(CURSOR_PREFIX);
}

const sideItemId = (side: CursorRecord): string =>
  typeof side.itemId === 'string' ? side.itemId : side.id.slice(CURSOR_PREFIX.length);

/** The newest of some cursor records, by revision, then by key so every tab picks the same one. */
function newestSide(sides: readonly CursorRecord[]): CursorRecord | undefined {
  let best: CursorRecord | undefined;
  for (const s of sides) if (!best || sideRev(s) > sideRev(best) || (sideRev(s) === sideRev(best) && s.id > best.id)) best = s;
  return best;
}

/** The newest cursors on disk for a capture, from its own record or its cursor records. */
function newestCursors(item: StoredItem | undefined, sides: readonly CursorRecord[]): { cursors: PlotCursors | null; rev: number } {
  const side = newestSide(sides);
  if (side && sideRev(side) >= revOf(item)) return { cursors: validCursors(side.cursors), rev: sideRev(side) };
  return { cursors: validCursors(item?.cursors), rev: revOf(item) };
}

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
    ...(item.cursorsAt ? { cursorsAt: item.cursorsAt } : {}),
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
    ...(revOf(s) > 0 ? { cursorsAt: revOf(s) } : {}),
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

function withCursors(record: StoredItem, cursors: PlotCursors | null, rev?: number): StoredItem {
  const { cursors: _old, cursorsAt: oldRev, ...rest } = record;
  const at = rev ?? oldRev;
  return { ...rest, ...(cursors ? { cursors } : {}), ...(at ? { cursorsAt: at } : {}) };
}

function memoryStore(): HistoryStore {
  const map = new Map<string, StoredItem>();
  return {
    persistent: false,
    loadAll: async () => loadValid([...map.values()]),
    put: async (item) => {
      map.set(item.id, toStored(item));
      return { ok: true, evicted: [] };
    },
    updateMeta: async (id, patch) => {
      const prev = map.get(id);
      if (!prev) return false;
      map.set(id, { ...prev, ...patch });
      return true;
    },
    updateCursors: async (id, cursors, _urgent, rev = nextRev()) => {
      const prev = map.get(id);
      if (!prev) return false;
      if (revOf(prev) <= rev) map.set(id, withCursors(prev, cursors, rev));
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
    req.onsuccess = () => {
      const db = req.result;
      // Lets a newer version of the app in another tab upgrade the database instead of being blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
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
    let t: IDBTransaction | undefined;
    try {
      t = db.transaction(STORE, mode);
      work(t.objectStore(STORE));
      // Commits right away so a write started as the page closes is not lost.
      if (now && typeof t.commit === 'function') t.commit();
    } catch (e) {
      // Without this, deletes queued before the error would still commit on their own.
      try {
        t?.abort();
      } catch {
        /* already finished */
      }
      reject(e);
      return;
    }
    const done = t;
    done.oncomplete = () => resolve();
    done.onabort = () => reject(done.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Starts the reads from `read`, then lets `decide` write once they are all back, all in one
 * transaction, and resolves once it commits, so nothing can change those records between the read
 * and the write.
 */
function readThenWrite(
  db: IDBDatabase,
  read: (store: IDBObjectStore) => readonly IDBRequest[],
  decide: (store: IDBObjectStore, found: unknown[]) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let t: IDBTransaction | undefined;
    const fail = (e: unknown): void => {
      try {
        t?.abort();
      } catch {
        /* already finished */
      }
      reject(e);
    };
    try {
      const live = db.transaction(STORE, 'readwrite');
      t = live;
      const store = live.objectStore(STORE);
      const reqs = read(store);
      const run = (): void => {
        try {
          decide(store, reqs.map((r) => r.result));
          if (typeof live.commit === 'function') live.commit();
        } catch (e) {
          fail(e);
        }
      };
      live.oncomplete = () => resolve();
      live.onabort = () => reject(live.error ?? new Error('IndexedDB transaction aborted'));
      // Requests in one transaction finish in order, so the last one back means all are back.
      const last = reqs[reqs.length - 1];
      if (last) last.onsuccess = run;
      else run();
    } catch (e) {
      fail(e);
    }
  });
}

/** Asks for every cursor record that may belong to `id`. `sidesFor` keeps only the ones that do. */
function readSides(store: IDBObjectStore, id: string): IDBRequest {
  return store.getAll(IDBKeyRange.bound(CURSOR_PREFIX + id, `${CURSOR_PREFIX}${id}:￿`));
}

/** The range also covers ids that start with `id`, like `id2`, so those are left out here. */
function sidesFor(found: unknown, id: string): CursorRecord[] {
  return Array.isArray(found) ? found.filter((r): r is CursorRecord => isCursorRecord(r) && sideItemId(r) === id) : [];
}

/** Reads one capture and all its cursor records, then lets `decide` write, in one transaction. */
function readItem(
  db: IDBDatabase,
  id: string,
  decide: (store: IDBObjectStore, item: StoredItem | undefined, sides: CursorRecord[]) => void,
): Promise<void> {
  return readThenWrite(
    db,
    (store) => [store.get(id), readSides(store, id)],
    (store, [item, sides]) => decide(store, validStored(item) ? item : undefined, sidesFor(sides, id)),
  );
}

/** Records that may be deleted to make room, least recently used first, never the one being written. */
export function evictionOrder(records: readonly unknown[], keepId: string, protectedIds: ReadonlySet<string>): StoredItem[] {
  return records
    .filter(validStored)
    .filter((r) => r.id !== keepId && !protectedIds.has(r.id))
    .sort((a, b) => a.lastUsed - b.lastUsed);
}

/**
 * Holds one lock shared by every tab while the work runs, so another tab never saves a capture
 * between this tab deleting it to make room and writing it back. Runs without it where the
 * browser has no Web Locks or refuses them, like some file:// pages.
 */
async function withHistoryLock<T>(run: () => Promise<T>): Promise<T> {
  let locks: LockManager | undefined;
  try {
    locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  } catch {
    locks = undefined;
  }
  if (!locks || typeof locks.request !== 'function') return run();
  let started = false;
  try {
    return await locks.request(DB_NAME, () => {
      started = true;
      return run();
    });
  } catch (e) {
    if (started) throw e;
    return run();
  }
}

/** Exported for tests. Every write runs one after another, in this tab and across tabs, so two saves never race for the same room. */
export function idbStore(db: IDBDatabase): HistoryStore {
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = () => withHistoryLock(work);
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const safe = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch {
      /* quota or private mode, the session keeps working in memory */
    }
  };
  const failed: PutResult = { ok: false, evicted: [] };
  const storageUsage = async (): Promise<number | null> => {
    try {
      const est = await navigator.storage?.estimate?.();
      return typeof est?.usage === 'number' && Number.isFinite(est.usage) ? est.usage : null;
    } catch {
      return null;
    }
  };
  /**
   * Chromium only gives quota back once a delete has committed, so a delete and a put in one
   * transaction never makes room. Old records are deleted in their own transaction, one at a time,
   * until the new one fits. If it never fits, every deleted record is written back.
   */
  const put = async (item: HistoryItem, protectedIds: ReadonlySet<string>): Promise<PutResult> => {
    const record = toStored(item);
    // Cursors on disk that moved after this copy's cursors, maybe in another tab or in a pagehide
    // save, are kept, so a rename or any other full save never puts older cursors back. The record
    // then holds the newest cursors, so the cursor record goes in the same transaction.
    const write = (): Promise<void> =>
      readItem(db, record.id, (store, onDisk, sides) => {
        const disk = newestCursors(onDisk, sides);
        store.put(disk.rev > revOf(record) ? withCursors(record, disk.cursors, disk.rev) : record);
        for (const side of sides) store.delete(side.id);
      });
    const usageBefore = await storageUsage();
    try {
      await write();
      return { ok: true, evicted: [] };
    } catch (e) {
      if (!isQuota(e)) return failed;
    }
    // If Chromium kept an aborted large blob counted in origin usage, deleting older records
    // would risk a failed rollback, so leave the existing history untouched.
    const usageAfter = await storageUsage();
    if (usageBefore !== null && usageAfter !== null && usageAfter - usageBefore >= Math.floor(record.bytes.length * 0.5)) {
      return failed;
    }
    let candidates: StoredItem[];
    try {
      candidates = evictionOrder(await request(tx('readonly').getAll() as IDBRequest<unknown[]>), record.id, protectedIds);
    } catch {
      return failed;
    }
    // A victim's cursor records go with it, so their room is freed too and they never outlive it.
    // The victim and its cursor records are read again in the transaction that deletes them, so a
    // rollback puts back what was really on disk, even if another tab changed it since the listing.
    const deleted: Array<{ victim: StoredItem; sides: CursorRecord[] }> = [];
    for (const candidate of candidates) {
      const snap: { victim?: StoredItem; sides: CursorRecord[] } = { sides: [] };
      try {
        await readItem(db, candidate.id, (store, victim, sides) => {
          snap.victim = victim;
          snap.sides = sides;
          if (victim) store.delete(victim.id);
          for (const side of sides) store.delete(side.id);
        });
      } catch {
        break;
      }
      // Already deleted by another tab, so there is nothing to put back.
      if (!snap.victim) continue;
      deleted.push({ victim: snap.victim, sides: snap.sides });
      try {
        await write();
        return { ok: true, evicted: deleted.map((d) => d.victim.id) };
      } catch (e) {
        if (!isQuota(e)) break;
      }
    }
    const notRestored: string[] = [];
    if (deleted.length) {
      // Restore one record per transaction, newest first: a single batch put of every deleted
      // record can exceed a tight Chromium LevelDB quota even when each record fits on its own.
      // A capture saved again meanwhile by another tab is newer and is kept. So is any cursor record
      // written meanwhile, maybe by a pagehide in another tab, since it has its own key.
      for (const { victim, sides } of [...deleted].reverse()) {
        let restored = false;
        for (const waitMs of [0, 25, 75]) {
          if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
          try {
            await readItem(db, victim.id, (store, now, sidesNow) => {
              if (!now) store.put(victim);
              const floor = now ? revOf(now) : -1;
              const present = new Set(sidesNow.map((side) => side.id));
              for (const side of sides) if (!present.has(side.id) && sideRev(side) > floor) store.put(side);
            });
            restored = true;
            break;
          } catch (e) {
            if (!isQuota(e)) break;
          }
        }
        if (!restored) notRestored.push(victim.id);
      }
    }
    return { ok: false, evicted: notRestored };
  };
  /**
   * Reads the saved capture and its cursor record, then writes the capture back with new cursors, in
   * one transaction. Does nothing if the capture is gone or newer cursors are already on disk.
   */
  const patchCursors = async (id: string, cursors: PlotCursors | null, rev: number): Promise<boolean> => {
    let found = false;
    try {
      await readItem(db, id, (store, item, sides) => {
        if (!item) return;
        found = true;
        const disk = newestCursors(item, sides);
        if (disk.rev > rev && !sides.length) return;
        // A newer move on disk wins. It is folded into the capture so its cursor records can go.
        store.put(disk.rev > rev ? withCursors(item, disk.cursors, disk.rev) : withCursors(item, cursors, rev));
        for (const side of sides) store.delete(side.id);
      });
      return found;
    } catch {
      return false;
    }
  };
  const update = async (work: (store: IDBObjectStore) => void): Promise<boolean> => {
    try {
      await commit(db, 'readwrite', work);
      return true;
    } catch {
      return false;
    }
  };
  return {
    persistent: true,
    loadAll: () =>
      serial(async () => {
        const all = await request(tx('readonly').getAll() as IDBRequest<unknown[]>);
        const late = new Map<string, CursorRecord[]>();
        for (const r of all) {
          if (!isCursorRecord(r)) continue;
          const id = sideItemId(r);
          late.set(id, [...(late.get(id) ?? []), r]);
        }
        const valid = all.filter(validStored).sort((a, b) => b.lastUsed - a.lastUsed);
        const kept = valid.slice(0, HISTORY_LIMIT);
        const extra = valid.slice(HISTORY_LIMIT);
        const keptById = new Map(kept.map((r) => [r.id, r]));
        // Cursors whose capture was deleted, maybe in another tab, are dropped and never bring it back.
        // So are cursors older than the ones the capture already holds, and older moves of the same capture.
        const isStale = (side: CursorRecord, capture: StoredItem | undefined, sides: readonly CursorRecord[]): boolean =>
          !capture || sideRev(side) < revOf(capture) || newestSide(sides) !== side;
        const staleIds = [...late]
          .filter(([id, sides]) => sides.some((side) => isStale(side, keptById.get(id), sides)))
          .map(([id]) => id);
        if (extra.length || staleIds.length) {
          // Re-read the live records inside the cleanup transaction so neither a newly opened
          // capture nor a newly restored capture/cursor record is deleted by a stale listing.
          await safe(() =>
            readThenWrite(
              db,
              (store) => [store.getAll()],
              (store, [liveAll]) => {
                const records = Array.isArray(liveAll) ? liveAll : [];
                const liveValid = records.filter(validStored).sort((a, b) => b.lastUsed - a.lastUsed);
                const liveExtra = liveValid.slice(HISTORY_LIMIT);
                const liveKeptById = new Map(liveValid.slice(0, HISTORY_LIMIT).map((r) => [r.id, r]));
                const liveSidesById = new Map<string, CursorRecord[]>();
                for (const r of records) {
                  if (!isCursorRecord(r)) continue;
                  const id = sideItemId(r);
                  liveSidesById.set(id, [...(liveSidesById.get(id) ?? []), r]);
                }
                for (const e of liveExtra) {
                  store.delete(e.id);
                  for (const side of liveSidesById.get(e.id) ?? []) store.delete(side.id);
                }
                for (const id of staleIds) {
                  const captureNow = liveKeptById.get(id);
                  const sidesNow = liveSidesById.get(id) ?? [];
                  const seen = late.get(id) ?? [];
                  for (const side of sidesNow) {
                    const unchanged = seen.some((s) => s.id === side.id && sideRev(s) === sideRev(side));
                    if (unchanged && isStale(side, captureNow, sidesNow)) store.delete(side.id);
                  }
                }
              },
            ),
          );
        }
        return loadValid(kept.map((r) => {
          const side = newestSide(late.get(r.id) ?? []);
          if (!side || sideRev(side) < revOf(r)) return r;
          return withCursors(r, validCursors(side.cursors), sideRev(side) || undefined);
        }));
      }),
    put: (item, protectedIds = new Set()) => serial(() => put(item, protectedIds)),
    updateMeta: (id, patch) =>
      serial(() =>
        update((store) => {
          const req = store.get(id);
          req.onsuccess = () => {
            if (validStored(req.result)) store.put({ ...req.result, ...patch });
          };
        }),
      ),
    updateCursors: (id, cursors, urgent = false, rev = nextRev()) => {
      // Which save wins is decided by the revisions on disk, so it also holds across tabs, and an
      // urgent save that failed never stops a queued one from landing.
      if (!urgent) return serial(() => patchCursors(id, cursors, rev));
      // During pagehide the tab closes right after the handler returns, before a read could come back,
      // so one blind write of the cursor record starts and commits now, before any queue or Web Lock.
      // It touches nothing else in the capture and never waits on `serial`, so it cannot deadlock.
      const prev = queue;
      const record: CursorRecord = { id: cursorKey(id, rev), itemId: id, cursors, updatedAt: rev };
      const direct = commit(db, 'readwrite', (store) => store.put(record), true).then(() => true, () => false);
      queue = prev.then(() => direct, () => direct).catch(() => undefined);
      return direct;
    },
    remove: (id) =>
      serial(() =>
        safe(() =>
          readItem(db, id, (store, _item, sides) => {
            store.delete(id);
            for (const side of sides) store.delete(side.id);
          }),
        ),
      ),
    clear: () => serial(() => safe(() => commit(db, 'readwrite', (store) => store.clear(), true))),
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
