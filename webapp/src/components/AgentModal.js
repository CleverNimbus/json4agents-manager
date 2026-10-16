import { state, addAgent, updateAgent, deleteAgent } from '../store.js';

export default {
  props: {
    mode: { type: String, required: true }, // 'view' | 'edit' | 'create'
    index: { type: Number, default: null },
    agent: { type: Object, default: null },
  },
  emits: ['close'],
  data() {
    return {
      editing: false,
      error: null,
      form: this.emptyForm(),
    };
  },
  computed: {
    title() {
      if (this.mode === 'create') return 'New Agent';
      if (this.editing) return 'Edit Agent';
      return this.agent ? this.agent.name || this.agent.code : '';
    },
  },
  created() {
    if (this.mode === 'create') {
      this.editing = true;
    }
  },
  methods: {
    emptyForm() {
      return {
        code: '',
        name: '',
        description: '',
        notes: '',
        phase: 0,
        parent: '',
        sourceDeps: '',
        resultFiles: '',
        executions: '',
      };
    },
    fillFromAgent(a) {
      this.form = {
        code: a.code ?? '',
        name: a.name ?? '',
        description: a.description ?? '',
        notes: a.notes ?? '',
        phase: a.phase ?? 0,
        parent: a.parent ?? '',
        sourceDeps: (a.source_dependant_files || []).join('\n'),
        resultFiles: (a.result_generated_files || []).join('\n'),
        executions: (a.executions || []).join('\n'),
      };
    },
    startEdit() {
      this.fillFromAgent(this.agent);
      this.editing = true;
    },
    cancel() {
      if (this.mode === 'create') {
        this.$emit('close');
      } else {
        this.editing = false;
        this.error = null;
      }
    },
    close() {
      this.$emit('close');
    },
    toLines(s) {
      return s
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    },
    async save() {
      const code = this.form.code.trim();
      if (!code) {
        this.error = 'Code is required.';
        return;
      }
      const phase = Number(this.form.phase);
      if (this.form.phase === '' || Number.isNaN(phase)) {
        this.error = 'Phase must be a number.';
        return;
      }
      const agent = {
        code,
        name: this.form.name.trim(),
        description: this.form.description.trim(),
        notes: this.form.notes.trim(),
        phase,
        parent: this.form.parent.trim(),
        source_dependant_files: this.toLines(this.form.sourceDeps),
        result_generated_files: this.toLines(this.form.resultFiles),
        executions: this.toLines(this.form.executions),
      };

      const duplicate =
        this.mode === 'create'
          ? state.agents.some((a) => a.code === code)
          : state.agents.some((a, i) => i !== this.index && a.code === code);
      if (duplicate) {
        this.error = 'Code must be unique.';
        return;
      }

      try {
        if (this.mode === 'create') {
          await addAgent(agent);
        } else {
          await updateAgent(this.index, agent);
        }
        this.$emit('close');
      } catch (e) {
        this.error = 'Save failed: ' + e.message;
      }
    },
    async doDelete() {
      if (!window.confirm('Delete agent "' + this.agent.code + '"?')) return;
      this.$emit('close');
      await deleteAgent(this.index);
    },
  },
  template: `
  <div class="modal-overlay" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <h2>{{ title }}</h2>
        <button class="icon" @click="close" title="Close">&times;</button>
      </div>

      <div v-if="error" class="banner error">{{ error }}</div>

      <div v-if="mode === 'view' && !editing && agent" class="detail">
        <dl>
          <dt>Code</dt><dd class="mono">{{ agent.code }}</dd>
          <dt>Name</dt><dd>{{ agent.name }}</dd>
          <dt>Description</dt><dd>{{ agent.description || '&mdash;' }}</dd>
          <dt>Notes</dt><dd class="pre">{{ agent.notes || '&mdash;' }}</dd>
          <dt>Phase</dt><dd>{{ agent.phase }}</dd>
          <dt>Parent</dt><dd class="mono">{{ agent.parent || '&mdash;' }}</dd>
          <dt>Source files ({{ agent.source_dependant_files.length }})</dt>
          <dd>
            <ul v-if="agent.source_dependant_files.length">
              <li v-for="f in agent.source_dependant_files" :key="f" class="mono">{{ f }}</li>
            </ul>
            <span v-else class="dim">&mdash;</span>
          </dd>
          <dt>Result files ({{ agent.result_generated_files.length }})</dt>
          <dd>
            <ul v-if="agent.result_generated_files.length">
              <li v-for="f in agent.result_generated_files" :key="f" class="mono">{{ f }}</li>
            </ul>
            <span v-else class="dim">&mdash;</span>
          </dd>
          <dt>Executions ({{ agent.executions.length }})</dt>
          <dd>
            <ul v-if="agent.executions.length">
              <li v-for="e in agent.executions" :key="e" class="mono">{{ e }}</li>
            </ul>
            <span v-else class="dim">&mdash;</span>
          </dd>
        </dl>
        <div class="modal-actions">
          <button @click="startEdit">Edit</button>
          <button class="danger" @click="doDelete">Delete</button>
          <button @click="close">Close</button>
        </div>
      </div>

      <form v-else @submit.prevent="save" class="form">
        <label>Code <input v-model="form.code" required /></label>
        <label>Name <input v-model="form.name" /></label>
        <label>Description <input v-model="form.description" /></label>
        <label>Notes
          <textarea v-model="form.notes" rows="3" placeholder="free-form notes"></textarea>
        </label>
        <label>Phase <input type="number" v-model.number="form.phase" /></label>
        <label>Parent <input v-model="form.parent" placeholder="empty = root" /></label>
        <label>Source dependent files
          <textarea v-model="form.sourceDeps" rows="4" placeholder="one per line"></textarea>
        </label>
        <label>Result generated files
          <textarea v-model="form.resultFiles" rows="4" placeholder="one per line"></textarea>
        </label>
        <label>Executions
          <textarea v-model="form.executions" rows="3" placeholder="ISO date-time, one per line"></textarea>
        </label>
        <div class="modal-actions">
          <button type="submit" class="primary">Save</button>
          <button type="button" @click="cancel">Cancel</button>
        </div>
      </form>
    </div>
  </div>`,
};
