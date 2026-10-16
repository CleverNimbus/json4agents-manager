import { state } from './store.js';
import DisplayTab from './components/DisplayTab.js';
import SourceHashTab from './components/SourceHashTab.js';
import Placeholder from './components/Placeholder.js';

export default {
  components: { DisplayTab, SourceHashTab, Placeholder },
  setup() {
    return { state };
  },
  data() {
    return { active: 'display' };
  },
  template: `
  <div class="app">
    <header class="app-header">
      <h1>JSON Manager</h1>
      <span v-if="!state.fsSupported" class="badge warn">read-only mode &mdash; saves by download</span>
    </header>

    <nav class="tabs">
      <button :class="{ active: active === 'display' }" @click="active = 'display'">Display</button>
      <button :class="{ active: active === 'hash' }" @click="active = 'hash'">Source Hash</button>
      <button :class="{ active: active === 'config' }" @click="active = 'config'">App Configuration</button>
    </nav>

    <main>
      <DisplayTab v-show="active === 'display'" />
      <SourceHashTab v-show="active === 'hash'" />
      <Placeholder v-show="active === 'config'" title="App Configuration" hint="Application settings will appear here." />
    </main>
  </div>`,
};
