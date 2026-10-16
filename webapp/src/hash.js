/**
 * Directory hashing helpers.
 *
 * Uses the File System Access API directory handles plus WebCrypto SHA-256,
 * so all hashing happens locally in the browser with no backend.
 */

/** @param {string | ArrayBuffer | ArrayBufferView} input */
export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recursively find every "deepest" (leaf) directory: a folder with files but
 * no subdirectories. The root counts as a leaf when it has no subfolders.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<Array<{ relPath: string, handle: FileSystemDirectoryHandle }>>}
 */
export async function collectLeafDirs(dirHandle) {
  const leaves = [];

  async function visit(dir, relPath) {
    let hasSubdir = false;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        hasSubdir = true;
        await visit(handle, relPath + name + '/');
      }
    }
    if (!hasSubdir) {
      leaves.push({ relPath: relPath.slice(0, -1) || '.', handle: dir });
    }
  }

  await visit(dirHandle, '');
  return leaves;
}

/**
 * Hash the file content of a leaf folder. Files are sorted by name and hashed
 * individually, then the concatenation of `name\0filehash` is hashed once so
 * the result is deterministic and binary-safe.
 *
 * @param {FileSystemDirectoryHandle} dirHandle
 * @returns {Promise<string>} hex digest
 */
export async function hashLeafFolder(dirHandle) {
  /** @type {Array<{ name: string, handle: FileSystemFileHandle }>} */
  const files = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') files.push({ name, handle });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));

  let combined = '';
  for (const f of files) {
    const file = await f.handle.getFile();
    const buf = await file.arrayBuffer();
    const h = await sha256Hex(buf);
    combined += f.name + '\u0000' + h + '\u001e';
  }
  return sha256Hex(combined);
}
