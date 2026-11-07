/** Browser persistence adapter. Domain mutations remain the versioned API operations. */
export const OFFLINE_DB = "palimora-personal-v1";
let connection: Promise<IDBDatabase> | undefined;
export function database() {
  return (connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
export async function read<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const r = db.transaction("records").objectStore("records").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function records<T>(prefix: string): Promise<Array<[string, T]>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const result: Array<[string, T]> = [];
    const r = db
      .transaction("records")
      .objectStore("records")
      .openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
    r.onsuccess = () => {
      const c = r.result;
      if (!c) return resolve(result);
      result.push([String(c.key), c.value]);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
}
export async function write(
  changes: Array<[string, unknown]>,
  partition?: string,
  clear = false,
) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("records", "readwrite"),
      s = tx.objectStore("records");
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? Error("SESSION_CHANGED"));
    const apply = () => {
      if (clear) s.clear();
      for (const [key, value] of changes)
        value === undefined ? s.delete(key) : s.put(value, key);
    };
    if (partition) {
      const r = s.get("identity");
      r.onsuccess = () =>
        r.result?.partition === partition ? apply() : tx.abort();
    } else apply();
  });
}
let chain = Promise.resolve<unknown>(undefined);
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (navigator.locks)
    return await navigator.locks.request("palimora-personal", fn);
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
