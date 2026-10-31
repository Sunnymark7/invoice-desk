const DB_NAME = 'invoice-desk-local';
const STORE = 'drafts';
let database;

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('此浏览器不支持本地草稿'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('本地草稿被其他页面占用'));
  }).catch(error => { database = null; throw error; });
  return database;
}

async function transact(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = operation(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error || request.error);
    transaction.onabort = () => reject(transaction.error || new Error('本地草稿操作被中止'));
  });
}

export const loadDraft = () => transact('readonly', store => store.get('current'));
export const saveDraft = draft => transact('readwrite', store => store.put(draft, 'current'));
export const deleteDraft = () => transact('readwrite', store => store.delete('current'));
