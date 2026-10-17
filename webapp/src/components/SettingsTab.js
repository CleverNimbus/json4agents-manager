/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, reactive, ref } from 'vue';
import DataTable from './DataTable.js';
import FolderPicker from './FolderPicker.js';
import { formatTime } from '../format.js';
import {
  clearBanner,
  loadDataFolder,
  loadSettings,
  saveDataFolder,
  saveSettings,
  setBanner,
  store,
} from '../store.js';

const FIELDS = [
  {
    key: 'workspaceFolder',
    label: 'Workspace folder',
    placeholder: '/home/you/workspace',
    note: 'The folder this workspace works in. Must be the git root itself or a folder inside it.',
  },
  {
    key: 'gitRoot',
    label: 'Workspace git root location',
    placeholder: '/home/you/projects/repo',
    note: 'The git repository the workspace belongs to. It has to contain a .git folder.',
  },
];

export default {
  name: 'SettingsTab',
  components: { DataTable, FolderPicker },
  setup() {
    const values = reactive({ workspaceFolder: '', gitRoot: '' });
    const saving = ref(false);
    /** Server validation errors keyed by field. */
    const errors = ref({});
    /** Which folder the browse dialog is choosing. */
    const picker = reactive({ open: false, field: '' });

    // Data folder block: a plain string setting, kept apart from the workspace
    // pair because it decides where the other files live.
    const dataFolder = ref('');
    const dataFolderError = ref('');
    const dataFolderSaving = ref(false);
    const dataFolderPicker = reactive({ open: false });

    // Hash folder collection: a list of paths the user wants to hash often. The
    // grid mirrors the store; every add/remove persists via saveSettings.
    const hashFolderDraft = ref('');
    const hashFolderError = ref('');
    const hashFolderSaving = ref(false);
    const hashFolderPicker = reactive({ open: false });
    const hashFolderColumns = [
      { key: 'position', label: '#', align: 'right', className: 'col-index' },
      { key: 'path', label: 'Folder', className: 'mono' },
      { key: 'remove', label: '', sortable: false, className: 'col-remove' },
    ];

    loadSettings()
      .then((settings) => {
        for (const field of FIELDS) {
          if (values[field.key] === '') values[field.key] = settings[field.key] ?? '';
        }
      })
      .catch((err) => setBanner('error', err.message));

    loadDataFolder().then((info) => {
      if (dataFolder.value.trim() === '') dataFolder.value = info.value ?? '';
    });

    const savedAt = computed(() => (store.settings.updatedAt ? formatTime(store.settings.updatedAt) : ''));
    const isDirty = computed(() => FIELDS.some((field) => values[field.key].trim() !== (store.settings[field.key] ?? '')));
    const dataFolderDirty = computed(() => dataFolder.value.trim() !== (store.dataFolder.value ?? ''));

    /** @param {string} message */
    function fail(message) {
      setBanner('error', message);
    }

    /**
     * Save both fields together: they are only valid as a pair, so one save
     * keeps them consistent. Re-saving an unchanged pair is a no-op.
     */
    async function persist() {
      const patch = { workspaceFolder: values.workspaceFolder.trim(), gitRoot: values.gitRoot.trim() };
      if (!isDirty.value) {
        errors.value = {};
        return;
      }
      saving.value = true;
      errors.value = {};
      try {
        await saveSettings(patch);
        clearBanner();
      } catch (err) {
        const list = err.body?.errors;
        if (Array.isArray(list) && list.length > 0) {
          errors.value = Object.fromEntries(list.map((issue) => [issue.field, issue.message]));
          fail('The workspace settings were not saved - see the highlighted fields.');
        } else {
          fail(`Could not save the settings: ${err.message}`);
        }
      } finally {
        saving.value = false;
      }
    }

    const openPicker = (field) => {
      picker.field = field;
      picker.open = true;
    };

    const chooseFolder = async (chosen) => {
      picker.open = false;
      values[picker.field] = chosen;
      await persist();
    };

    /** Clears both fields, which is the only valid "empty" configuration. */
    const clearAll = () => {
      for (const field of FIELDS) values[field.key] = '';
      return persist();
    };

    /**
     * Point the app at another data folder. Everything else on screen is
     * reloaded by saveDataFolder, so every other tab shows the new folder's
     * data as soon as this returns.
     */
    async function persistDataFolder(value = dataFolder.value) {
      const next = String(value).trim();
      dataFolderError.value = '';
      if (next === store.dataFolder.value) {
        dataFolder.value = next;
        return;
      }
      dataFolderSaving.value = true;
      try {
        await saveDataFolder(next);
        dataFolder.value = store.dataFolder.value;
        clearBanner();
        setBanner('info', `Data folder is now ${store.dataFolder.resolved}. Every tab reloaded.`);
      } catch (err) {
        dataFolderError.value = err.message;
        setBanner('error', `Data folder unchanged: ${err.message}`);
      } finally {
        dataFolderSaving.value = false;
      }
    }

    const chooseDataFolder = async (chosen) => {
      dataFolderPicker.open = false;
      dataFolder.value = chosen;
      await persistDataFolder(chosen);
    };

    /** An empty value means "use the default <repo>/data". */
    const resetDataFolder = async () => {
      dataFolder.value = '';
      await persistDataFolder('');
    };

    const hashFolderRows = computed(() => {
      const list = Array.isArray(store.settings.hashFolders) ? store.settings.hashFolders : [];
      return list.map((path, position) => ({ position: position + 1, storeIndex: position, path }));
    });

    /**
     * Save the next state of the hash folder list. Centralises the saving flag
     * and error surface so the grid stays in sync with the store.
     * @param {string[]} next
     */
    async function persistHashFolders(next) {
      hashFolderError.value = '';
      hashFolderSaving.value = true;
      try {
        await saveSettings({ hashFolders: next });
        clearBanner();
      } catch (err) {
        hashFolderError.value = err.message;
        fail(`Could not save the hash folder collection: ${err.message}`);
      } finally {
        hashFolderSaving.value = false;
      }
    }

    /** Append the draft path to the collection, ignoring duplicates and blanks. */
    const addHashFolder = async () => {
      const candidate = hashFolderDraft.value.trim();
      if (candidate === '') {
        hashFolderError.value = 'Pick or type a folder before adding it.';
        return;
      }
      const current = Array.isArray(store.settings.hashFolders) ? store.settings.hashFolders : [];
      if (current.includes(candidate)) {
        hashFolderError.value = 'That folder is already in the collection.';
        return;
      }
      await persistHashFolders([...current, candidate]);
      hashFolderDraft.value = '';
    };

    /** Drop the entry at the given zero-based index from the collection. */
    const removeHashFolder = async (index) => {
      const current = Array.isArray(store.settings.hashFolders) ? store.settings.hashFolders : [];
      if (index < 0 || index >= current.length) return;
      const next = current.filter((_, i) => i !== index);
      await persistHashFolders(next);
    };

    /** Browse-modal result: fill the draft, do not add yet. */
    const chooseHashFolder = (chosen) => {
      hashFolderPicker.open = false;
      hashFolderDraft.value = chosen;
    };

    const openHashFolderPicker = () => {
      hashFolderError.value = '';
      hashFolderPicker.open = true;
    };

    return {
      addHashFolder,
      chooseDataFolder,
      chooseFolder,
      chooseHashFolder,
      clearAll,
      dataFolder,
      dataFolderDirty,
      dataFolderError,
      dataFolderPicker,
      dataFolderSaving,
      errors,
      FIELDS,
      formatTime,
      hashFolderColumns,
      hashFolderDraft,
      hashFolderError,
      hashFolderPicker,
      hashFolderRows,
      hashFolderSaving,
      isDirty,
      openHashFolderPicker,
      openPicker,
      persist,
      persistDataFolder,
      picker,
      removeHashFolder,
      resetDataFolder,
      savedAt,
      saving,
      store,
      values,
    };
  },
  template: `
    <section class="panel">
      <div class="setting-block">
        <header class="setting-head">
          <h2>Workspace folder</h2>
          <span class="badge" v-if="savedAt">saved {{ savedAt }}</span>
          <span class="badge" v-else>not set</span>
        </header>

        <p class="setting-note">
          Both fields are stored in <span class="mono">{{ store.settings.file }}</span>.
          The <em>Link Changes to Agent</em> tab reads them to list the uncommitted git
          files of the workspace folder; nothing else uses them yet.
        </p>

        <div class="setting-field" v-for="field in FIELDS" :key="field.key" :class="{ invalid: errors[field.key] }">
          <label :for="'set-' + field.key">
            <span>{{ field.label }}</span>
            <span class="req">required as a pair</span>
          </label>
          <p class="hint">{{ field.note }}</p>
          <div class="toolbar">
            <input
              :id="'set-' + field.key"
              v-model="values[field.key]"
              class="path-input mono"
              type="text"
              :placeholder="field.placeholder"
              :disabled="saving"
              @keyup.enter="persist"
              @blur="persist"
            />
            <button type="button" @click="openPicker(field.key)" :disabled="saving">Browse…</button>
          </div>
          <p v-if="errors[field.key]" class="setting-error">{{ errors[field.key] }}</p>
        </div>

        <div class="toolbar">
          <button type="button" @click="clearAll" :disabled="saving">Clear both</button>
          <span class="spacer"></span>
          <span class="badge" v-if="isDirty">unsaved changes</span>
          <button type="button" class="primary" @click="persist" :disabled="saving">Save</button>
        </div>
      </div>

      <div class="setting-block">
        <header class="setting-head">
          <h2>Data folder</h2>
          <span class="badge" v-if="store.dataFolder.isDefault">default</span>
          <span class="badge" v-else>custom</span>
          <span class="badge" v-if="store.dataFolder.locked">locked by --data-dir</span>
        </header>

        <p class="setting-note">
          Where the app keeps its JSON files: <span class="mono">agents/</span>,
          <span class="mono">agents.schema.json</span>, <span class="mono">hashes.json</span>,
          <span class="mono">state.json</span> and <span class="mono">settings.json</span>.
          Changing it makes the app read and write somewhere else and reloads every tab.
        </p>

        <div class="setting-field">
          <p class="hint">
            A folder that does not exist yet is created, and a missing
            <span class="mono">agents.schema.json</span> is copied along from the current one.
            Leave the box empty to use <span class="mono">{{ store.dataFolder.defaultDir }}</span>.
          </p>
          <div class="toolbar">
            <input
              id="set-data-folder"
              v-model="dataFolder"
              class="path-input mono"
              type="text"
              placeholder="leave empty for the default"
              :disabled="dataFolderSaving || store.dataFolder.locked"
              @keyup.enter="persistDataFolder()"
              @blur="persistDataFolder()"
            />
            <button type="button" @click="dataFolderPicker.open = true" :disabled="dataFolderSaving || store.dataFolder.locked">
              Browse…
            </button>
            <button type="button" @click="resetDataFolder" :disabled="dataFolderSaving || store.dataFolder.locked || (store.dataFolder.isDefault && !dataFolderDirty)">
              Use default
            </button>
            <span class="spacer"></span>
            <button
              type="button"
              class="primary"
              @click="persistDataFolder()"
              :disabled="dataFolderSaving || store.dataFolder.locked || !dataFolderDirty"
            >Save</button>
          </div>
          <p v-if="dataFolderError" class="setting-error">{{ dataFolderError }}</p>
          <p class="hint setting-resolved">
            In use: <span class="mono">{{ store.dataFolder.resolved }}</span>
            <span v-if="store.dataFolder.pointerFile"> · remembered in <span class="mono">{{ store.dataFolder.pointerFile }}</span></span>
          </p>
        </div>
      </div>

      <div class="setting-block">
        <header class="setting-head">
          <h2>Hash folder collection</h2>
          <span class="badge" v-if="hashFolderRows.length === 0">empty</span>
          <span class="badge" v-else>{{ hashFolderRows.length }} folder<span v-if="hashFolderRows.length !== 1">s</span></span>
        </header>

        <p class="setting-note">
          A list of folders you want to hash often. Stored in
          <span class="mono">{{ store.settings.file }}</span> as
          <span class="mono">hashFolders</span>. No feature reads it yet - this
          is the place to keep them so the rest of the app can.
        </p>

        <div class="setting-field">
          <p class="hint">Type a folder path or pick one with Browse, then press Add to put it in the collection.</p>
          <div class="toolbar">
            <input
              id="set-hash-folder"
              v-model="hashFolderDraft"
              class="path-input mono"
              type="text"
              placeholder="/home/you/projects"
              :disabled="hashFolderSaving"
              @keyup.enter="addHashFolder"
            />
            <button type="button" @click="openHashFolderPicker" :disabled="hashFolderSaving">Browse…</button>
            <button type="button" class="primary" @click="addHashFolder" :disabled="hashFolderSaving || hashFolderDraft.trim() === ''">
              Add to collection
            </button>
          </div>
          <p v-if="hashFolderError" class="setting-error">{{ hashFolderError }}</p>
        </div>

        <DataTable
          :columns="hashFolderColumns"
          :rows="hashFolderRows"
          row-key="path"
          default-sort="position"
          empty-text="No folders yet. Add one above to start the collection."
        >
          <template #cell-remove="{ row }">
            <button
              type="button"
              class="icon"
              :disabled="hashFolderSaving"
              :title="'Remove ' + row.path"
              :aria-label="'Remove ' + row.path"
              @click="removeHashFolder(row.storeIndex)"
            >✕</button>
          </template>
        </DataTable>
      </div>

      <FolderPicker
        v-if="picker.open"
        :start-path="values[picker.field]"
        @close="picker.open = false"
        @select="chooseFolder"
      />

      <FolderPicker
        v-if="dataFolderPicker.open"
        :start-path="dataFolder || store.dataFolder.resolved"
        @close="dataFolderPicker.open = false"
        @select="chooseDataFolder"
      />

      <FolderPicker
        v-if="hashFolderPicker.open"
        :start-path="hashFolderDraft || store.dataFolder.resolved"
        @close="hashFolderPicker.open = false"
        @select="chooseHashFolder"
      />
    </section>
  `,
};