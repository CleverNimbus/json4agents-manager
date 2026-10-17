/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, reactive, ref, watch } from 'vue';
import DataTable from './DataTable.js';
import ExecutionPlanPanel from './ExecutionPlanPanel.js';
import HashDetail from './HashDetail.js';
import { formatBytes, formatDuration, formatTime, latestHash, shortHash } from '../format.js';
import {
  cancelHash,
  loadHashes,
  loadSettings,
  loadState,
  rebuildHashIndex,
  rememberHashFolder,
  setBanner,
  startHash,
  store,
} from '../store.js';

/**
 * First column of the file and folder grids. It is empty unless the row's
 * latest hash differs from the one recorded before it, in which case the cell
 * holds a yellow dot (rendered through the #cell-mark slot).
 */
const MARK_COLUMN = {
  key: 'mark',
  label: '',
  sortable: false,
  text: () => '',
  className: 'col-mark',
};

const fileColumns = [
  MARK_COLUMN,
  { key: 'path', label: 'File', className: 'mono' },
  { key: 'size', label: 'Size', align: 'right', value: (row) => row.size, text: (row) => formatBytes(row.size) },
  { key: 'mtime', label: 'Modified', text: (row) => formatTime(row.mtime) },
  {
    key: 'hash',
    label: 'SHA-256',
    className: 'mono',
    text: (row) => shortHash(row.hash),
    title: (row) => row.hash,
  },
  { key: 'runs', label: 'Hashes', align: 'right', value: (row) => row.runs, title: (row) => `${row.runs} recorded hash(es)` },
];

const folderColumns = [
  MARK_COLUMN,
  { key: 'path', label: 'Folder', className: 'mono' },
  {
    key: 'hash',
    label: 'SHA-256',
    className: 'mono',
    text: (row) => shortHash(row.hash),
    title: (row) => row.hash,
  },
  {
    key: 'runs',
    label: 'Hashes',
    align: 'right',
    value: (row) => row.runs,
    title: (row) => `${row.runs} recorded hash(es)`,
  },
];

const runColumns = [
  { key: 'finishedAt', label: 'Finished', text: (row) => formatTime(row.finishedAt) },
  { key: 'host', label: 'Host', value: (row) => row.host ?? '', text: (row) => row.host || '—' },
  { key: 'root', label: 'Root folder', className: 'mono' },
  { key: 'files', label: 'Files', align: 'right', value: (row) => row.stats?.files ?? 0 },
  {
    key: 'changed',
    label: 'Changed',
    align: 'right',
    value: (row) => row.stats?.changed ?? 0,
    // Runs converted from the old format have no counters.
    text: (row) => (row.stats?.changed === null || row.stats?.changed === undefined ? '—' : row.stats.changed),
  },
  { key: 'bytes', label: 'Bytes', align: 'right', value: (row) => row.stats?.bytes ?? 0, text: (row) => formatBytes(row.stats?.bytes) },
  { key: 'errors', label: 'Errors', align: 'right', value: (row) => row.stats?.errors ?? 0 },
  { key: 'durationMs', label: 'Duration', align: 'right', text: (row) => formatDuration(row.durationMs) },
];

export default {
  name: 'HashingTab',
  components: { DataTable, ExecutionPlanPanel, HashDetail },
  setup() {
    /** Folder picked from the dropdown. Always one of `store.settings.hashFolders`. */
    const selectedFolder = ref('');
    const includeHidden = ref(false);
    const followSymlinks = ref(false);
    const view = ref('files');
    const filter = ref('');
    /** Show only the rows whose hash changed since the previous recorded one. */
    const changedOnly = ref(false);
    /** Row whose hash history is open, null when the popup is closed. */
    const detail = ref(null);

    if (!store.hashes.loaded) loadHashes().catch((err) => setBanner('error', err.message));

    /**
     * Pick the default selection from the collection: the in-flight or last
     * run root wins when it is still in the list, then the remembered folder
     * from state, then the first item. If the collection is empty the
     * dropdown shows an empty-state message instead of a placeholder value.
     */
    const initialSelection = (folders) => {
      if (folders.length === 0) return '';
      const remembered = store.hashJob.root || store.state.hashTab.lastFolder || '';
      if (remembered !== '' && folders.includes(remembered)) return remembered;
      return folders[0];
    };

    if (!store.settings.loaded) {
      loadSettings().catch((err) => setBanner('error', err.message));
    }
    // Restore the folder used last time. An in-progress run always wins over
    // the stored value, so a reload during a hash does not lose the target.
    loadState().then(() => {
      if (selectedFolder.value === '') {
        selectedFolder.value = initialSelection(store.settings.hashFolders);
      }
    });

    const views = [
      { id: 'files', label: 'Files', columns: fileColumns },
      { id: 'folders', label: 'Folders', columns: folderColumns },
      { id: 'runs', label: 'Runs', columns: runColumns },
    ];

    /**
     * Turn a hash store entry into a grid row. `changed` is true when the
     * newest hash differs from the one recorded before it - the server never
     * stores the same hash twice, so this marks exactly the rows that moved.
     * `hashes` arrives newest first, so current is [0] and the one before it
     * is [1]; indexing from the end would compare the two oldest hashes.
     */
    const flatten = (entries) =>
      entries.map((entry) => {
        const hashes = Array.isArray(entry.hashes) ? entry.hashes : [];
        const latest = latestHash(entry);
        const previous = hashes.length > 1 ? hashes[1]?.hash : undefined;
        return {
          path: entry.path,
          hash: latest,
          changed: hashes.length > 1 && latest !== previous,
          hashes,
          runs: hashes.length,
          size: entry.size,
          mtime: entry.mtime,
        };
      });

    const rows = computed(() => {
      const doc = store.hashes.doc;
      if (view.value === 'folders') return flatten(doc.folders);
      if (view.value === 'runs') return doc.runs;
      return flatten(doc.files);
    });

    const visibleRows = computed(() => {
      const needle = filter.value.trim().toLowerCase();
      let result = rows.value;
      // The changed filter only makes sense where rows carry a change flag;
      // the Runs view describes scans, not files.
      if (changedOnly.value && view.value !== 'runs') result = result.filter((row) => row.changed);
      if (needle === '') return result;
      return result.filter((row) => String(row.path ?? row.root ?? '').toLowerCase().includes(needle));
    });

    /** The toggle is only meaningful for the file and folder views. */
    const showChangedToggle = computed(() => view.value !== 'runs' && changedCount.value > 0);
    const toggleChangedOnly = () => {
      changedOnly.value = !changedOnly.value;
    };

    const columns = computed(() => views.find((entry) => entry.id === view.value).columns);
    const rowKey = computed(() => (view.value === 'runs' ? 'finishedAt' : 'path'));
    const clickable = computed(() => view.value !== 'runs');
    const detailKind = computed(() => (view.value === 'folders' ? 'Folder' : 'File'));
    const emptyText = computed(() => {
      if (view.value === 'runs') return 'No hash runs recorded yet.';
      if (view.value === 'folders') return 'No folders hashed yet.';
      return 'No files hashed yet — hash a folder to fill this grid.';
    });

    const changedCount = computed(() => rows.value.filter((row) => row.changed).length);

    /** Rows in the Runs view describe a scan, not a file: nothing to pop up. */
    const openDetail = (row) => {
      if (!clickable.value) return;
      detail.value = row;
    };

    const run = () => {
      const target = selectedFolder.value.trim();
      if (target === '') return;
      rememberHashFolder(target);
      startHash({ path: target, includeHidden: includeHidden.value, followSymlinks: followSymlinks.value });
    };

    /**
     * Throw the derived index away and build it again from the run files. Only
     * `index.json` is rewritten; no run file is touched, so this is safe to try
     * whenever the grids disagree with the runs.
     */
    const rebuildIndex = async () => {
      try {
        const result = await rebuildHashIndex();
        const parts = [`${result.runs} run${result.runs === 1 ? '' : 's'}`, `${result.files} files`, `${result.folders} folders`];
        setBanner(
          result.broken.length > 0 ? 'error' : 'info',
          `Index rebuilt from ${parts.join(' · ')}.` +
            (result.broken.length > 0
              ? ` ${result.broken.length} run file(s) could not be read: ${result.broken.map((b) => b.file).join(', ')}`
              : ''),
        );
      } catch (err) {
        setBanner('error', `Could not rebuild the index: ${err.message}`);
      }
    };

    // A data folder change swaps state.json underneath us. Take the folder
    // remembered there unless the user already chose one.
    watch(
      () => store.revision,
      () => {
        if (selectedFolder.value === '') {
          selectedFolder.value = initialSelection(store.settings.hashFolders);
        }
      },
    );

    // The user may add or remove folders in Settings while this tab is open.
    // Keep the selection valid: if the picked folder disappeared, fall back
    // to the remembered folder or the first item.
    watch(
      () => store.settings.hashFolders,
      (folders) => {
        if (folders.length === 0) {
          selectedFolder.value = '';
          return;
        }
        if (!folders.includes(selectedFolder.value)) {
          selectedFolder.value = initialSelection(folders);
        }
      },
    );

    return {
      cancelHash,
      changedCount,
      changedOnly,
      clickable,
      columns,
      detail,
      detailKind,
      emptyText,
      filter,
      followSymlinks,
      hashFolders: computed(() => store.settings.hashFolders),
      includeHidden,
      openDetail,
      rebuildIndex,
      rowKey,
      run,
      selectedFolder,
      showChangedToggle,
      store,
      toggleChangedOnly,
      view,
      views,
      visibleRows,
    };
  },
  template: `
    <section class="panel">
      <div class="toolbar">
        <label class="field-label" for="hash-folder">Folder</label>
        <select
          v-if="hashFolders.length > 0"
          id="hash-folder"
          v-model="selectedFolder"
          class="agent-select"
          :disabled="store.hashJob.running"
        >
          <option v-for="folder in hashFolders" :key="folder" :value="folder" class="mono">
            {{ folder }}
          </option>
        </select>
        <span v-else class="hash-folder-empty">
          No folders yet — add them in <strong>Settings → Hash folder collection</strong>.
        </span>
        <button
          v-if="!store.hashJob.running"
          type="button"
          class="primary"
          @click="run"
          :disabled="selectedFolder === ''"
        >
          Hash folder
        </button>
        <button v-else type="button" class="danger" @click="cancelHash">Cancel</button>
        <label class="check">
          <input type="checkbox" v-model="includeHidden" :disabled="store.hashJob.running" /> Include hidden
        </label>
        <label class="check">
          <input type="checkbox" v-model="followSymlinks" :disabled="store.hashJob.running" /> follow symlinks
        </label>
      </div>

      <p class="progress" :class="store.hashJob.phase">{{ store.hashJob.progressText }}</p>

      <div class="hashing-split">
        <aside class="hashing-left">
          <ExecutionPlanPanel />
        </aside>
        <div class="hashing-right">
          <div class="toolbar">
            <div class="segmented">
              <button
                v-for="entry in views"
                :key="entry.id"
                type="button"
                :class="{ active: view === entry.id }"
                @click="view = entry.id"
              >{{ entry.label }}</button>
            </div>
            <input v-model="filter" class="filter" type="search" placeholder="Filter by path …" />
            <button
              v-if="showChangedToggle"
              type="button"
              class="badge toggle"
              :class="{ active: changedOnly }"
              :aria-pressed="changedOnly"
              :title="changedOnly ? 'Showing changed files only — click to show all' : 'Click to hide unchanged files'"
              @click="toggleChangedOnly"
            >
              ● {{ changedCount }} changed
            </button>
            <span
              v-if="store.hashes.doc.broken.length > 0"
              class="badge"
              :title="store.hashes.doc.broken.map((b) => b.file + ': ' + b.message).join('\\n')"
              >{{ store.hashes.doc.broken.length }} unreadable run file{{ store.hashes.doc.broken.length === 1 ? '' : 's' }}</span
            >
            <span class="spacer"></span>
            <button
              type="button"
              :disabled="store.hashes.rebuilding || store.hashJob.running"
              title="Throw the derived index away and rebuild it from the run files. Run files are never modified."
              @click="rebuildIndex"
            >
              {{ store.hashes.rebuilding ? 'Rebuilding…' : 'Rebuild index' }}
            </button>
            <span class="badge">{{ visibleRows.length }} rows</span>
            <span class="badge" :title="store.hashes.file">{{ store.hashes.file }}</span>
          </div>

          <DataTable
            :columns="columns"
            :rows="visibleRows"
            :row-key="rowKey"
            default-sort="path"
            :empty-text="emptyText"
            :clickable="clickable"
            @row-click="openDetail"
          >
            <template #cell-mark="{ row }">
              <span
                v-if="row.changed"
                class="dot-changed"
                title="The hash changed since the previous recorded hash"
              ></span>
            </template>
          </DataTable>
        </div>
      </div>

      <HashDetail v-if="detail" :entry="detail" :kind="detailKind" @close="detail = null" />
    </section>
  `,
};