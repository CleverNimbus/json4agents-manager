/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * "Agent Dependencies" tab: a flowchart drawn by Mermaid where every agent
 * is a node and an arrow from A to B means A produces something B reads.
 * The matching rule (file in folder, folder over file, nested folders) is
 * the server's job; this tab only renders what the API returns.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { loadDependencies, store } from '../store.js';

let mermaidPromise = null;
let mermaidApi = null;
let renderCounter = 0;

/**
 * Mermaid is loaded once and reused. The import goes through the importmap,
 * so the bare specifier "mermaid" resolves to the URL the server publishes
 * from `node_modules/mermaid/dist/`.
 */
function getMermaid() {
  if (mermaidApi) return Promise.resolve(mermaidApi);
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      mermaidApi = mod.default;
      mermaidApi.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'loose',
        flowchart: { curve: 'basis', htmlLabels: true },
      });
      return mermaidApi;
    });
  }
  return mermaidPromise;
}

/** Mermaid's own delimiters are dangerous inside a label. */
function sanitizeNodeLabel(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'");
}
/** Inside `--|label|`, a literal pipe would end the label. */
function sanitizeEdgeLabel(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/');
}

/** Turn the API payload into a Mermaid `flowchart` source string. */
function buildGraphText(agents, edges) {
  if (!agents || agents.length === 0) return '';
  const codeToId = new Map();
  const lines = ['flowchart LR'];
  agents.forEach((agent, index) => {
    const id = `n${index}`;
    codeToId.set(agent.code, id);
    const name = sanitizeNodeLabel(agent.name);
    const label = name ? `${agent.code} — ${name}` : agent.code;
    lines.push(`  ${id}["${label}"]`);
  });
  for (const edge of edges) {
    const fromId = codeToId.get(edge.from);
    const toId = codeToId.get(edge.to);
    if (!fromId || !toId) continue;
    const via = Array.isArray(edge.via) ? edge.via : [];
    if (via.length === 0) {
      lines.push(`  ${fromId} --> ${toId}`);
    } else {
      const first = sanitizeEdgeLabel(via[0].output);
      const more = via.length > 1 ? ` +${via.length - 1}` : '';
      lines.push(`  ${fromId} -->|"${first}${more}"| ${toId}`);
    }
  }
  return lines.join('\n');
}

export default {
  name: 'AgentDependenciesTab',
  setup() {
    const graphEl = ref(null);
    const error = ref('');

    /** Draw whatever is currently in the store. */
    const render = async () => {
      await nextTick();
      const mermaid = await getMermaid();
      if (!graphEl.value) return;
      const text = buildGraphText(store.dependencies.agents, store.dependencies.edges);
      if (text === '') {
        graphEl.value.innerHTML = '';
        return;
      }
      const id = `dep-graph-${++renderCounter}`;
      try {
        const { svg } = await mermaid.render(id, text);
        graphEl.value.innerHTML = svg;
        error.value = '';
      } catch (err) {
        error.value = `Could not render the diagram: ${err.message}`;
      }
    };

    const reload = async () => {
      error.value = '';
      try {
        await loadDependencies();
      } catch (err) {
        error.value = err.message;
      }
      await render();
    };

    onMounted(reload);

    // The data folder reload already ran the loader before bumping
    // `store.revision`, so the graph is fresh; we just need to redraw.
    watch(() => store.revision, render);

    const summary = computed(() => {
      const agentCount = store.dependencies.agents.length;
      const edgeCount = store.dependencies.edges.length;
      return `${agentCount} agent${agentCount === 1 ? '' : 's'} · ${edgeCount} dependenc${edgeCount === 1 ? 'y' : 'ies'}`;
    });

    const isEmpty = computed(() => store.dependencies.agents.length === 0);

    return { error, graphEl, isEmpty, reload, store, summary };
  },
  template: `
    <section class="panel">
      <div class="toolbar">
        <button type="button" @click="reload" :disabled="store.dependencies.loading">Reload</button>
        <span class="spacer"></span>
        <span class="badge">{{ summary }}</span>
      </div>

      <p v-if="error" class="setting-error">{{ error }}</p>

      <div v-if="isEmpty" class="panel-note">
        No agents yet — add some in the <em>Agents</em> tab to see the dependency graph.
      </div>

      <div v-else ref="graphEl" class="dependency-graph"></div>
    </section>
  `,
};
