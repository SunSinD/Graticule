import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PlotCursors } from '../../src/core/types.js';
import { evictionOrder, idbStore, nextRev, type HistoryItem } from '../../src/ui/history.js';

/**
 * A small IndexedDB stand in. Transactions run one at a time in the order they were created,
 * changes land only on commit, and a commit over the byte quota aborts with QuotaExceededError.
 * With `chromium` set, it charges quota like Chromium: every put adds its full size on top of what
 * is already committed, and a delete gives its room back only after its own transaction commits.
 */
type FakeRecord = { id: string; bytes?: Uint8Array };
type FakeRange = { lower: string; upper: string };
if (typeof globalThis.IDBKeyRange === 'undefined') {
  (globalThis as unknown as { IDBKeyRange: unknown }).IDBKeyRange = { bound: (lower: string, upper: string): FakeRange => ({ lower, upper }) };
}
// A record without bytes, like a cursor record, still takes a little room.
const recordSize = (r: FakeRecord): number => r.bytes?.length ?? 1;

class FakeDb {
  data = new Map<string, FakeRecord>();
  private pending: FakeTx[] = [];
  private running = false;
  constructor(readonly quota: number, readonly chromium = false) {}

  size(map = this.data): number {
    let total = 0;
    for (const r of map.values()) total += recordSize(r);
    return total;
  }

  transaction(_store: string, mode: IDBTransactionMode): FakeTx {
    const t = new FakeTx(this, mode);
    this.pending.push(t);
    if (!this.running) setTimeout(() => this.next(), 0);
    this.running = true;
    return t;
  }

  next(): void {
    const t = this.pending.shift();
    if (!t) {
      this.running = false;
      return;
    }
    t.run();
    setTimeout(() => this.next(), 0);
  }
}

interface FakeRequest {
  result?: unknown;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

class FakeTx {
  private ops: Array<() => void> = [];
  private work = new Map<string, FakeRecord>();
  private written = 0;
  private state: 'waiting' | 'running' | 'done' = 'waiting';
  private aborted = false;
  error: unknown = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly db: FakeDb, readonly mode: IDBTransactionMode) {}

  objectStore(): unknown {
    const op = (fn: (req: FakeRequest) => void): FakeRequest => {
      if (this.state === 'done' || this.aborted) throw new DOMException('Transaction is finished', 'TransactionInactiveError');
      const req: FakeRequest = { error: null, onsuccess: null, onerror: null };
      this.ops.push(() => {
        fn(req);
        req.onsuccess?.();
      });
      return req;
    };
    const write = (): void => {
      if (this.mode !== 'readwrite') throw new DOMException('Read only', 'ReadOnlyError');
    };
    return {
      put: (v: FakeRecord) => {
        write();
        return op(() => {
          this.written += recordSize(v);
          this.work.set(v.id, v);
        });
      },
      delete: (id: string) => {
        write();
        return op(() => this.work.delete(id));
      },
      clear: () => {
        write();
        return op(() => this.work.clear());
      },
      get: (id: string) => op((req) => (req.result = this.work.get(id))),
      getAll: (range?: FakeRange) =>
        op((req) => (req.result = [...this.work.values()].filter((v) => !range || (v.id >= range.lower && v.id <= range.upper)))),
    };
  }

  commit(): void {}

  abort(): void {
    if (this.state === 'done') throw new DOMException('Transaction is finished', 'InvalidStateError');
    this.aborted = true;
  }

  run(): void {
    this.state = 'running';
    this.work = new Map(this.db.data);
    while (this.ops.length && !this.aborted) this.ops.shift()!();
    this.state = 'done';
    if (this.aborted) {
      this.error = new DOMException('Aborted', 'AbortError');
      this.onabort?.();
      return;
    }
    const used = this.db.chromium ? this.db.size() + this.written : this.db.size(this.work);
    if (this.mode === 'readwrite' && used > this.db.quota) {
      this.error = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      this.onabort?.();
      return;
    }
    if (this.mode === 'readwrite') this.db.data = this.work;
    this.oncomplete?.();
  }
}

function item(id: string, size: number, lastUsed: number, fill = 1): HistoryItem {
  return {
    id,
    name: `${id}.png`,
    bytes: new Uint8Array(size).fill(fill),
    url: '',
    addedAt: lastUsed,
    lastUsed,
    state: 'staged',
    result: null,
    error: null,
    overrides: {},
    profile: 'auto',
    quality: null,
  };
}

function seed(db: FakeDb, items: readonly HistoryItem[]): void {
  for (const i of items) db.data.set(i.id, { ...i, bytes: i.bytes } as unknown as FakeRecord);
}

describe('history store writes', () => {
  test('two saves at the quota each free their own room and both land', async () => {
    const db = new FakeDb(45);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3), item('r4', 10, 4)]);
    const store = idbStore(db as unknown as IDBDatabase);
    const [a, b] = await Promise.all([store.put(item('a', 10, 10)), store.put(item('b', 10, 11))]);
    expect(a).toEqual({ ok: true, evicted: ['r1'] });
    expect(b).toEqual({ ok: true, evicted: ['r2'] });
    expect([...db.data.keys()].sort()).toEqual(['a', 'b', 'r3', 'r4']);
  });

  test('an older save that needs room never overwrites a newer save of the same capture', async () => {
    const db = new FakeDb(40);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3)]);
    const store = idbStore(db as unknown as IDBDatabase);
    const older = store.put(item('a', 20, 10, 1));
    const newer = store.put(item('a', 5, 11, 2));
    expect(await older).toEqual({ ok: true, evicted: ['r1'] });
    expect(await newer).toEqual({ ok: true, evicted: [] });
    const saved = db.data.get('a')!;
    expect(saved.bytes?.length).toBe(5);
    expect(saved.bytes?.[0]).toBe(2);
  });

  test('a save that still does not fit deletes nothing', async () => {
    const db = new FakeDb(30);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3)]);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('big', 40, 10))).toEqual({ ok: false, evicted: [] });
    expect([...db.data.keys()].sort()).toEqual(['r1', 'r2', 'r3']);
  });

  test('protected captures are never picked to make room', async () => {
    const db = new FakeDb(35);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3)]);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('a', 10, 10), new Set(['r1']))).toEqual({ ok: true, evicted: ['r2'] });
    expect(db.data.has('r1')).toBe(true);
  });

  test('a remove queued after a save runs after it', async () => {
    const db = new FakeDb(1000);
    const store = idbStore(db as unknown as IDBDatabase);
    const saved = store.put(item('a', 10, 1));
    const removed = store.remove('a');
    await Promise.all([saved, removed]);
    expect(db.data.has('a')).toBe(false);
  });

  test('evictionOrder skips the record being written, protected and invalid records', () => {
    const records = [item('d', 1, 4), item('a', 1, 1), item('b', 1, 2), { id: 'bad' }, item('c', 1, 3)];
    expect(evictionOrder(records, 'a', new Set(['c'])).map((r) => r.id)).toEqual(['b', 'd']);
  });
});

describe('history store writes under Chromium style quota', () => {
  const KiB = 1024;
  const seedFour = (db: FakeDb): void =>
    seed(db, [item('r1', 184 * KiB, 1), item('r2', 184 * KiB, 2), item('r3', 184 * KiB, 3), item('r4', 184 * KiB, 4)]);

  test('a delete and a put in one transaction does not make room', async () => {
    const db = new FakeDb(900 * KiB, true);
    seedFour(db);
    const t = db.transaction('items', 'readwrite');
    const store = t.objectStore() as { delete(id: string): void; put(v: unknown): void };
    store.delete('r1');
    store.put(item('new', 225 * KiB, 10));
    const outcome = await new Promise<string>((resolve) => {
      t.oncomplete = () => resolve('complete');
      t.onabort = () => resolve((t.error as DOMException).name);
    });
    expect(outcome).toBe('QuotaExceededError');
    expect(db.data.has('r1')).toBe(true);
  });

  test('a 225 KiB save frees one old 184 KiB capture in its own transaction first', async () => {
    const db = new FakeDb(900 * KiB, true);
    seedFour(db);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('new', 225 * KiB, 10))).toEqual({ ok: true, evicted: ['r1'] });
    expect([...db.data.keys()].sort()).toEqual(['new', 'r2', 'r3', 'r4']);
  });

  test('a 2 MiB save that never fits puts every deleted capture back', async () => {
    const db = new FakeDb(900 * KiB, true);
    seedFour(db);
    const before = new Map(db.data);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('huge', 2048 * KiB, 10))).toEqual({ ok: false, evicted: [] });
    expect([...db.data.keys()].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    for (const [id, r] of before) expect(db.data.get(id)?.bytes).toBe(r.bytes);
    expect((await store.loadAll()).map((i) => i.id).sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  test('protected captures stay when the save needs room', async () => {
    const db = new FakeDb(900 * KiB, true);
    seedFour(db);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('new', 225 * KiB, 10), new Set(['r1']))).toEqual({ ok: true, evicted: ['r2'] });
    expect(db.data.has('r1')).toBe(true);
  });
});

describe('history store writes across tabs', () => {
  const hasLocks = typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const untilEvicted = async (db: FakeDb, id: string): Promise<void> => {
    for (let i = 0; i < 1000 && db.data.has(id); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.data.has(id)).toBe(false);
  };

  test.skipIf(!hasLocks)('a second tab never saves a capture between the first tab evicting it and writing it back', async () => {
    const db = new FakeDb(45);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3), item('r4', 10, 4)]);
    const first = idbStore(db as unknown as IDBDatabase);
    const second = idbStore(db as unknown as IDBDatabase);
    const huge = first.put(item('huge', 100, 10));
    await untilEvicted(db, 'r1');
    const renamed = second.put({ ...item('r2', 10, 2), title: 'Newer title' });
    expect(await huge).toEqual({ ok: false, evicted: [] });
    expect(await renamed).toEqual({ ok: true, evicted: [] });
    expect([...db.data.keys()].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect((db.data.get('r2') as { title?: string }).title).toBe('Newer title');
    expect((await second.loadAll()).find((i) => i.id === 'r2')?.title).toBe('Newer title');
  });

  test('a rename in a second tab never brings back a capture the first tab cleared', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('a', 10, 1), item('b', 10, 2)]);
    const first = idbStore(db as unknown as IDBDatabase);
    const second = idbStore(db as unknown as IDBDatabase);
    expect((await first.loadAll()).map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect((await second.loadAll()).map((i) => i.id).sort()).toEqual(['a', 'b']);

    await first.clear();
    const renamed = await second.put({ ...item('a', 10, 1), title: 'Renamed' }, new Set(), { existing: true });
    expect(renamed).toEqual({ ok: false, evicted: [], gone: true });
    // A save of a capture added before the clear, even one never saved yet, stays out too.
    expect(await second.put({ ...item('b', 10, 2), title: 'Renamed' })).toEqual({ ok: false, evicted: [], gone: true });
    expect(await first.loadAll()).toEqual([]);
    expect(await second.loadAll()).toEqual([]);
    expect([...db.data.keys()].filter((id) => id === 'a' || id === 'b')).toEqual([]);
  });

  test('after a clear in another tab, new captures still save and the clearing tab can save again', async () => {
    const db = new FakeDb(1000);
    const first = idbStore(db as unknown as IDBDatabase);
    const second = idbStore(db as unknown as IDBDatabase);
    await second.loadAll();
    await first.clear();
    const fresh = { ...item('new', 10, 3), addedAt: Date.now() + 1000 };
    expect(await second.put(fresh)).toEqual({ ok: true, evicted: [] });
    // Turning history off then on again in the same tab saves the session again.
    expect(await first.put(item('mine', 10, 1))).toEqual({ ok: true, evicted: [] });
    expect((await first.loadAll()).map((i) => i.id).sort()).toEqual(['mine', 'new']);
  });

  test('a rename in a second tab never brings back a capture the first tab removed', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('a', 10, 1)]);
    const first = idbStore(db as unknown as IDBDatabase);
    const second = idbStore(db as unknown as IDBDatabase);
    await first.remove('a');
    expect(await second.put({ ...item('a', 10, 1), title: 'Renamed' }, new Set(), { existing: true })).toEqual({
      ok: false,
      evicted: [],
      gone: true,
    });
    expect(db.data.has('a')).toBe(false);
  });

  test('saves still work when the browser refuses Web Locks', async () => {
    vi.stubGlobal('navigator', {
      locks: { request: () => Promise.reject(new DOMException('Access to the Locks API is denied', 'SecurityError')) },
    });
    const db = new FakeDb(1000);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('a', 10, 1))).toEqual({ ok: true, evicted: [] });
    expect((await store.loadAll()).map((i) => i.id)).toEqual(['a']);
  });

  test('saves still work without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const db = new FakeDb(1000);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('a', 10, 1))).toEqual({ ok: true, evicted: [] });
    expect(db.data.has('a')).toBe(true);
  });
});

describe('cursor saves', () => {
  const C1: PlotCursors = { x1: 1, x2: 2, y1: 3, y2: 4, channel: 'C1' };
  const C2: PlotCursors = { x1: 5, x2: 6, y1: 7, y2: 8, channel: 'C2' };
  const settles = <T>(p: Promise<T>): Promise<T | 'stalled'> =>
    Promise.race([p, new Promise<'stalled'>((resolve) => setTimeout(() => resolve('stalled'), 1000))]);

  test('an urgent cursor save that hits the quota never stalls later saves', async () => {
    const db = new FakeDb(10);
    seed(db, [item('r1', 10, 1)]);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await settles(store.updateCursors('r1', C1, true))).toBe(false);
    expect(await settles(store.clear())).toBeUndefined();
    expect(await settles(store.put(item('a', 5, 2)))).toEqual({ ok: true, evicted: [] });
    expect([...db.data.keys()].filter((id) => !id.startsWith('meta:'))).toEqual(['a']);
  });

  test('an urgent cursor save after another tab renamed the capture keeps the newer title', async () => {
    const db = new FakeDb(1000);
    seed(db, [{ ...item('r1', 10, 1), title: 'Old title' }]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    await tabA.loadAll();
    await tabB.put({ ...item('r1', 10, 1), title: 'Newer title' });
    const renamed = db.data.get('r1');
    expect(await tabA.updateCursors('r1', C1, true)).toBe(true);
    expect(db.data.get('r1')).toBe(renamed);
    const [loaded] = await tabA.loadAll();
    expect(loaded?.title).toBe('Newer title');
    expect(loaded?.cursors).toEqual(C1);
  });

  test('an urgent cursor save after another tab deleted the capture never brings it back', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    await tabA.loadAll();
    await tabB.remove('r1');
    await tabA.updateCursors('r1', C1, true);
    expect(db.data.has('r1')).toBe(false);
    expect(await tabA.loadAll()).toEqual([]);
    expect(db.data.size).toBe(0);
  });

  test('a normal cursor save changes only the cursors and skips a deleted capture', async () => {
    const db = new FakeDb(1000);
    seed(db, [{ ...item('r1', 10, 1), title: 'Newer title' }]);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.updateCursors('r1', C1)).toBe(true);
    expect(db.data.get('r1')).toMatchObject({ title: 'Newer title', cursors: C1 });
    expect(await store.updateCursors('r1', null)).toBe(true);
    expect(db.data.get('r1')).not.toHaveProperty('cursors');
    expect(await store.updateCursors('gone', C1)).toBe(false);
    expect(db.data.has('gone')).toBe(false);
  });

  test('a queued cursor save never overwrites a newer urgent one', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const store = idbStore(db as unknown as IDBDatabase);
    const busy = store.put(item('other', 10, 2));
    const older = store.updateCursors('r1', C1);
    const newer = store.updateCursors('r1', C2, true);
    await Promise.all([busy, older, newer]);
    expect((await store.loadAll()).find((i) => i.id === 'r1')?.cursors).toEqual(C2);
  });

  test('a full save with newer cursors replaces cursors left by an earlier urgent save', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const store = idbStore(db as unknown as IDBDatabase);
    await store.updateCursors('r1', C1, true);
    await store.put({ ...item('r1', 10, 1), cursors: C2, cursorsAt: nextRev() });
    expect((await store.loadAll())[0]?.cursors).toEqual(C2);
    expect([...db.data.keys()]).toEqual(['r1']);
  });

  test('a queued cursor save in one tab never erases a newer urgent one from another tab', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    const revA = nextRev();
    const revB = nextRev();
    const busy = tabA.put(item('other', 10, 2));
    const older = tabA.updateCursors('r1', C1, false, revA);
    const newer = tabB.updateCursors('r1', C2, true, revB);
    expect(await Promise.all([busy.then((r) => r.ok), older, newer])).toEqual([true, true, true]);
    expect((await tabA.loadAll()).find((i) => i.id === 'r1')).toMatchObject({ cursors: C2, cursorsAt: revB });
  });

  test('a rename that never touched the cursors keeps newer cursors flushed by another tab', async () => {
    const db = new FakeDb(1000);
    const loadedAt = nextRev();
    seed(db, [{ ...item('r1', 10, 1), cursors: C1, cursorsAt: loadedAt }]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    const [loaded] = await tabA.loadAll();
    expect(loaded?.cursorsAt).toBe(loadedAt);
    expect(await tabB.updateCursors('r1', C2, true)).toBe(true);
    expect((await tabA.put({ ...loaded!, title: 'Renamed' })).ok).toBe(true);
    expect([...db.data.keys()]).toEqual(['r1']);
    expect(db.data.get('r1')).toMatchObject({ title: 'Renamed', cursors: C2 });
    expect((await tabA.loadAll())[0]).toMatchObject({ title: 'Renamed', cursors: C2 });
  });

  test.skipIf(typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function')(
    'a rename queued behind the history lock keeps a newer cursor flushed by another tab meanwhile',
    async () => {
      const db = new FakeDb(1000);
      seed(db, [item('r1', 10, 1)]);
      const tabA = idbStore(db as unknown as IDBDatabase);
      const tabB = idbStore(db as unknown as IDBDatabase);
      let release!: () => void;
      await new Promise<void>((held) => {
        void navigator.locks.request('graticule-history', () => new Promise<void>((r) => {
          release = r;
          held();
        }));
      });
      const renamed = tabA.put({ ...item('r1', 10, 1), title: 'Renamed', cursors: C1, cursorsAt: nextRev() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await tabB.updateCursors('r1', C2, true)).toBe(true);
      release();
      expect((await renamed).ok).toBe(true);
      expect([...db.data.keys()]).toEqual(['r1']);
      expect(db.data.get('r1')).toMatchObject({ title: 'Renamed', cursors: C2 });
    },
  );

  test('a save already queued never overwrites or deletes a newer urgent cursor record', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const store = idbStore(db as unknown as IDBDatabase);
    const stale = nextRev();
    const busy = store.put(item('other', 10, 2));
    const full = store.put({ ...item('r1', 10, 1), title: 'Renamed', cursors: C1, cursorsAt: stale });
    const patch = store.updateCursors('r1', C1, false, stale);
    expect(await store.updateCursors('r1', C2, true)).toBe(true);
    await Promise.all([busy, full, patch]);
    expect(db.data.get('r1')).toMatchObject({ title: 'Renamed', cursors: C2 });
    expect([...db.data.keys()].filter((k) => k.startsWith('cursors:'))).toEqual([]);
    expect((await store.loadAll()).find((i) => i.id === 'r1')).toMatchObject({ title: 'Renamed', cursors: C2 });
  });

  test('an urgent cursor save that hits the quota never cancels a queued normal one', async () => {
    const db = new FakeDb(10);
    seed(db, [item('r1', 10, 1)]);
    const store = idbStore(db as unknown as IDBDatabase);
    const queued = store.updateCursors('r1', C1, false, nextRev());
    const urgent = store.updateCursors('r1', C2, true, nextRev());
    expect(await urgent).toBe(false);
    expect(await queued).toBe(true);
    expect([...db.data.keys()]).toEqual(['r1']);
    expect(db.data.get('r1')).toMatchObject({ cursors: C1 });
  });

  test('loading skips and removes a cursor record older than the capture cursors', async () => {
    const db = new FakeDb(1000);
    seed(db, [{ ...item('r1', 10, 1), cursors: C2, cursorsAt: 200 }]);
    db.data.set('cursors:r1', { id: 'cursors:r1', cursors: C1, updatedAt: 100 } as unknown as FakeRecord);
    const store = idbStore(db as unknown as IDBDatabase);
    expect((await store.loadAll())[0]?.cursors).toEqual(C2);
    expect([...db.data.keys()]).toEqual(['r1']);
  });

  test('making room deletes a capture together with its cursor record, so one capture is enough', async () => {
    const db = new FakeDb(30);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2)]);
    db.data.set('cursors:r1', { id: 'cursors:r1', cursors: C1, updatedAt: 1 } as unknown as FakeRecord);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('a', 20, 10))).toEqual({ ok: true, evicted: ['r1'] });
    expect([...db.data.keys()].sort()).toEqual(['a', 'r2']);
  });

  test('a rollback puts back each capture with its cursor record', async () => {
    const db = new FakeDb(45);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3), item('r4', 10, 4)]);
    db.data.set('cursors:r1', { id: 'cursors:r1', cursors: C1, updatedAt: 1 } as unknown as FakeRecord);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.put(item('huge', 100, 10))).toEqual({ ok: false, evicted: [] });
    expect([...db.data.keys()].sort()).toEqual(['cursors:r1', 'r1', 'r2', 'r3', 'r4']);
    expect((await store.loadAll()).find((i) => i.id === 'r1')?.cursors).toEqual(C1);
  });

  test('a rollback keeps a newer cursor record another tab wrote while the capture was out', async () => {
    const db = new FakeDb(45);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3), item('r4', 10, 4)]);
    db.data.set('cursors:r1', { id: 'cursors:r1', cursors: C1, updatedAt: 1 } as unknown as FakeRecord);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    const huge = tabA.put(item('huge', 100, 10));
    for (let i = 0; i < 1000 && db.data.has('r1'); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.data.has('r1')).toBe(false);
    expect(await tabB.updateCursors('r1', C2, true, 200)).toBe(true);
    expect(await huge).toEqual({ ok: false, evicted: [] });
    const side200 = [...db.data.keys()].find((k) => k.startsWith(`cursors:r1:${key200}:`));
    expect(side200).toBeTruthy();
    expect([...db.data.keys()].sort()).toEqual(['cursors:r1', side200!, 'r1', 'r2', 'r3', 'r4']);
    expect((await tabA.loadAll()).find((i) => i.id === 'r1')?.cursors).toEqual(C2);
    expect([...db.data.keys()].sort()).toEqual([side200!, 'r1', 'r2', 'r3', 'r4']);
  });

  const key100 = '100'.padStart(16, '0');
  const key200 = '200'.padStart(16, '0');

  test('an older urgent save flushed after a newer urgent one from another tab never wins', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    expect(await tabB.updateCursors('r1', C2, true, 200)).toBe(true);
    expect(await tabA.updateCursors('r1', C1, true, 100)).toBe(true);
    const side100 = [...db.data.keys()].find((k) => k.startsWith(`cursors:r1:${key100}:`));
    const side200 = [...db.data.keys()].find((k) => k.startsWith(`cursors:r1:${key200}:`));
    expect(side100).toBeTruthy();
    expect(side200).toBeTruthy();
    expect([...db.data.keys()].sort()).toEqual([side100!, side200!, 'r1']);
    expect((await tabA.loadAll())[0]).toMatchObject({ cursors: C2, cursorsAt: 200 });
    expect([...db.data.keys()].sort()).toEqual([side200!, 'r1']);
    expect(await tabA.updateCursors('r1', C1, true, 100)).toBe(true);
    expect(await tabA.updateCursors('r1', C1, false, 150)).toBe(true);
    expect(db.data.get('r1')).toMatchObject({ cursors: C2, cursorsAt: 200 });
    expect(await tabA.updateCursors('r1', C1, true, 120)).toBe(true);
    expect((await tabA.put({ ...item('r1', 10, 1), title: 'Renamed', cursors: C1, cursorsAt: 150 })).ok).toBe(true);
    expect([...db.data.keys()]).toEqual(['r1']);
    expect(db.data.get('r1')).toMatchObject({ title: 'Renamed', cursors: C2, cursorsAt: 200 });
  });

  test('same-millisecond urgent saves from two tabs get distinct keys instead of overwriting', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1)]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    expect(await tabB.updateCursors('r1', C2, true, 200)).toBe(true);
    expect(await tabA.updateCursors('r1', C1, true, 200)).toBe(true);
    expect([...db.data.keys()].filter((k) => k.startsWith(`cursors:r1:${key200}:`))).toHaveLength(2);
  });

  test('cursor records of a capture whose id starts the same are never touched', async () => {
    const db = new FakeDb(1000);
    seed(db, [item('r1', 10, 1), item('r10', 10, 2)]);
    const store = idbStore(db as unknown as IDBDatabase);
    expect(await store.updateCursors('r10', C2, true, 200)).toBe(true);
    expect(await store.updateCursors('r1', C1, false, 300)).toBe(true);
    await store.remove('r1');
    const side200 = [...db.data.keys()].find((k) => k.startsWith(`cursors:r10:${key200}:`));
    expect(side200).toBeTruthy();
    expect([...db.data.keys()].sort()).toEqual([side200!, 'r10']);
    expect((await store.loadAll())[0]).toMatchObject({ id: 'r10', cursors: C2 });
  });
});

describe('cursor saves without Web Locks', () => {
  const C1: PlotCursors = { x1: 1, x2: 2, y1: 3, y2: 4, channel: 'C1' };
  const C2: PlotCursors = { x1: 5, x2: 6, y1: 7, y2: 8, channel: 'C2' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs `hook` right after the first read only transaction is created, before it runs. */
  const onFirstRead = (db: FakeDb, hook: () => void): void => {
    const original = db.transaction.bind(db);
    let done = false;
    db.transaction = (store: string, mode: IDBTransactionMode) => {
      const t = original(store, mode);
      if (mode === 'readonly' && !done) {
        done = true;
        hook();
      }
      return t;
    };
  };

  test('a rollback puts back the capture as it was when deleted, with a cursor saved by another tab after the listing', async () => {
    vi.stubGlobal('navigator', {});
    const db = new FakeDb(45);
    seed(db, [item('r1', 10, 1), item('r2', 10, 2), item('r3', 10, 3), item('r4', 10, 4)]);
    const tabA = idbStore(db as unknown as IDBDatabase);
    const tabB = idbStore(db as unknown as IDBDatabase);
    let saved: Promise<boolean> | undefined;
    // Tab B saves a cursor on r1 after tab A listed what it may delete, before it deletes r1.
    onFirstRead(db, () => {
      saved = tabB.updateCursors('r1', C2, false, 200);
    });
    expect(await tabA.put(item('huge', 100, 10))).toEqual({ ok: false, evicted: [] });
    expect(await saved).toBe(true);
    expect([...db.data.keys()].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(db.data.get('r1')).toMatchObject({ cursors: C2, cursorsAt: 200 });
    expect((await tabA.loadAll()).find((i) => i.id === 'r1')).toMatchObject({ cursors: C2, cursorsAt: 200 });
  });

  test('loading keeps a cursor record whose capture another tab put back before the cleanup ran', async () => {
    vi.stubGlobal('navigator', {});
    const db = new FakeDb(1000);
    const side = { id: `cursors:r1:${'100'.padStart(16, '0')}`, itemId: 'r1', cursors: C1, updatedAt: 100 };
    db.data.set(side.id, side as unknown as FakeRecord);
    const r1 = item('r1', 10, 1);
    const store = idbStore(db as unknown as IDBDatabase);
    // The capture is out while loading lists the records, maybe being moved by another tab's rollback,
    // and is back before the cleanup transaction runs.
    onFirstRead(db, () => {
      const t = db.transaction('items', 'readwrite');
      (t.objectStore() as { put(v: unknown): void }).put({ ...r1 });
    });
    expect(await store.loadAll()).toEqual([]);
    expect(db.data.has(side.id)).toBe(true);
    expect((await store.loadAll())[0]).toMatchObject({ id: 'r1', cursors: C1, cursorsAt: 100 });
  });
});
