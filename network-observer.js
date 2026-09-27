// Page-world observer with an opt-in, narrowly scoped NEXT_UP experiment.
(() => {
  'use strict';
  const CHANNEL = 'scp-network-observer-v1';
  let enabled = false, installed = false, generation = 0, seen = 0;
  let experiment = false, experimentMode = 'remove';
  const MAX = 2 * 1024 * 1024;
  const numericKeys = new Set(['startTime','endTime','time','timecode','timeCode','startTimecode','endTimecode','startTimeCode','endTimeCode','startTimeMillis','endTimeMillis','startTimeMs','endTimeMs','timeOffset','offset','duration','durationMillis','durationMs','countdown','countdownSeconds','countdownDuration','delay','delaySeconds','timestamp','start','end']);
  const boolKeys = new Set(['autoplayEnabled','autoPlayEnabled','isAutoplayEnabled','isMultiTitleExperience']);
  const containers = new Set(['transitionTimecodes','result','events','resources','nextUpV2','nextUpV3','card','autoPlayConfig','autoplayConfig','sections','bottom','collections','collectionList']);
  const send = payload => window.postMessage({ channel: CHANNEL, type: 'report', payload }, location.origin);
  function classify(input) {
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (typeof raw !== 'string') return null;
      const url = new URL(raw, location.href);
      if (!/(^|\.)(amazon\.(co\.jp|com)|primevideo\.com)$/.test(url.hostname)) return null;
      if (/getvodplaybackresources|GetPlaybackResources/i.test(url.pathname)) return 'playback-resources';
      if (/getresources|getsections|nextup/i.test(url.pathname)) return 'player-resources';
      return null;
    } catch { return null; }
  }
  function summarize(data) {
    const fields = []; let visits = 0;
    function walk(value, path, relevant, depth) {
      if (!value || typeof value !== 'object' || depth > 14 || ++visits > 3000 || fields.length >= 100) return;
      for (const [key, v] of Object.entries(value).slice(0, 300)) {
        const inside = relevant || ['transitionTimecodes','nextUpV2','nextUpV3','autoPlayConfig','autoplayConfig'].includes(key);
        const label = containers.has(key) || numericKeys.has(key) || boolKeys.has(key) || key === 'eventType' ? key : /^\d{1,3}$/.test(key) ? key : '?';
        const p = path ? path + '.' + label : label;
        if (inside && numericKeys.has(key)) {
          const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
          if (Number.isFinite(n)) fields.push({ path: p, value: n });
        } else if (inside && boolKeys.has(key) && typeof v === 'boolean') fields.push({ path: p, value: v });
        else if (inside && key === 'eventType' && ['END_CREDITS','NEXT_UP','INTRO','RECAP'].includes(v)) fields.push({ path: p, value: v });
        if (fields.length >= 100) break;
        if (v && typeof v === 'object') walk(v, p, inside, depth + 1);
      }
    }
    walk(data, '', false, 0);
    return fields;
  }
  function inspect(text, endpoint, transport, token) {
    if (!enabled || token !== generation) return;
    if (typeof text !== 'string' || text.length > MAX) { send({ endpoint, transport, status: 'size-limit', fields: [] }); return; }
    try { send({ endpoint, transport, status: 'parsed', fields: summarize(JSON.parse(text)) }); }
    catch { send({ endpoint, transport, status: 'not-json', fields: [] }); }
  }
  async function readCopy(response, endpoint, token) {
    if (!enabled || token !== generation) return;
    const copy = response.clone();
    if (!copy.body) return;
    const reader = copy.body.getReader(), decoder = new TextDecoder();
    let length = 0, text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX || !enabled || token !== generation) {
          reader.cancel().catch(() => {});
          if (length > MAX && enabled) send({ endpoint, transport: 'fetch', status: 'size-limit', fields: [] });
          return;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode(); inspect(text, endpoint, 'fetch', token);
    } finally { reader.releaseLock(); }
  }
  // Only known millisecond start values equal to the parent marker are shifted.
  // Unknown units, ranges or differing nested starts are left untouched as a whole.
  function delayNextUp(events, delayMs = 30000, expectedStart = null) {
    const edits = [], starts = []; let visits = 0;
    for (const event of events.filter(e => e?.eventType === 'NEXT_UP')) {
      const raw = event.startTimeMs;
      const start = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (expectedStart !== null && start !== expectedStart) throw Error('different-marker');
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + delayMs)) throw Error('shape');
      const walk = (value, depth) => {
        if (depth > 12 || ++visits > 1000) throw Error('shape');
        for (const [key, v] of Object.entries(value)) {
          if (key === 'startTimeMs') {
            if (!['number','string'].includes(typeof v) || Number(v) !== start) throw Error('shape');
            edits.push([value, key, typeof v === 'string' ? String(start + delayMs) : start + delayMs]);
          } else if (numericKeys.has(key)) throw Error('shape');
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(event, 0); starts.push(start);
    }
    for (const [object, key, value] of edits) object[key] = value;
    return { starts, fieldsChanged: edits.length };
  }
  // Do not shift media time or alter END_CREDITS, ads, URLs or autoplay settings.
  async function experimentResponse(response, endpoint, token) {
    if (!response.ok || !experiment || token !== generation) return response;
    const mode = experimentMode;
    let details = [];
    const report = (status, count = 0) => send({ endpoint, transport: 'fetch', status,
      fields: [{ path: mode !== 'remove' ? 'experiment.delayedNextUpEvents' : 'experiment.removedNextUpEvents', value: count }, ...details] });
    let reader, timer;
    try {
      const copy = response.clone();
      if (!copy.body) return response;
      reader = copy.body.getReader();
      const read = async () => {
        const decoder = new TextDecoder(); let size = 0, text = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text + decoder.decode();
          size += value.byteLength;
          if (size > MAX) throw Error('limit');
          text += decoder.decode(value, { stream: true });
        }
      };
      const text = await Promise.race([read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('timeout')), 1500);
      })]);
      if (!enabled || !experiment || token !== generation) return response;
      const data = JSON.parse(text);
      const events = data?.transitionTimecodes?.result?.events;
      if (!Array.isArray(events)) { report('experiment-no-match'); return response; }
      const remaining = events.filter(event => event?.eventType !== 'NEXT_UP');
      const count = events.length - remaining.length;
      if (!count) { report('experiment-no-match'); return response; }
      if (mode !== 'remove') {
        // Experimental: defer each known marker by 24h; test the player's terminal fallback.
        // No guessed content length or ad offset, and no media clock manipulation.
        const delayMs = mode === 'delayFallback' ? 86400000 : ['nearEnd2','nearEnd5'].includes(mode) ? 98000 : 30000;
        const result = delayNextUp(events, delayMs, ['nearEnd2','nearEnd5'].includes(mode) ? 1336000 : null);
        details = [{ path: 'experiment.delayMs', value: delayMs },
          { path: 'experiment.fieldsChanged', value: result.fieldsChanged },
          ...result.starts.slice(0, 30).flatMap((start, i) => [
            { path: 'experiment.events.' + i + '.originalStartTimeMs', value: start },
            { path: 'experiment.events.' + i + '.updatedStartTimeMs', value: start + delayMs }
          ])];
      } else data.transitionTimecodes.result.events = remaining;
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      const replacement = new Response(JSON.stringify(data), {
        status: response.status, statusText: response.statusText, headers
      });
      function metadata(target) {
        for (const key of ['url', 'redirected', 'type'])
          Object.defineProperty(target, key, { value: response[key] });
        const clone = target.clone.bind(target);
        Object.defineProperty(target, 'clone', { value: () => metadata(clone()) });
        return target;
      }
      metadata(replacement);
      report('experiment-applied', count);
      return replacement;
    } catch {
      if (enabled && experiment && token === generation) report('experiment-bypassed');
      return response;
    } finally {
      clearTimeout(timer);
      if (reader) reader.cancel().catch(() => {});
    }
  }
  function install() {
    if (installed) return; installed = true;
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') window.fetch = function(...args) {
      const result = Reflect.apply(originalFetch, this, args);
      const endpoint = enabled && seen < 100 ? classify(args[0]) : null;
      if (endpoint) {
        seen++; const token = generation;
        result.then(response => readCopy(response, endpoint, token)).catch(() => {});
        if (experiment && endpoint === 'playback-resources')
          return result.then(response => experimentResponse(response, endpoint, token));
      }
      return result;
    };
    const proto = window.XMLHttpRequest?.prototype;
    if (proto) {
      const originalOpen = proto.open, originalSend = proto.send, endpoints = new WeakMap();
      proto.open = function(...args) {
        const result = Reflect.apply(originalOpen, this, args);
        endpoints.set(this, classify(args[1])); return result;
      };
      proto.send = function(...args) {
        const endpoint = enabled && seen < 100 ? endpoints.get(this) : null;
        if (endpoint) {
          seen++; const token = generation;
          this.addEventListener('loadend', () => {
            if (!enabled || token !== generation) return;
            try {
              if (experiment && endpoint === 'playback-resources') send({ endpoint, transport: 'xhr', status: 'experiment-xhr-unsupported', fields: [] });
              if (this.responseType === 'json') send({ endpoint, transport: 'xhr', status: 'parsed', fields: summarize(this.response) });
              else if (!this.responseType || this.responseType === 'text') inspect(this.responseText, endpoint, 'xhr', token);
            } catch { /* No effect on page handlers. */ }
          }, { once: true });
        }
        return Reflect.apply(originalSend, this, args);
      };
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== CHANNEL || event.data.type !== 'configure') return;
    enabled = event.data.enabled === true; experiment = enabled && event.data.experiment === true; experimentMode = ['delay30','nearEnd2','nearEnd5','compare','delayFallback'].includes(event.data.experimentMode) ? event.data.experimentMode : 'remove'; if (experimentMode === 'compare') experiment = false; generation++; seen = 0;
    if (enabled) install();
    send({ status: enabled ? 'enabled' : 'disabled', fields: [] });
  });
  window.postMessage({ channel: CHANNEL, type: 'ready' }, location.origin);
})();
