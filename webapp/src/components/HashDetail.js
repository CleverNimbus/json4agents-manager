/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Hash history popup: click a row in the hashing grid to see every hash that
 * was recorded for that file or folder, newest first.
 *
 * The server never stores the same hash twice in a row, so the list is a real
 * history: each entry after the first one means "the content changed here".
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { formatBytes, formatTime } from '../format.js';

export default {
  name: 'HashDetail',
  props: {
    /** Row from the grid: { path, hashes, size, mtime, changed } */
    entry: { type: Object, required: true },
    /** 'File' or 'Folder' */
    kind: { type: String, default: 'File' },
  },
  emits: ['close'],
  setup(props, { emit }) {
    /**
     * Newest first, which is the order the API already sends: histories are
     * assembled from the hash run files newest run first.
     */
    const history = computed(() =>
      [...(props.entry.hashes ?? [])]
        .filter((item) => item && typeof item === 'object' && typeof item.hash === 'string')
        .map((item, index, all) => ({
          datetime: item.datetime,
          hash: item.hash,
          isLatest: index === 0,
          sameAsPrevious: index > 0 && item.hash === all[index - 1].hash,
        })),
    );

    const onKeydown = (event) => {
      if (event.key === 'Escape') emit('close');
    };
    onMounted(() => window.addEventListener('keydown', onKeydown));
    onUnmounted(() => window.removeEventListener('keydown', onKeydown));

    return { formatBytes, formatTime, history };
  },
  template: `
    <div class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal history" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h2 class="mono history-title" :title="entry.path">{{ kind }} history</h2>
          <button type="button" class="icon" title="Close (Esc)" @click="$emit('close')">✕</button>
        </header>

        <div class="modal-body">
          <p class="history-path mono" :title="entry.path">{{ entry.path }}</p>
          <p class="modal-note">
            {{ history.length }} hash{{ history.length === 1 ? '' : 'es' }} recorded,
            newest first<span v-if="entry.size !== undefined"> · {{ formatBytes(entry.size) }}</span>.
            Identical hashes are not stored twice, so every entry after the first is a real change.
          </p>

          <ol class="hash-list">
            <li v-for="item in history" :key="item.datetime + item.hash" :class="{ latest: item.isLatest }">
              <div class="hash-line">
                <span class="hash-date">{{ formatTime(item.datetime) }}</span>
                <span class="hash-ago mono">{{ item.datetime }}</span>
                <span class="badge latest-badge" v-if="item.isLatest">latest</span>
                <span class="badge same-badge" v-else-if="item.sameAsPrevious">same as previous</span>
                <span class="badge changed-badge" v-else>changed</span>
              </div>
              <code class="hash-value">{{ item.hash }}</code>
            </li>
          </ol>
        </div>

        <footer class="modal-foot">
          <span class="spacer"></span>
          <button type="button" class="primary" @click="$emit('close')">Close</button>
        </footer>
      </div>
    </div>
  `,
};