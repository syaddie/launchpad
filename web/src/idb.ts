// A small IndexedDB wrapper for what the page keeps in the browser: its copy of the state
// (too big for localStorage's ~5 MB once the workout history grows) and the edits waiting
// to be saved while the server can't be reached (outbox.ts).

const NAME = 'launchpad';
const VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => {
      const db = r.result;
      // A newer version of the page in another tab wants to upgrade: let it.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((e) => {
    opening = null;
    throw e;
  });
  return opening;
}

/** Run one request in its own transaction; resolves once the transaction has committed. */
export async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export const kvGet = <T>(key: string) => idb<T | undefined>('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => idb('kv', 'readwrite', (s) => s.put(value, key)).then(() => {});

/** Read `key`, change it with `fn` and write it back, all in one transaction, so two tabs can't interleave. */
export async function kvUpdate<T>(key: string, fn: (v: T | undefined) => T): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    let next: T;
    const get = store.get(key);
    get.onsuccess = () => {
      next = fn(get.result as T | undefined);
      store.put(next, key);
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
