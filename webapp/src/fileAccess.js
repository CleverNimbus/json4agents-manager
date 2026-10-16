/**
 * File System Access API helpers.
 *
 * Chromium browsers (Chrome / Edge) expose showOpenFilePicker + writable
 * file handles, which let the app read and write a real JSON file on disk
 * without any backend. On other browsers we fall back to bundled data plus
 * a download-on-save flow (see store.js).
 */

const DB_NAME = 'json-manager-fs';
const DB_STORE = 'handles';
const DB_KEY = 'lastHandle';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Pick a directory once; persist the handle like the JSON file handle so all
 * later reads/writes of `hashes.json` happen silently.
 */
export async function pickDirectory(startIn) {
  const opts = { id: 'json-manager-dir', mode: 'readwrite' };
  if (startIn) opts.startIn = startIn;
  return window.showDirectoryPicker(opts);
}

export const supportsFileSystemAccess = () =>
  typeof window !== 'undefined' && 'showOpenFilePicker' in window;

export async function pickJsonFile() {
  const [handle] = await window.showOpenFilePicker({
    types: [
      {
        description: 'JSON files',
        accept: { 'application/json': ['.json'] },
      },
    ],
    excludeAcceptAllOption: false,
  });
  return handle;
}

export async function readJsonFromHandle(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  return { name: file.name, data: JSON.parse(text) };
}

export async function writeJsonToHandle(handle, data) {
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(data, null, 2) + '\n');
  await writable.close();
}

export async function requestWritePermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export async function saveHandle(handle, key = DB_KEY) {
  try {
    await idbSet(key, handle);
  } catch {
    /* storing the handle is best-effort */
  }
}

export async function loadHandle(key = DB_KEY) {
  try {
    return await idbGet(key);
  } catch {
    return null;
  }
}
