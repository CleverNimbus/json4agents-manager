import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { listFolder } from '../api.js';
import { formatBytes } from '../format.js';

export default {
  name: 'FolderPicker',
  props: {
    startPath: { type: String, default: '' },
  },
  emits: ['close', 'select'],
  setup(props, { emit }) {
    const listing = reactive({ path: '', parent: null, entries: [] });
    const typedPath = ref(props.startPath || '');
    const selected = ref('');
    const showHidden = ref(true);
    const loading = ref(false);
    const error = ref('');

    async function load(target) {
      loading.value = true;
      error.value = '';
      try {
        const data = await listFolder(target);
        listing.path = data.path;
        listing.parent = data.parent;
        listing.entries = data.entries;
        typedPath.value = data.path;
        selected.value = data.path;
      } catch (err) {
        error.value = err.message;
      } finally {
        loading.value = false;
      }
    }

    const directories = computed(() =>
      listing.entries.filter((entry) => (entry.kind === 'directory' || entry.kind === 'link') && (showHidden.value || !entry.hidden)),
    );
    const files = computed(() =>
      listing.entries.filter((entry) => !(entry.kind === 'directory' || entry.kind === 'link') && (showHidden.value || !entry.hidden)),
    );

    function choose(path) {
      emit('select', path);
    }

    const onKeydown = (event) => {
      if (event.key === 'Escape') emit('close');
    };
    onMounted(() => {
      window.addEventListener('keydown', onKeydown);
      load(props.startPath || '');
    });
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    return {
      choose,
      directories,
      error,
      files,
      formatBytes,
      listing,
      load,
      loading,
      selected,
      showHidden,
      typedPath,
    };
  },
  template: `
    <div class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal picker" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>Choose folder</h2>
          <button type="button" class="icon" title="Close (Esc)" @click="$emit('close')">✕</button>
        </header>

        <div class="picker-bar">
          <input v-model="typedPath" class="mono" type="text" placeholder="/absolute/path" @keyup.enter="load(typedPath)" />
          <button type="button" @click="load(typedPath)">Go</button>
          <button type="button" @click="listing.parent && load(listing.parent)" :disabled="!listing.parent">Up</button>
          <label class="check"><input type="checkbox" v-model="showHidden" /> hidden</label>
        </div>

        <p class="picker-current mono" :title="listing.path">{{ listing.path }}</p>
        <p v-if="error" class="picker-error">{{ error }}</p>

        <div class="picker-list">
          <p v-if="loading" class="picker-empty">Loading …</p>
          <div
            v-for="entry in directories"
            :key="entry.path"
            class="picker-row"
            :class="{ selected: entry.path === selected }"
            @click="selected = entry.path"
            @dblclick="load(entry.path)"
          >
            <span class="picker-icon">📁</span>
            <span class="picker-name">{{ entry.name }}</span>
          </div>
          <div
            v-for="entry in files"
            :key="entry.path"
            class="picker-row file"
            :title="entry.size !== undefined ? formatBytes(entry.size) : ''"
            @click="load(entry.path)"
          >
            <span class="picker-icon">📄</span>
            <span class="picker-name">{{ entry.name }}</span>
            <span class="picker-size">{{ formatBytes(entry.size) }}</span>
          </div>
          <p v-if="!loading && directories.length === 0 && files.length === 0" class="picker-empty">
            This folder is empty.
          </p>
          <p v-if="!loading && !directories.length && files.length > 0" class="picker-empty">
            No subfolders — pick a file above to open its folder.
          </p>
        </div>

        <footer class="modal-foot">
          <span class="picker-hint">Click a folder to select it, double click to enter it.</span>
          <span class="spacer"></span>
          <button type="button" @click="$emit('close')">Cancel</button>
          <button type="button" class="primary" @click="choose(selected || listing.path)">Use this folder</button>
        </footer>
      </div>
    </div>
  `,
};