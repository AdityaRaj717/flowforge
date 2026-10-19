// Minimal promise wrapper over IndexedDB, shared by the service worker and the side panel
// (both run on the extension origin, so they see the same database).

export const DB_NAME = 'flowforge';
export const DB_VERSION = 1;

export type StoreName = 'queues' | 'jobs' | 'assets' | 'blobs' | 'workflows' | 'storyboards' | 'logs' | 'kv';

let dbp: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queues')) db.createObjectStore('queues', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('jobs')) {
        const s = db.createObjectStore('jobs', { keyPath: 'id' });
        s.createIndex('queueId', 'queueId');
        s.createIndex('state', 'state');
      }
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('workflows')) db.createObjectStore('workflows', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('storyboards')) db.createObjectStore('storyboards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logs')) {
        const s = db.createObjectStore('logs', { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(value)) as Promise<T[]>;
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  await wrap(db.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    values.forEach((v) => s.put(v));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function del(store: StoreName, keys: IDBValidKey | IDBValidKey[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => s.delete(k));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  return ((await get<T>('kv', key)) ?? fallback) as T;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await put('kv', value, key);
}

/** Keep the newest `max` log rows. */
export async function trimLogs(max: number): Promise<void> {
  const db = await openDb();
  const count = await wrap(db.transaction('logs').objectStore('logs').count());
  if (count <= max) return;
  let toDelete = count - max;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('logs', 'readwrite');
    const cur = tx.objectStore('logs').index('at').openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || toDelete <= 0) return;
      c.delete();
      toDelete--;
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function blobToB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode(...buf.subarray(i, i + CH));
  return btoa(s);
}
