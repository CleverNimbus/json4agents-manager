/**
 * Thin fetch wrappers around the JSON API.
 *
 * `hashFolder` is the interesting one: the server answers with newline
 * delimited JSON, so the response body is read as a stream and every line is
 * handed to `onEvent` as it arrives. That is what keeps the progress line in
 * the UI live while the server walks the disk.
 */

async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export const getAgents = () => request('/api/agents');

export const getSchema = () => request('/api/schema');

export const getHashes = () => request('/api/hashes');

export const getState = () => request('/api/state');

export const saveState = (patch) =>
  request('/api/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const getSettings = () => request('/api/settings');

export const getDataFolder = () => request('/api/data-folder');

export const saveDataFolder = (dataFolder) =>
  request('/api/data-folder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataFolder }),
  });

export const saveSettings = (patch) =>
  request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const listFolder = (path) => request(`/api/fs?path=${encodeURIComponent(path ?? '')}`);

/** Create data/agents/<code>.json. */
export const createAgent = (agent) =>
  request('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  });

/** Update the file of `previousCode`; a changed code renames the file. */
export const updateAgent = (previousCode, agent) =>
  request(`/api/agents/${encodeURIComponent(previousCode)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent }),
  });

export const deleteAgent = (code) =>
  request(`/api/agents/${encodeURIComponent(code)}`, { method: 'DELETE' });

/** Uncommitted git changes inside the workspace folder. */
export const getChanges = () => request('/api/changes');

/** Add files to an agent's result_generated_files. */
export const linkFiles = (code, paths) =>
  request(`/api/agents/${encodeURIComponent(code)}/link-files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

/**
 * Start a hash run and consume its progress stream.
 *
 * @param {{path:string, includeHidden:boolean, followSymlinks:boolean}} payload
 * @param {(event:object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function hashFolder(payload, onEvent, signal) {
  const response = await fetch('/api/hash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Hashing failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') onEvent(JSON.parse(line));
    }
  }
  if (buffer.trim() !== '') onEvent(JSON.parse(buffer.trim()));
}