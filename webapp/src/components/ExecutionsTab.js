/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "Executions" tab: every published execution receipt, newest first.
 *
 * A receipt is one immutable file in data/executions/ that a team member
 * commits next to the generated files. The server checks each receipt
 * against git and reports a status:
 *
 *   valid         inputs and outputs still match the receipt
 *   stale-inputs  an input changed after the receipt - the agent must run again
 *   diverged      an output changed without a new receipt (hand-edit?)
 *   unknown       no workspace configured, or git is unavailable
 *
 * Recording happens in the Link Changes tab, where the file selection lives.
 */
import { computed, onMounted, ref, watch } from 'vue';
import { loadExecutions, store } from '../store.js';
import { formatTime } from '../format.js';
import DataTable from './DataTable.js';

const STATUS_LABEL = {
  valid: 'valid',
  'stale-inputs': 'inputs changed',
  diverged: 'diverged',
  unknown: 'unknown',
};

const STATUS_CLASS = {
  valid: 'badge latest-badge',
  'stale-inputs': 'badge changed-badge',
  diverged: 'badge bad',
  unknown: 'badge',
};

const columns = [
  {
    key: 'recordedAt',
    label: 'Recorded',
    value: (row) => row.recordedAt,
    text: (row) => formatTime(row.recordedAt),
    title: (row) => row.recordedAt,
  },
  { key: 'agent', label: 'Agent', className: 'mono' },
  { key: 'status', label: 'Status', sortable: false },
  {
    key: 'inputs',
    label: 'Inputs',
    align: 'right',
    value: (row) => (row.inputs ?? []).length,
    title: (row) => (row.inputs ?? []).map((entry) => entry.path).join('\n') || 'no inputs',
  },
  {
    key: 'outputs',
    label: 'Outputs',
    align: 'right',
    value: (row) => (row.outputs ?? []).length,
    title: (row) => (row.outputs ?? []).map((entry) => entry.path).join('\n'),
  },
  {
    key: 'id',
    label: 'Receipt',
    className: 'mono',
    title: (row) => `data/executions/${row.id}.json`,
  },
];

export default {
  name: 'ExecutionsTab',
  components: { DataTable },
  setup() {
    const error = ref('');

    const reload = async () => {
      error.value = '';
      try {
        await loadExecutions();
      } catch (err) {
        error.value = err.message;
      }
    };

    onMounted(() => {
      if (!store.executions.loaded) reload();
    });

    // After a data-folder switch the loader already ran inside reloadAll();
    // this only clears a stale error. Watching revision covers the rest.
    watch(() => store.revision, () => { error.value = ''; });

    const rows = computed(() => store.executions.list);
    const broken = computed(() => store.executions.broken);

    const summary = computed(() => {
      const valid = rows.value.filter((row) => row.status === 'valid').length;
      const total = rows.value.length;
      return `${valid} / ${total} receipt${total === 1 ? '' : 's'} valid`;
    });

    return {
      broken,
      columns,
      error,
      reload,
      rows,
      statusClass: (row) => STATUS_CLASS[row.status] ?? 'badge',
      statusLabel: (row) => STATUS_LABEL[row.status] ?? row.status,
      store,
      summary,
    };
  },
  template: `
    <section class="panel">
      <div class="toolbar">
        <button type="button" @click="reload" :disabled="store.executions.loading">Reload</button>
        <span class="spacer"></span>
        <span class="badge">{{ summary }}</span>
      </div>

      <p v-if="error" class="setting-error">{{ error }}</p>

      <div v-if="!store.executions.configured" class="panel-note warn">
        No workspace configured — receipt statuses cannot be checked against git.
        Set the workspace folder and git root in the <em>Settings</em> tab.
      </div>

      <div v-else class="panel-note">
        Receipts are written from the <em>Link Changes</em> tab and committed to git
        together with the generated files. An unpushed receipt does not exist for the
        rest of the team.
      </div>

      <p v-for="file in broken" :key="file" class="setting-error">
        Receipt <span class="mono">{{ file }}</span> cannot be read.
      </p>

      <DataTable
        :columns="columns"
        :rows="rows"
        row-key="id"
        default-sort="recordedAt"
        default-dir="desc"
        empty-text="No execution receipts yet — record one from the Link Changes tab."
      >
        <template #cell-status="{ row }">
          <span :class="statusClass(row)">{{ statusLabel(row) }}</span>
        </template>
      </DataTable>
    </section>
  `,
};
