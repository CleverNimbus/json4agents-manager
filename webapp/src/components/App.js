/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import AgentsTab from './AgentsTab.js';
import AgentDependenciesTab from './AgentDependenciesTab.js';
import ExecutionsTab from './ExecutionsTab.js';
import HashingTab from './HashingTab.js';
import LinkChangesTab from './LinkChangesTab.js';
import SettingsTab from './SettingsTab.js';
import { store } from '../store.js';

export default {
  name: 'JsonManagerApp',
  components: { AgentsTab, AgentDependenciesTab, ExecutionsTab, HashingTab, LinkChangesTab, SettingsTab },
  setup() {
    const tabs = [
      { id: 'agents', label: 'Agents' },
      { id: 'dependencies', label: 'Agent Dependencies' },
      { id: 'hashing', label: 'Hashing' },
      { id: 'link', label: 'Link Changes to Agent' },
      { id: 'executions', label: 'Executions' },
      { id: 'settings', label: 'Settings' },
    ];
    return { store, tabs };
  },
  template: `
    <div class="app">
      <header class="topbar">
        <h1 class="brand">JSON Manager</h1>
        <nav class="tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            class="tab"
            :class="{ active: store.activeTab === tab.id }"
            @click="store.activeTab = tab.id"
          >{{ tab.label }}</button>
        </nav>
        <span class="spacer"></span>
        <span class="file-hint">{{ store.agents.dir }}</span>
      </header>

      <p v-if="store.banner" class="banner" :class="store.banner.kind" @click="store.banner = null">
        {{ store.banner.text }}<span class="banner-close">dismiss</span>
      </p>

      <main class="content">
        <AgentsTab v-show="store.activeTab === 'agents'" />
        <AgentDependenciesTab v-show="store.activeTab === 'dependencies'" />
        <HashingTab v-show="store.activeTab === 'hashing'" />
        <LinkChangesTab v-show="store.activeTab === 'link'" />
        <ExecutionsTab v-show="store.activeTab === 'executions'" />
        <SettingsTab v-show="store.activeTab === 'settings'" />
      </main>
    </div>
  `,
};