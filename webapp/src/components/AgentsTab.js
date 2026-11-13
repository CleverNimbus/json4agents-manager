/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import { computed, ref } from 'vue';
import DataTable from './DataTable.js';
import { summariseList } from '../format.js';
import { loadAgents, setBanner, store } from '../store.js';

const listText = (row, key) => (row[key] ?? []).join(', ');
const listValue = (row, key) => (row[key] ?? []).length;

const column = (key, label, className) => ({
  key,
  label,
  value: (row) => listValue(row, key),
  text: (row) => summariseList(row[key]),
  title: (row) => (row[key] ?? []).join('\n'),
  className,
});

const columns = [
  { key: 'code', label: 'Code', className: 'mono' },
  { key: 'execution_mode', label: 'Execution mode' },
  column('information_sources', 'Input sources', 'col-wide'),
  column('information_outputs', 'Outputs', 'col-wide'),
  column('generated_document_types', 'Document types', 'col-wide'),
];

export default {
  name: 'AgentsTab',
  components: { DataTable },
  setup() {
    const filter = ref('');
    const showError = (err) => setBanner('error', err.message);
    if (!store.agents.loaded) loadAgents().catch(showError);

    const visibleRows = computed(() => {
      const needle = filter.value.trim().toLowerCase();
      const rows = store.agents.list;
      if (needle === '') return rows;
      return rows.filter((row) =>
        [row.code, row.execution_mode, listText(row, 'information_sources'), listText(row, 'information_outputs'), listText(row, 'generated_document_types')]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      );
    });

    return { columns, filter, reload: () => loadAgents().catch(showError), store, visibleRows };
  },
  template: `
    <section class="panel">
      <div class="toolbar">
        <button type="button" @click="reload" :disabled="store.agents.loading">Reload</button>
        <input v-model="filter" class="filter" type="search" placeholder="Filter by code, mode, sources …" />
        <span class="spacer"></span>
        <span class="badge" :class="{ bad: !store.agents.valid }">
          {{ visibleRows.length }} / {{ store.agents.list.length }} agents
        </span>
        <span v-if="!store.agents.valid" class="badge bad" :title="store.agents.errors.map(e => e.path + ' ' + e.message).join('\\n')">
          issues: {{ store.agents.errors.length }}
        </span>
      </div>

      <DataTable
        :columns="columns"
        :rows="visibleRows"
        row-key="code"
        default-sort="code"
        empty-text="No agent files - add <CODE>.md files to the agents folder."
      />
    </section>
  `,
};
