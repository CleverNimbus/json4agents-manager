import { state, openFile } from '../store.js';
import AgentModal from './AgentModal.js';

export default {
  components: { AgentModal },
  setup() {
    return { state, openFile };
  },
  data() {
    return { modal: null };
  },
  computed: {
    rows() {
      return state.agents;
    },
  },
  methods: {
    openView(i) {
      this.modal = { mode: 'view', index: i };
    },
    openCreate() {
      this.modal = { mode: 'create' };
    },
    closeModal() {
      this.modal = null;
    },
  },
  template: `
  <div class="tab-panel">
    <div class="toolbar">
      <div class="file-info">
        <strong>File:</strong> {{ state.fileName }}
        <span v-if="state.dirty" class="badge warn">unsaved</span>
      </div>
      <div class="toolbar-actions">
        <button v-if="state.fsSupported" @click="openFile">Open JSON file&hellip;</button>
        <button class="primary" @click="openCreate">+ New Agent</button>
      </div>
    </div>

    <div v-if="state.error" class="banner error">{{ state.error }}</div>
    <div v-else-if="state.loading" class="banner">Loading&hellip;</div>

    <table class="grid">
      <thead>
        <tr>
          <th>Code</th>
          <th>Name</th>
          <th>Description</th>
          <th>Phase</th>
          <th>Parent</th>
          <th>Source files</th>
          <th>Result files</th>
          <th>Executions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(a, i) in rows" :key="a.code + '-' + i" @click="openView(i)">
          <td class="mono">{{ a.code }}</td>
          <td>{{ a.name }}</td>
          <td class="desc">{{ a.description || '&mdash;' }}</td>
          <td>{{ a.phase }}</td>
          <td class="mono">{{ a.parent || '&mdash;' }}</td>
          <td>{{ a.source_dependant_files.length }}</td>
          <td>{{ a.result_generated_files.length }}</td>
          <td>{{ a.executions.length }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="8" class="empty">No agents. Click &ldquo;+ New Agent&rdquo;.</td>
        </tr>
      </tbody>
    </table>

    <AgentModal
      v-if="modal"
      :key="modal.mode + '-' + (modal.index != null ? modal.index : 'new')"
      :mode="modal.mode"
      :index="modal.index"
      :agent="modal.index != null ? rows[modal.index] : null"
      @close="closeModal"
    />
  </div>`,
};
