/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { store } from '../store.js';

/** Fields that get a textarea instead of a single line input. */
const MULTILINE = new Set(['description', 'notes']);

const isArrayOfStrings = (definition) =>
  definition?.type === 'array' &&
  (Array.isArray(definition.items) ? definition.items : [definition.items]).some((item) => item?.type === 'string');

function emptyValue(definition) {
  if (!definition) return '';
  if (definition.type === 'array') return [];
  if (definition.type === 'number') return 0;
  if (definition.type === 'boolean') return false;
  return '';
}

export default {
  name: 'AgentModal',
  props: {
    /** Record being edited, or null when adding a new one. */
    agent: { type: Object, default: null },
    /** Code of the file being edited, '' when adding a new record. */
    previousCode: { type: String, default: '' },
    codes: { type: Array, default: () => [] },
    /** Parent handlers: they return promises and rethrow validation errors. */
    onSave: { type: Function, required: true },
    onDelete: { type: Function, required: true },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const draft = reactive({});
    const texts = reactive({});
    const localErrors = ref([]);
    const serverErrors = ref([]);
    const busy = ref(false);
    const confirmingDelete = ref(false);

    const definition = computed(() => store.schema?.$defs?.agent ?? { properties: {} });
    const requiredKeys = computed(() => new Set(definition.value.required ?? []));

    const fields = computed(() =>
      Object.entries(definition.value.properties ?? {}).map(([key, def]) => {
        const array = isArrayOfStrings(def);
        return {
          key,
          array,
          type: array ? 'array' : def?.type ?? 'string',
          required: requiredKeys.value.has(key),
          hint: def?.description ?? '',
          textarea: array || MULTILINE.has(key),
        };
      }),
    );

    // Seed the form from the edited record (or from empty defaults).
    for (const [key, def] of Object.entries(definition.value.properties ?? {})) {
      const current = props.agent?.[key];
      const value = current === undefined ? emptyValue(def) : current;
      if (Array.isArray(value)) {
        draft[key] = [];
        texts[key] = value.join('\n');
      } else {
        draft[key] = value;
        texts[key] = value === null || value === undefined ? '' : String(value);
      }
    }

    function buildAgent() {
      const agent = {};
      for (const field of fields.value) {
        if (field.array) {
          agent[field.key] = texts[field.key]
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
        } else if (field.textarea) {
          agent[field.key] = texts[field.key];
        } else if (field.type === 'number') {
          agent[field.key] = Number(draft[field.key]);
        } else {
          agent[field.key] = String(draft[field.key] ?? '');
        }
      }
      return agent;
    }

    function validateDraft() {
      const errors = [];
      for (const field of fields.value) {
        const raw = field.array || field.textarea ? texts[field.key] : draft[field.key];
        const empty = field.array
          ? texts[field.key].trim() === ''
          : typeof raw === 'string'
            ? raw.trim() === ''
            : raw === undefined || raw === null || raw === '';
        if (field.required && empty) errors.push({ path: field.key, message: 'is required' });
        if (field.type === 'number' && !empty && !Number.isFinite(Number(raw))) {
          errors.push({ path: field.key, message: 'must be a number' });
        }
      }
      return errors;
    }

    function issuesOf(err) {
      return err?.body?.errors ?? [{ path: '/', message: err?.message ?? 'Save failed' }];
    }

    async function save() {
      serverErrors.value = [];
      localErrors.value = validateDraft();
      if (localErrors.value.length > 0) return;

      busy.value = true;
      try {
        await props.onSave({ previousCode: props.previousCode, agent: buildAgent() });
      } catch (err) {
        serverErrors.value = issuesOf(err);
      } finally {
        busy.value = false;
      }
    }

    async function remove() {
      if (!confirmingDelete.value) {
        confirmingDelete.value = true;
        return;
      }
      busy.value = true;
      try {
        await props.onDelete(props.previousCode);
      } catch (err) {
        serverErrors.value = issuesOf(err);
        confirmingDelete.value = false;
      } finally {
        busy.value = false;
      }
    }

    function close() {
      if (!busy.value) emit('close');
    }

    const onKeydown = (event) => {
      if (event.key === 'Escape') close();
    };
    onMounted(() => window.addEventListener('keydown', onKeydown));
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    return {
      busy,
      close,
      codes: props.codes,
      confirmingDelete,
      fields,
      isNew: computed(() => props.previousCode === ''),
      localErrors,
      previousCode: computed(() => props.previousCode),
      remove,
      renaming: computed(() => props.previousCode !== '' && String(draft.code ?? '') !== props.previousCode),
      save,
      serverErrors,
      store,
      texts,
      draft,
    };
  },
  template: `
    <div class="modal-backdrop" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2>{{ isNew ? 'New agent' : 'Edit ' + (agent.code || 'agent') }}</h2>
          <button type="button" class="icon" title="Close (Esc)" @click="close">✕</button>
        </header>

        <div class="modal-body">
          <p class="modal-note">
            Fields come from agents.schema.json. Saving writes
            <span class="mono">{{ store.agents.dir }}/{{ draft.code || '&lt;code&gt;' }}.json</span>
            — the server validates the record and rejects anything that does not match the schema.
          </p>
          <p v-if="renaming" class="rename-note">
            Changing the code to <span class="mono">{{ draft.code }}</span> renames
            <span class="mono">{{ previousCode }}.json</span> to <span class="mono">{{ draft.code }}.json</span>.
          </p>

          <div class="field" v-for="field in fields" :key="field.key">
            <label :for="'f-' + field.key">
              <span class="mono">{{ field.key }}</span>
              <span class="type-chip">{{ field.array ? 'string[]' : field.type }}</span>
              <span v-if="field.required" class="req">required</span>
            </label>
            <p v-if="field.hint" class="hint">{{ field.hint }}</p>

            <textarea
              v-if="field.textarea"
              :id="'f-' + field.key"
              v-model="texts[field.key]"
              rows="3"
              :placeholder="field.array ? 'one entry per line' : ''"
            ></textarea>
            <input
              v-else-if="field.type === 'number'"
              :id="'f-' + field.key"
              v-model="draft[field.key]"
              type="number"
              step="any"
            />
            <input
              v-else
              :id="'f-' + field.key"
              v-model="draft[field.key]"
              type="text"
              :list="field.key === 'parent' ? 'agent-codes' : undefined"
            />
          </div>

          <datalist id="agent-codes">
            <option v-for="code in codes" :key="code" :value="code"></option>
          </datalist>

          <div v-if="localErrors.length || serverErrors.length" class="form-errors">
            <p class="form-errors-title">Nothing was saved:</p>
            <ul>
              <li v-for="(err, i) in localErrors" :key="'local-' + i">{{ err.path }} {{ err.message }}</li>
              <li v-for="(err, i) in serverErrors" :key="'server-' + i">{{ err.path }} {{ err.message }}</li>
            </ul>
          </div>
        </div>

        <footer class="modal-foot">
          <button type="button" class="danger" v-if="!isNew" @click="remove">
            {{ confirmingDelete ? 'Confirm delete' : 'Delete' }}
          </button>
          <span class="spacer"></span>
          <button type="button" @click="close">Cancel</button>
          <button type="button" class="primary" :disabled="busy" @click="save">Save</button>
        </footer>
      </div>
    </div>
  `,
};