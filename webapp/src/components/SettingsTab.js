/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, reactive, ref } from 'vue';
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
  components: { FolderPicker },
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

    return {
      chooseDataFolder,
      chooseFolder,
      clearAll,
      dataFolder,
      dataFolderDirty,
      dataFolderError,
      dataFolderPicker,
      dataFolderSaving,
      errors,
      FIELDS,
      formatTime,
      isDirty,
      openPicker,
      persist,
      persistDataFolder,
      picker,
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
    </section>
  `,
};