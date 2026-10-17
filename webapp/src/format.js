/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small display helpers shared by the grids. */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const shortHash = (hash) => (typeof hash === 'string' && hash !== '' ? hash.slice(0, 12) : '');

export const lastOf = (list) => (Array.isArray(list) && list.length > 0 ? list[list.length - 1] : '');

export const countOf = (list) => (Array.isArray(list) ? list.length : 0);

/**
 * Current SHA-256 of a hash store entry.
 *
 * The API returns each path's history newest first (assembled from the run
 * files, newest run first), so the current hash is the first element. Anything
 * else here shows a stale hash as current - the exact failure the per-run store
 * was built to remove.
 */
export function latestHash(entry) {
  const hashes = Array.isArray(entry?.hashes) ? entry.hashes : [];
  const first = hashes[0];
  if (typeof first === 'string') return first;
  return typeof first?.hash === 'string' ? first.hash : '';
}

/** "2 items · a, b" style summary for the array fields of an agent. */
export function summariseList(list, max = 2) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const shown = list.slice(0, max).join(', ');
  const rest = list.length - max;
  return rest > 0 ? `${list.length} items · ${shown} …` : `${list.length} · ${shown}`;
}