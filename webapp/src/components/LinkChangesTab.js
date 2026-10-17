/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Link Changes to Agent: uncommitted git files inside the workspace folder,
 * selectable, linked to an agent's result_generated_files as paths relative to
 * the workspace git root.
 */
import { computed, onMounted, ref, watch } from 'vue';
import DataTable from './DataTable.js';
import { formatBytes } from '../format.js';
import * as api from '../api.js';
import { loadAgents, setBanner, store } from '../store.js';

const SELECT_COLUMN = { key: 'select', label: '', sortable: false, text: () => '', className: 'col-select' };

const columns = [
  SELECT_COLUMN,
  { key: 'path', label: 'File (relative to git root)', className: 'mono' },
  { key: 'status', label: 'Status', value: (row) => row.status },
  { key: 'workspacePath', label: 'In workspace', className: 'mono' },
  { key: 'size', label: 'Size', align: 'right', value: (row) => row.size ?? 0, text: (row) => formatBytes(row.size) },
];

export default {
  name: 'LinkChangesTab',
  components: { DataTable },
  setup() {
    const loading = ref(false);
    const linking = ref(false);
    const error = ref('');
    const info = ref(null);
    const rows = ref([]);
    const selected = ref(new Set());
    const selectedAgent = ref('');

    const configured = computed(() => info.value?.configured === true);
    const selectedPaths = computed(() => rows.value.filter((row) => selected.value.has(row.path)).map((row) => row.path));
    const allSelected = computed(() => rows.value.length > 0 && selectedPaths.value.length === rows.value.length);
    const agentOptions = computed(() => store.agents.list);

    onMounted(async () => {
      if (!store.agents.loaded) await loadAgents().catch((err) => setBanner('error', err.message));
      await reload();
    });

    // The workspace folder and git root come from Settings. Whenever one of
    // them is saved, re-ask git so this list matches the new workspace without
    // the user having to press Refresh.
    watch(
      () => store.settings.revision,
      () => {
        reload();
      },
    );

    async function reload() {
      loading.value = true;
      error.value = '';
      try {
        const data = await api.getChanges();
        info.value = data;
        rows.value = data.configured ? data.files : [];
        // Keep the selection for paths that are still listed, drop the rest.
        const visible = new Set(rows.value.map((row) => row.path));
        selected.value = new Set([...selected.value].filter((path) => visible.has(path)));
      } catch (err) {
        error.value = err.message;
        info.value = null;
        rows.value = [];
      } finally {
        loading.value = false;
      }
    }

    const toggle = (path) => {
      const next = new Set(selected.value);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      selected.value = next;
    };

    const selectAll = () => {
      selected.value = new Set(rows.value.map((row) => row.path));
    };

    const selectNone = () => {
      selected.value = new Set();
    };

    async function link() {
      const paths = selectedPaths.value;
      if (selectedAgent.value === '' || paths.length === 0) return;
      linking.value = true;
      error.value = '';
      try {
        const result = await api.linkFiles(selectedAgent.value, paths);
        await loadAgents();
        const parts = [`${result.added.length} added`];
        if (result.alreadyPresent > 0) parts.push(`${result.alreadyPresent} already listed`);
        parts.push(`in data/agents/${result.agent.code}.json`);
        setBanner('info', `Linked ${result.added.length} folder(s): ${parts.join(', ')}.`);
      } catch (err) {
        error.value = err.message;
        setBanner('error', `Could not link the files: ${err.message}`);
      } finally {
        linking.value = false;
      }
    }

    return {
      allSelected,
      agentOptions,
      columns,
      configured,
      error,
      info,
      link,
      linking,
      loading,
      reload,
      rows,
      selectAll,
      selectNone,
      selected,
      selectedAgent,
      selectedPaths,
      store,
      toggle,
    };
  },
  template: `
    <section class="panel">
      <div v-if="loading" class="panel-note">Asking git for uncommitted changes …</div>

      <div v-else-if="!configured" class="panel-note warn">
        <strong>No workspace configured.</strong>
        Set both the workspace folder and the workspace git root in the
        <em>Settings</em> tab - this tab lists the files git still reports as
        changed or untracked inside that folder.
      </div>

      <div v-else class="panel-note">
        Uncommitted changes in <span class="mono">{{ info.workspaceFolder }}</span>
        (git root <span class="mono">{{ info.gitRoot }}</span>).
        Paths are relative to the git root.
      </div>

      <p v-if="error" class="setting-error">{{ error }}</p>

      <template v-if="configured">
        <div class="toolbar">
          <button type="button" @click="reload" :disabled="loading">Refresh</button>
          <button type="button" @click="selectAll" :disabled="rows.length === 0">Select all</button>
          <button type="button" @click="selectNone" :disabled="selected.size === 0">Select none</button>
          <span class="spacer"></span>
          <span class="badge">{{ rows.length }} changed</span>
          <span class="badge">{{ selected.size }} selected</span>
        </div>

        <DataTable
          :columns="columns"
          :rows="rows"
          row-key="path"
          default-sort="path"
          empty-text="Nothing uncommitted in the workspace folder."
        >
          <template #cell-select="{ row }">
            <input
              type="checkbox"
              class="row-check"
              :checked="selected.has(row.path)"
              :aria-label="'Select ' + row.path"
              @change="toggle(row.path)"
            />
          </template>
        </DataTable>

        <div class="link-panel">
          <div class="link-row">
            <label for="link-agent">Link changes to agent</label>
            <select id="link-agent" v-model="selectedAgent" class="agent-select" :disabled="linking">
              <option value="">Choose an agent …</option>
              <option v-for="agent in agentOptions" :key="agent.code" :value="agent.code">
                {{ agent.code }} — {{ agent.name }}
              </option>
            </select>
            <button
              type="button"
              class="primary"
              @click="link"
              :disabled="linking || selectedAgent === '' || selected.size === 0"
            >Link changes to agent</button>
          </div>
          <p class="link-note">
            Selected files are appended to <span class="mono">result_generated_files</span> of the chosen
            agent, as paths relative to the git root. Files that are already listed are skipped.
            <span v-if="selectedAgent">
              Agent file: <span class="mono">data/agents/{{ selectedAgent }}.json</span>
            </span>
          </p>
        </div>
      </template>
    </section>
  `,
};