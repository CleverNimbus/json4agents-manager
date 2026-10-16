import * as fs from '../fileAccess.js';
import { state } from '../store.js';
import { collectLeafDirs, hashLeafFolder } from '../hash.js';

const DIR_KEY = 'hashSaveDir';
const HASH_FILE = 'hashes.json';

export default {
  data() {
    return {
      folderName: '',
      dirHandle: null,
      hashing: false,
      currentPath: '',
      hashedCount: 0,
      totalCount: 0,
      error: null,
      savedName: null,
      folders: [],
      supported:
        typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    };
  },
  computed: {
    canHash() {
      return !!this.dirHandle && !this.hashing;
    },
  },
  methods: {
    async explore() {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        this.dirHandle = handle;
        this.folderName = handle.name;
        this.error = null;
      } catch (e) {
        if (e && e.name !== 'AbortError') {
          this.error = 'Explore failed: ' + e.message;
        }
      }
    },

    async runHash() {
      if (!this.dirHandle) return;
      this.hashing = true;
      this.error = null;
      this.savedName = null;
      try {
        // One-time folder grant, same procedure as the agents JSON file:
        // pick once (inside this click), remember the handle, save silently
        // from then on. The picker opens at the open JSON file's folder and
        // the output name is fixed: hashes.json.
        const saveDir = await this.ensureSaveDir();

        const leaves = await collectLeafDirs(this.dirHandle);
        const datetime = new Date().toISOString();
        this.totalCount = leaves.length;
        this.hashedCount = 0;
        this.currentPath = '';

        const data = await this.loadSaved(saveDir);
        data.folders = data.folders || [];

        for (const leaf of leaves) {
          const hash = await hashLeafFolder(leaf.handle);
          const rec = { datetime, hash };
          let entry = data.folders.find((f) => f.path === leaf.relPath);
          if (!entry) {
            entry = { path: leaf.relPath, hashes: [] };
            data.folders.push(entry);
          }
          entry.hashes.push(rec);
          this.currentPath = leaf.relPath;
          this.hashedCount += 1;
        }

        data.sourceFolder = this.folderName;
        data.generated = datetime;
        this.folders = data.folders;

        await this.writeHashes(saveDir, data);
        this.savedName = saveDir.name + '/' + HASH_FILE;
      } catch (e) {
        this.error =
          e && e.name === 'AbortError'
            ? 'Hash cancelled: no folder granted for ' + HASH_FILE + '.'
            : 'Hash failed: ' + e.message;
      } finally {
        this.hashing = false;
      }
    },

    async ensureSaveDir() {
      let dir = await fs.loadHandle(DIR_KEY);
      if (!dir) {
        dir = await fs.pickDirectory(state.handle || undefined);
        await fs.saveHandle(dir, DIR_KEY);
      }
      const ok = await fs.requestWritePermission(dir);
      if (!ok) {
        throw new Error('Write permission denied for folder ' + dir.name);
      }
      return dir;
    },

    async loadSaved(dir) {
      try {
        const fileHandle = await dir.getFileHandle(HASH_FILE);
        const file = await fileHandle.getFile();
        const data = JSON.parse(await file.text());
        return data && Array.isArray(data.folders) ? data : { folders: [] };
      } catch {
        return { folders: [] };
      }
    },

    async writeHashes(dir, data) {
      const fileHandle = await dir.getFileHandle(HASH_FILE, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(data, null, 2) + '\n');
      await writable.close();
    },

    lastHash(f) {
      return f.hashes.length
        ? f.hashes[f.hashes.length - 1]
        : { datetime: '', hash: '' };
    },
  },
  template: `
  <div class="tab-panel">
    <div class="toolbar">
      <div class="file-info">
        <strong>Folder:</strong> <span class="mono">{{ folderName || 'no folder selected' }}</span>
      </div>
      <div class="toolbar-actions">
        <button @click="explore" :disabled="!supported || hashing">Explore&hellip;</button>
        <button class="primary" :disabled="!canHash"
          :title="dirHandle ? '' : 'Pick a folder with Explore first'"
          @click="runHash">
          {{ hashing ? 'Hashing...' : 'Hash' }}
        </button>
      </div>
    </div>

    <div v-if="!supported" class="banner error">
      This browser lacks the File System Access API. Use Chrome or Edge over http://localhost.
    </div>
    <p v-else class="hint">
      Pick a folder with Explore, then hash the content of every deepest (leaf) subfolder.
      Results append to <code>hashes.json</code> next to the open agents JSON file.
      First run asks once for that folder (browser security); afterwards it saves
      there without asking. File name and location are fixed.
    </p>

    <div v-if="hashing" class="banner ok">
      Hashing... {{ currentPath || 'starting' }}
      <span v-if="totalCount">&nbsp;({{ hashedCount }} / {{ totalCount }})</span>
    </div>
    <div v-if="error" class="banner error">{{ error }}</div>
    <div v-if="savedName" class="banner ok">Saved: {{ savedName }}</div>

    <table v-if="folders.length" class="grid">
      <thead>
        <tr><th>Folder</th><th>Last hashed</th><th>Hash</th></tr>
      </thead>
      <tbody>
        <tr v-for="f in folders" :key="f.path">
          <td class="mono">{{ f.path }}</td>
          <td>{{ lastHash(f).datetime }}</td>
          <td class="mono hash" :title="lastHash(f).hash">{{ lastHash(f).hash }}</td>
        </tr>
      </tbody>
    </table>
    <div v-else class="placeholder">
      <div class="ph-box">No results yet. Select a folder and click Hash.</div>
    </div>
  </div>`,
};
