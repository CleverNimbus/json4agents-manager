import { computed, reactive, ref } from 'vue';
import FolderPicker from './FolderPicker.js';
import { formatTime } from '../format.js';
import { clearBanner, loadSettings, saveSettings, setBanner, store } from '../store.js';

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

    loadSettings()
      .then((settings) => {
        for (const field of FIELDS) {
          if (values[field.key] === '') values[field.key] = settings[field.key] ?? '';
        }
      })
      .catch((err) => setBanner('error', err.message));

    const savedAt = computed(() => (store.settings.updatedAt ? formatTime(store.settings.updatedAt) : ''));
    const isDirty = computed(() => FIELDS.some((field) => values[field.key].trim() !== (store.settings[field.key] ?? '')));

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

    return {
      chooseFolder,
      clearAll,
      errors,
      FIELDS,
      formatTime,
      isDirty,
      openPicker,
      persist,
      picker,
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

      <FolderPicker
        v-if="picker.open"
        :start-path="values[picker.field]"
        @close="picker.open = false"
        @select="chooseFolder"
      />
    </section>
  `,
};