/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
import AgentsTab from './AgentsTab.js';
import HashingTab from './HashingTab.js';
import LinkChangesTab from './LinkChangesTab.js';
import SettingsTab from './SettingsTab.js';
import { store } from '../store.js';

export default {
  name: 'JsonManagerApp',
  components: { AgentsTab, HashingTab, LinkChangesTab, SettingsTab },
  setup() {
    const tabs = [
      { id: 'agents', label: 'Agents' },
      { id: 'hashing', label: 'Hashing' },
      { id: 'link', label: 'Link Changes to Agent' },
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
        <HashingTab v-show="store.activeTab === 'hashing'" />
        <LinkChangesTab v-show="store.activeTab === 'link'" />
        <SettingsTab v-show="store.activeTab === 'settings'" />
      </main>
    </div>
  `,
};