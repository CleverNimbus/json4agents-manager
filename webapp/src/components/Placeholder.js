export default {
  props: {
    title: { type: String, required: true },
    hint: { type: String, default: '' },
  },
  template: `
  <div class="tab-panel">
    <div class="placeholder">
      <h3>{{ title }}</h3>
      <p v-if="hint">{{ hint }}</p>
      <div class="ph-box">Not implemented yet.</div>
    </div>
  </div>`,
};
