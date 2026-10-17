/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, reactive, ref } from 'vue';
import AgentModal from './AgentModal.js';
import DataTable from './DataTable.js';
import { countOf, formatTime, lastOf, summariseList } from '../format.js';
import { loadAgents, loadSchema, removeAgent, saveAgent, setBanner, store } from '../store.js';

const columns = [
  { key: 'code', label: 'Code', className: 'mono' },
  { key: 'name', label: 'Name' },
  { key: 'phase', label: 'Phase', align: 'right', value: (row) => Number(row.phase) || 0 },
  { key: 'parent', label: 'Parent', text: (row) => row.parent || '—', className: 'mono' },
  { key: 'description', label: 'Description', className: 'col-wide' },
  { key: 'notes', label: 'Notes', className: 'col-wide' },
  {
    key: 'source_dependant_files',
    label: 'Source files',
    value: (row) => countOf(row.source_dependant_files),
    text: (row) => summariseList(row.source_dependant_files),
    title: (row) => (row.source_dependant_files ?? []).join('\n'),
  },
  {
    key: 'result_generated_files',
    label: 'Generated files',
    value: (row) => countOf(row.result_generated_files),
    text: (row) => summariseList(row.result_generated_files),
    title: (row) => (row.result_generated_files ?? []).join('\n'),
  },
  {
    key: 'executions',
    label: 'Executions',
    value: (row) => countOf(row.executions),
    text: (row) =>
      countOf(row.executions) === 0 ? '—' : countOf(row.executions) + ' · last ' + formatTime(lastOf(row.executions)),
    title: (row) => (row.executions ?? []).join('\n'),
  },
  { key: 'actions', label: 'Actions', sortable: false, text: () => '', className: 'col-actions' },
];

export default {
  name: 'AgentsTab',
  components: { AgentModal, DataTable },
  setup() {
    const filter = ref('');
    const pendingDelete = ref('');
    /** `code` is '' for a new record; `open` says whether the popup is shown. */
    const editor = reactive({ open: false, code: '' });

    const showError = (err) => setBanner('error', err.message);
    if (!store.agents.loaded) loadAgents().catch(showError);
    if (!store.schema) loadSchema().catch(showError);

    const visibleRows = computed(() => {
      const needle = filter.value.trim().toLowerCase();
      const rows = store.agents.list;
      if (needle === '') return rows;
      return rows.filter((row) =>
        [row.code, row.name, row.description, row.notes, row.parent]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      );
    });

    const openCreate = () => {
      editor.code = '';
      editor.open = true;
    };

    const openEdit = (row) => {
      editor.code = row.code;
      editor.open = true;
    };

    const handleSave = async ({ previousCode, agent }) => {
      await saveAgent({ previousCode, agent });
      editor.open = false;
      setBanner('info', previousCode === '' ? 'Agent added.' : previousCode === agent.code ? 'Agent updated.' : 'Agent saved under a new code.');
    };

    const handleDelete = async (code) => {
      await removeAgent(code);
      editor.open = false;
      setBanner('info', `Agent ${code} deleted.`);
    };

    /** Two step delete straight from the grid row. */
    const requestDelete = async (row) => {
      if (pendingDelete.value !== row.code) {
        pendingDelete.value = row.code;
        return;
      }
      pendingDelete.value = '';
      try {
        await handleDelete(row.code);
      } catch (err) {
        showError(err);
      }
    };

    return {
      columns,
      editor,
      filter,
      handleDelete,
      handleSave,
      openCreate,
      openEdit,
      pendingDelete,
      requestDelete,
      reload: () => loadAgents().catch(showError),
      store,
      visibleRows,
    };
  },
  template: `
    <section class="panel">
      <div class="toolbar">
        <button type="button" class="primary" @click="openCreate">+ Add agent</button>
        <button type="button" @click="reload" :disabled="store.agents.loading">Reload</button>
        <input v-model="filter" class="filter" type="search" placeholder="Filter by code, name, parent …" />
        <span class="spacer"></span>
        <span class="badge" :class="{ bad: !store.agents.valid }">
          {{ visibleRows.length }} / {{ store.agents.list.length }} agents
        </span>
        <span v-if="!store.agents.valid" class="badge bad" :title="store.agents.errors.map(e => e.path + ' ' + e.message).join('\\n')">
          schema: {{ store.agents.errors.length }} error(s)
        </span>
      </div>

      <DataTable
        :columns="columns"
        :rows="visibleRows"
        row-key="code"
        default-sort="code"
        clickable
        empty-text="No agents yet — use “+ Add agent”."
        @row-click="openEdit"
      >
        <template #cell-actions="{ row }">
          <button type="button" class="mini" @click.stop="openEdit(row)">Edit</button>
          <button type="button" class="mini danger" @click.stop="requestDelete(row)">
            {{ pendingDelete === row.code ? 'Confirm?' : 'Delete' }}
          </button>
        </template>
      </DataTable>

      <AgentModal
        v-if="editor.open"
        :agent="editor.code ? (store.agents.list.find(a => a.code === editor.code) ?? null) : null"
        :previous-code="editor.code"
        :codes="store.agents.list.map(a => a.code)"
        :on-save="handleSave"
        :on-delete="handleDelete"
        @close="editor.open = false"
      />
    </section>
  `,
};