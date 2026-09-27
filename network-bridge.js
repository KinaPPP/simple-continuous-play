// Isolated-world bridge. Page messages are diagnostic data, never commands.
(() => {
  'use strict';
  const CHANNEL = 'scp-network-observer-v1';
  let enabled = false, loaded = false, ready = false;
  const experiment = true;
  let extensionEnabled = false;
  const experimentMode = 'delayFallback';
  const records = [];
  // Synchronous isolated-world handoff; diagnostic summaries only, no page API.
  globalThis.__scpNetworkSnapshot = () => {
    const result = { enabled, ready, experimentMode, capturedAt: Date.now(), records: records.slice(-6).map(r =>
      ({ ...r, fields: r.fields.slice(0, 24).map(f => ({ ...f })) })) };
    while (JSON.stringify(result).length > 16000 && result.records.length) result.records.shift();
    return result;
  };
  const configure = () => window.postMessage({ channel: CHANNEL, type: 'configure', enabled, experiment: experiment && extensionEnabled && experimentMode !== 'compare', experimentMode }, location.origin);
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    if (event.data.type === 'ready') { if (loaded) configure(); return; }
    if (event.data.type !== 'report') return;
    const p = event.data.payload;
    if (!p || typeof p !== 'object') return;
    if (p.status === 'enabled' || p.status === 'disabled') { ready = true; return; }
    if (!enabled || !['fetch','xhr'].includes(p.transport) || !['playback-resources','player-resources'].includes(p.endpoint) || !['parsed','not-json','size-limit','experiment-applied','experiment-no-match','experiment-bypassed','experiment-xhr-unsupported'].includes(p.status)) return;
    const fields = Array.isArray(p.fields) ? p.fields.slice(0,100).filter(f => f && typeof f.path === 'string' && f.path.length < 600 && /^[a-zA-Z0-9?.]+$/.test(f.path) &&
      (typeof f.value === 'boolean' || typeof f.value === 'number' && Number.isFinite(f.value) || ['END_CREDITS','NEXT_UP','INTRO','RECAP'].includes(f.value))) : [];
    records.push({ at: Date.now(), endpoint: p.endpoint, transport: p.transport, status: p.status,
      fields: fields.map(f => ({ path: f.path, value: f.value })) });
    if (records.length > 30) records.shift();
  });
  // 1.4 uses the verified delay policy by default, including upgraded installs.
  // Legacy test switches are intentionally ignored and never change master OFF.
  chrome.storage.sync.get({ enabled: true }, data => {
    extensionEnabled = data.enabled !== false;
    enabled = extensionEnabled; loaded = true; configure();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.enabled) return;
    extensionEnabled = changes.enabled.newValue !== false;
    enabled = extensionEnabled;
    if (!enabled) records.length = 0;
    configure();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'scp-network-diagnostics') respond({ enabled, ready, suppressNextUpExperiment: experiment && extensionEnabled, experimentMode, records: [...records] });
  });
})();
