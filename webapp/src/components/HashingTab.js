import { computed, reactive, ref, watch } from 'vue';
import DataTable from './DataTable.js';
import FolderPicker from './FolderPicker.js';
import HashDetail from './HashDetail.js';
import { formatBytes, formatDuration, formatTime, latestHash, shortHash } from '../format.js';
import { cancelHash, loadHashes, loadState, rememberHashFolder, setBanner, startHash, store } from '../store.js';

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
  { key: 'root', label: 'Root folder', className: 'mono' },
  { key: 'files', label: 'Files', align: 'right' },
  { key: 'bytes', label: 'Bytes', align: 'right', text: (row) => formatBytes(row.bytes) },
  { key: 'errors', label: 'Errors', align: 'right' },
  { key: 'durationMs', label: 'Duration', align: 'right', text: (row) => formatDuration(row.durationMs) },
];

export default {
  name: 'HashingTab',
  components: { DataTable, FolderPicker, HashDetail },
  setup() {
    const path = ref(store.hashJob.root || '');
    const includeHidden = ref(true);
    const followSymlinks = ref(false);
    const view = ref('files');
    const filter = ref('');
    /** Show only the rows whose hash changed since the previous recorded one. */
    const changedOnly = ref(false);
    const picker = reactive({ open: false });
    /** Row whose hash history is open, null when the popup is closed. */
    const detail = ref(null);

    if (!store.hashes.loaded) loadHashes().catch((err) => setBanner('error', err.message));

    // Restore the folder used last time. An in-progress run always wins over
    // the stored value, so a reload during a hash does not lose the target.
    loadState().then(({ hashTab }) => {
      if (path.value.trim() === '') path.value = store.hashJob.root || hashTab.lastFolder || '';
    });

    const views = [
      { id: 'files', label: 'Files', columns: fileColumns },
      { id: 'folders', label: 'Folders', columns: folderColumns },
      { id: 'runs', label: 'Runs', columns: runColumns },
    ];

    /**
     * Turn a hashes.json entry into a grid row. `changed` is true when the
     * newest hash differs from the one recorded before it - the server never
     * stores the same hash twice, so this marks exactly the rows that moved.
     */
    const flatten = (entries) =>
      entries.map((entry) => {
        const hashes = Array.isArray(entry.hashes) ? entry.hashes : [];
        const latest = latestHash(entry);
        const previous = hashes.length > 1 ? hashes[hashes.length - 2]?.hash : undefined;
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
      const target = path.value.trim();
      if (target === '') return;
      rememberHashFolder(target);
      startHash({ path: target, includeHidden: includeHidden.value, followSymlinks: followSymlinks.value });
    };

    /** Choosing a folder in the picker is also "using" it. */
    const chooseFolder = (chosen) => {
      path.value = chosen;
      picker.open = false;
      rememberHashFolder(chosen);
    };

    /** Leaving the text box with a path in it counts as using that folder. */
    const onPathBlur = () => {
      const target = path.value.trim();
      if (target !== '') rememberHashFolder(target);
    };

    // A data folder change swaps state.json underneath us. Take the folder
    // remembered there unless the user already typed or hashed something.
    watch(
      () => store.revision,
      () => {
        if (path.value.trim() === '') path.value = store.hashJob.root || store.state.hashTab.lastFolder || '';
      },
    );

    return {
      cancelHash,
      changedCount,
      changedOnly,
      chooseFolder,
      clickable,
      columns,
      detail,
      detailKind,
      emptyText,
      filter,
      followSymlinks,
      includeHidden,
      onPathBlur,
      openDetail,
      path,
      picker,
      rowKey,
      run,
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
        <label class="field-label" for="hash-path">Folder</label>
        <input
          id="hash-path"
          v-model="path"
          class="path-input mono"
          type="text"
          placeholder="/home/you/projects"
          @keyup.enter="run"
          @blur="onPathBlur"
          :disabled="store.hashJob.running"
        />
        <button type="button" @click="picker.open = true" :disabled="store.hashJob.running">Explore…</button>
        <button v-if="!store.hashJob.running" type="button" class="primary" @click="run" :disabled="path.trim() === ''">
          Hash folder
        </button>
        <button v-else type="button" class="danger" @click="cancelHash">Cancel</button>
        <label class="check">
          <input type="checkbox" v-model="includeHidden" :disabled="store.hashJob.running" /> hidden
        </label>
        <label class="check">
          <input type="checkbox" v-model="followSymlinks" :disabled="store.hashJob.running" /> follow symlinks
        </label>
      </div>

      <p class="progress" :class="store.hashJob.phase">{{ store.hashJob.progressText }}</p>

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
        <span class="spacer"></span>
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

      <FolderPicker
        v-if="picker.open"
        :start-path="path"
        @close="picker.open = false"
        @select="chooseFolder"
      />

      <HashDetail v-if="detail" :entry="detail" :kind="detailKind" @close="detail = null" />
    </section>
  `,
};