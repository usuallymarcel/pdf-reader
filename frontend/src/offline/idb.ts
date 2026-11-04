const DB_NAME = 'shelf'
const STORE = 'progress'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'))
  })
}

let db: Promise<IDBDatabase> | null = null

/** Runs `body` in one readwrite transaction and resolves with `done`'s value once it has committed. */
export async function inProgressStore<T>(body: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  db ??= open()
  const database = await db
  return new Promise<T>((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite')
    let result: T
    body(tx.objectStore(STORE), (value) => { result = value })
    tx.oncomplete = () => resolve(result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
  })
}
