const { test } = require('node:test');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const vm = require('node:vm');

const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');

function popup({ error = false, clipboardFails = false } = {}) {

  const elements = new Map(), sent = [], settings = [], downloads = [], blobs = [], timers = [];

  const get = id => {

    if (!elements.has(id)) elements.set(id, { hidden: true, handlers: {}, value: '',

      addEventListener(type, fn) { this.handlers[type] = fn; }, focus() {}, select() { this.selected = true; } });

    return elements.get(id);

  };

  const runtime = { getManifest: () => ({ version: '1.4.2' }) };

  const chrome = { runtime, storage: { sync: {

    get: (_defaults, cb) => cb({ enabled: false }), set: value => settings.push(value),

  } }, tabs: {

    query: (_query, cb) => cb([{ id: 15 }]),

    sendMessage: (id, message, options, cb) => {

      sent.push({ id, message, options });

      runtime.lastError = error ? { message: 'no receiver' } : null;

      cb(error ? undefined : { scriptVersion: '1.4.2', enabled: true });

      runtime.lastError = null;

    },

  } };

  vm.runInNewContext(source, { document: { getElementById: get, body: { appendChild() {} }, createElement: () => ({ click() { downloads.push({name:this.download, url:this.href}); }, remove() {} }) }, chrome,
    Blob, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:report'; }, revokeObjectURL() {} }, setTimeout: fn => timers.push(fn),

    navigator: { clipboard: { writeText: async () => { if (clipboardFails) throw Error('denied'); } } } });

  return { get, sent, settings, downloads, blobs, timers, runtime };

}

test('popup keeps enabled setting and displays installed/injected versions', () => {

  const f = popup(); assert.equal(f.get('enabledToggle').checked, false);

  f.get('enabledToggle').checked = true; f.get('enabledToggle').handlers.change();

  assert.equal(f.settings[0].enabled, true);

  f.get('diagnose').handlers.click();

  assert.equal(f.sent[0].options.frameId, 0); assert.equal(f.get('diagnosticText').hidden, false);

  assert.equal(JSON.parse(f.get('diagnosticText').value).scriptVersion, '1.4.2');

});

test('popup gives a reload explanation when content script is missing', () => {

  const f = popup({ error: true }); f.get('diagnose').handlers.click();

  assert.match(f.get('diagnosticStatus').textContent, /再読み込み/);

  assert.equal(f.get('diagnosticText').hidden, true);

});

test('clipboard denial leaves a selected report for manual copying', async () => {

  const f = popup({ clipboardFails: true }); f.get('diagnose').handlers.click();

  await f.get('copyDiagnostic').handlers.click();

  assert.equal(f.get('diagnosticText').selected, true);

});




test('popup has one setting and diagnostics initially collapsed', () => {
  const html=fs.readFileSync(path.join(__dirname,'..','popup.html'),'utf8');
  assert.equal((html.match(/type="checkbox"/g)||[]).length,1);
  assert.match(html,/<details>/); assert.doesNotMatch(html,/<details[^>]*open/);
  assert.doesNotMatch(html,/pauseTest|controlsTest|fullscreenTest|earlyNextToggle|nextUpExperimentMode/);
  const f=popup(); f.get('enabledToggle').handlers.change();
  assert.deepEqual(Object.keys(f.settings[0]),['enabled']);
  assert.match(f.get('settingStatus').textContent,/再読み込み/);
});


test('copy and export require a report; downloaded JSON equals the displayed log', async () => {
  const f=popup();
  assert.equal(f.get('copyDiagnostic').disabled,true);
  assert.equal(f.get('exportDiagnostic').disabled,true);
  f.get('exportDiagnostic').handlers.click(); assert.equal(f.downloads.length,0);
  f.get('diagnose').handlers.click();
  assert.equal(f.get('copyDiagnostic').disabled,false);
  assert.equal(f.get('exportDiagnostic').disabled,false);
  f.get('exportDiagnostic').handlers.click();
  assert.equal(f.downloads[0].name,'simple-continuous-play-diagnostics.json');
  assert.equal(await f.blobs[0].text(),f.get('diagnosticText').value);
  assert.equal(f.blobs[0].type,'application/json;charset=utf-8');
  assert.equal(f.timers.length,1); f.timers[0]();
});

test('failed capture keeps export and copy disabled', () => {
  const f=popup({error:true}); f.get('diagnose').handlers.click();
  assert.equal(f.get('copyDiagnostic').disabled,true);
  assert.equal(f.get('exportDiagnostic').disabled,true);
  assert.equal(f.get('diagnose').disabled,false);
  assert.equal(f.get('diagnosticText').value,'');
});
