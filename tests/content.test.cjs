// Deterministic regression scenarios for the production content script.
// DOM/media/clock are simulated; this does not verify Prime Video's live UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

class Element {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag; this.attrs = attrs; this.ownText = text; this.children = [];
    this.parentElement = null; this.isConnected = true; this.hidden = false;
    this.style = { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' };
    this.rect = { left: 0, top: 0, width: 1000, height: 700 };
    this.listeners = {}; this.clicks = 0;
  }
  add(child) { this.children.push(child); child.parentElement = this; return child; }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.rect.width && this.rect.height ? [this.rect] : []; }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  matches(selector) {
    return selector.split(',').some(s => {
      s = s.trim();
      if (/^[a-z][a-z0-9]*$/.test(s)) return this.tagName === s;
      if (s === 'a[href]') return this.tagName === 'a' && 'href' in this.attrs;
      if (s.startsWith('#')) return this.attrs.id === s.slice(1);
      if (s.startsWith('.')) return (this.attrs.class || '').split(' ').includes(s.slice(1));
      const m = s.match(/^\[([^=]+)="([^"]+)"\]$/);
      return m && this.attrs[m[1]] === m[2];
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(c => [...(c.isConnected && c.matches(selector) ? [c] : []),
      ...(c.isConnected ? c.querySelectorAll(selector) : [])]);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { this.listeners[type]?.delete(fn); }
  dispatchEvent(event) { event.target ||= this; for (const fn of [...(this.listeners[event.type] || [])]) fn(event); }
  click() { this.clicks++; this.onClick?.(); }
}
function fixture({ enabled = true, size = 1000, duration = 1400, series = true, earlyNext = false, memory = new Map(), startTime = 10000, suppressNextUpExperiment = false, nextUpExperimentMode = 'remove', networkSnapshotData = null } = {}) {
  const body = new Element('body');
  const root = body.add(new Element('div', { id: 'dv-web-player' }));
  const makeVideo = () => {
    const v = root.add(new Element('video'));
    Object.assign(v, { currentTime: 100, duration, currentSrc: 'blob:episode1', src: '', ended: false, seeking: false });
    v.rect = { left: 0, top: 0, width: size, height: size * 0.7 };
    return v;
  };
  const video = makeVideo(); video.paused = false; video.pause = () => { video.paused = true; video.dispatchEvent({ type: 'pause' }); }; video.play = () => { video.paused = false; return Promise.resolve(); };
  root.ownText = series ? 'S1 E1 episode one' : 'movie';
  const panel = series ? body.add(new Element('div', { id: 'tab-content-episodes' })) : null;
  function addEpisode(number, title, imageKey = String(number).repeat(64)) {
    const row = panel.add(new Element('li', { 'data-testid': 'episode-list-item' }));
    row.add(new Element('h3', {}, number + '. ' + title));
    const pack = row.add(new Element('div', { 'data-testid': 'episode-packshot' }));
    pack.add(new Element('img', { src: 'https://images-fe.ssl-images-amazon.com/images/S/pv-target-images/' + imageKey + '._SX720_.jpg' }));
    row.add(new Element('a', { 'data-testid': 'episodes-playbutton', href: '/gp/video/detail/episode' + number + '?autoplay=1&t=42' }));
    return row;
  }
  const rows = series ? [addEpisode(1, 'episode one'), addEpisode(2, 'episode two'), addEpisode(3, 'episode three')] : [];
  let now = startTime, interval, change, messageHandler;
  const logs = [];
  const navigations = [], microtasks = [];
  const flush = () => { while (microtasks.length) microtasks.shift()(); };
  const document = {
    documentElement: body,
    querySelectorAll: s => body.querySelectorAll(s),
    getElementById: id => body.querySelectorAll('#' + id)[0] || null,
    addEventListener: (type, fn) => body.addEventListener(type, fn),
  };
  const location = { href: 'https://www.amazon.co.jp/gp/video/detail/episode1', assign: url => navigations.push(url) };
  const context = {
    __scpNetworkSnapshot: () => structuredClone(networkSnapshotData),
    sessionStorage: { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) }, document, location, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: e => e.style, Date: { now: () => now },
    console: { info: (...a) => logs.push(a) }, queueMicrotask: fn => microtasks.push(fn), URL,
    setInterval: fn => { interval = fn; },
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); this.isTrusted = false; } }, MouseEvent: class { constructor(type) { this.type = type; } },
    chrome: { runtime: { onMessage: { addListener: fn => { messageHandler = fn; } } }, storage: {
      sync: { get: (_defaults, cb) => cb({ enabled, earlyNext, suppressNextUpExperiment, nextUpExperimentMode }) },
      onChanged: { addListener: fn => { change = fn; } },
    } },
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(source, context);
  return {
    document, root, body, video, logs, location, makeVideo, panel, rows, addEpisode, navigations, earlySetting: value => change({ earlyNext: { newValue: value } }, 'sync'),
    fullscreenTest: () => { let result; messageHandler({ type: 'scp-fullscreen-test' }, {}, data => { result = data; }); return result; }, controlsTest: () => { let result; messageHandler({ type: 'scp-controls-test' }, {}, data => { result = data; }); return result; }, pauseTest: () => { let result; messageHandler({ type: 'scp-pause-test' }, {}, data => { result = data; }); return result; }, diagnostics: () => { let result; messageHandler({ type: 'scp-diagnostics' }, {}, data => { result = data; }); return result; },
    button: (text, attrs = {}, parent = root, tag = 'button') => parent.add(new Element(tag, attrs, text)),
    poll: (ms = 400) => { now += ms; flush(); interval(); flush(); },
    setting: (value, area = 'sync') => change({ enabled: { newValue: value } }, area),
    end: (v = video, afterCapture = () => {}) => {
      v.currentTime = v.duration; v.ended = true;
      body.dispatchEvent({ type: 'ended', target: v }); afterCapture();
      v.dispatchEvent({ type: 'ended' }); flush();
    },
  };
}

test('OP/ED and even the final fraction of a second are never skipped', () => {
  const f = fixture(); const next = f.button('次のエピソード'); const intro = f.button('イントロをスキップ');
  for (const time of [100, 1200, 1399.99]) { f.video.currentTime = time; f.poll(); }
  assert.equal(next.clicks, 0); assert.equal(intro.clicks, 0);
  f.end(); assert.equal(next.clicks, 1);
});
test('legacy ID remains compatible independent of label language', () => {
  const f = fixture(); const b = f.button('unknown language', { id: 'atvwebplayersdk-next-episode-button' });
  f.end(); assert.equal(b.clicks, 1);
});
for (const label of ['次のエピソード', 'Next Episode', 'Nächste Folge', 'Épisode suivant',
  'Episodio siguiente', 'Prossimo episodio', 'Próximo episódio', '다음 에피소드', '下一集']) {
  test('label fallback: ' + label, () => {
    const f = fixture(); const b = f.button('', { 'aria-label': label }); f.end(); assert.equal(b.clicks, 1);
  });
}
test('NFKC, whitespace and case normalization; role=button', () => {
  const f = fixture(); const b = f.button(' ＮＥＸＴ\n EPISODE ', { role: 'button' }, f.root, 'div');
  f.end(); assert.equal(b.clicks, 1);
});
test('aria-labelledby control is used after completion', () => {
  const f = fixture();
  f.root.add(new Element('span', { id: 'next-label' }, '次のエピソード'));
  const b = f.button('', { 'aria-labelledby': 'next-label' }); f.end(); assert.equal(b.clicks, 1);
});
test('data-testid on a link control', () => {
  const f = fixture(); const b = f.button('', { 'data-testid': 'next-episode', href: '/next' }, f.root, 'a');
  f.end(); assert.equal(b.clicks, 1);
});
test('hidden, disabled and outside-player controls are excluded', () => {
  const f = fixture();
  const outside = f.button('Next Episode', {}, f.body);
  const hiddenParent = f.root.add(new Element('div')); hiddenParent.style.opacity = '0';
  const hidden = f.button('Next Episode', {}, hiddenParent);
  const disabled = f.button('Next Episode', { 'aria-disabled': 'true' });
  const live = f.button('Next Episode'); f.end();
  assert.deepEqual([outside.clicks, hidden.clicks, disabled.clicks, live.clicks], [0, 0, 0, 1]);
});
test('generic next / play / recommendation / unknown text never advances', () => {
  const f = fixture(); const bs = ['Next', 'Play', 'おすすめ', '次の作品', 'Skip Intro'].map(t => f.button(t));
  f.end(); f.poll(31000); assert.ok(bs.every(b => b.clicks === 0));
});
test('Watch Credits takes precedence over Stop Autoplay across disappearance', () => {
  const f = fixture(); f.video.currentTime = 1300;
  const watch = f.button('クレジットを観る'); const stop = f.button('Stop Autoplay');
  watch.onClick = () => { watch.hidden = true; }; f.poll(); f.poll(3000);
  assert.equal(watch.clicks, 1); assert.equal(stop.clicks, 0);
});
test('Stop Autoplay cancels late recommendations including after end', () => {
  const f = fixture(); const b = f.button('Stop Autoplay'); f.poll(); assert.equal(b.clicks, 0);
  f.video.currentTime = 1300; f.poll(); assert.equal(b.clicks, 1);
  f.end(); f.poll(3000); assert.equal(b.clicks, 2);
});
test('Hide is restricted to the recommendations panel', () => {
  const f = fixture(); const outside = f.button('非表示', {}, f.body); const other = f.button('Hide');
  const panel = f.root.add(new Element('div', {}, 'あなたにおすすめの商品'));
  const hide = f.button('非表示', {}, panel); f.poll();
  assert.deepEqual([outside.clicks, other.clicks, hide.clicks], [0, 0, 1]);
});
test('OFF immediately cancels a pending advance; local storage changes ignored', () => {
  const f = fixture(); f.setting(false); f.end(); const next = f.button('Next Episode'); f.poll(4000);
  assert.equal(next.clicks, 0); f.setting(true, 'local'); f.poll(); assert.equal(next.clicks, 0);
  f.setting(true); assert.equal(next.clicks, 1);
});
test('initial disabled setting does not click controls', () => {
  const f = fixture({ enabled: false }); const b = f.button('Watch Credits'); f.poll(); f.end(); assert.equal(b.clicks, 0);
});
test('one native click followed by one verified URL fallback; finale has no target', () => {
  const f = fixture(); const b = f.button('Next Episode'); f.end();
  for (let i = 0; i < 20; i++) f.poll(2500);
  assert.equal(b.clicks, 1); assert.equal(f.navigations.length, 1);
  const last = fixture(); last.root.ownText = 'S1 E3 episode three'; last.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode3';
  last.poll(); last.end(); last.poll(31000); const late = last.button('Next Episode');
  last.poll(); assert.equal(late.clicks, 0); assert.equal(last.navigations.length, 0);
});
test('new button during navigation is not clicked again', () => {
  const f = fixture(); const b = f.button('Next Episode'); b.onClick = () => { b.isConnected = false; };
  f.end(); const newButton = f.button('Next Episode'); f.poll(3000); assert.equal(newButton.clicks, 0);
});
test('video replacement ignores old ended events and handles new episode', () => {
  const f = fixture(); const b = f.button('Next Episode');
  f.video.isConnected = false; const second = f.makeVideo(); second.currentSrc = 'blob:episode2'; f.poll();
  f.end(); assert.equal(b.clicks, 0); f.end(second); assert.equal(b.clicks, 1);
});
test('same video/source reused for equal-duration episodes resets on restart', () => {
  const f = fixture(); const b = f.button('Next Episode'); f.end();
  f.video.ended = false; f.video.currentTime = 0; f.poll(); f.end(); assert.equal(b.clicks, 2);
});
test('ended property polling handles missed event; shrunken end card retains session', () => {
  const f = fixture(); const b = f.button('Next Episode');
  f.video.rect.width = 200; f.video.rect.height = 100; f.video.ended = true; f.video.currentTime = 1400;
  f.poll(); assert.equal(b.clicks, 1);
});
test('preview, short ad and infinite/live duration are not treated as main media', () => {
  for (const options of [{ size: 200 }, { duration: 30 }, { duration: Infinity }]) {
    const f = fixture(options); const b = f.button('Next Episode'); f.end(); f.poll(); assert.equal(b.clicks, 0);
  }
});
test('seeking, paused-near-end and a stray ended event do not advance', () => {
  const f = fixture(); const b = f.button('Next Episode'); f.video.currentTime = 1399.99;
  f.video.dispatchEvent({ type: 'ended' }); assert.equal(b.clicks, 0);
  f.video.seeking = true; f.end(); f.poll(); assert.equal(b.clicks, 0);
});
test('route change invalidates a pending end on old media', () => {
  const f = fixture(); f.location.href += '?other-title'; f.end(); const b = f.button('Next Episode');
  f.poll(); assert.equal(b.clicks, 0);
});

function nextCard(f, number = 2, imageKey = String(number).repeat(64)) {
  const wrapper = f.root.add(new Element('div', { class: 'atvwebplayersdk-nextupcard-wrapper' }));
  const card = wrapper.add(new Element('div', { class: 'atvwebplayersdk-nextupcard-button' }));
  card.add(new Element('img', { src: 'https://images-fe.ssl-images-amazon.com/images/S/pv-target-images/' + imageKey + '.jpg' }));
  card.add(new Element('div', { class: 'atvwebplayersdk-nextupcard-episode' }, 'E ' + number));
  const hide = f.button('非表示', { class: 'atvwebplayersdk-nextupcardhide-button' }, wrapper);
  hide.onClick = () => { wrapper.isConnected = false; };
  return { wrapper, card, hide };
}
test('5-second Next Up is dismissed, native next returns, and is used only at end', () => {
  const f = fixture(); f.video.currentTime = 1300;
  const { wrapper, card, hide } = nextCard(f);
  const next = f.button('次のエピソード'); next.hidden = true;
  hide.onClick = () => { wrapper.isConnected = false; next.hidden = false; };
  f.poll(); f.poll(6000);
  assert.equal(hide.clicks, 1); assert.equal(card.clicks, 0); assert.equal(next.clicks, 0);
  assert.equal(f.navigations.length, 0); f.end(); assert.equal(next.clicks, 1);
});
test('card and player removed at native end still use the saved episode-list URL', () => {
  const f = fixture(); nextCard(f); f.poll();
  f.end(f.video, () => { f.video.isConnected = false; f.root.isConnected = false; });
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode2');
  assert.equal(new URL(f.navigations[0]).searchParams.get('t'), '0');
});
test('manual player close before end never starts another episode', () => {
  const f = fixture(); nextCard(f); f.poll(); f.video.isConnected = false; f.root.isConnected = false;
  f.poll(); assert.equal(f.navigations.length, 0);
});
test('movie recommendations stop even after end and never open a different work', () => {
  const f = fixture({ series: false });
  const p = f.root.add(new Element('div', {}, 'あなたにおすすめの商品'));
  const stop = f.button('自動再生を停止', {}, p), hide = f.button('非表示', {}, p);
  const next = f.button('Next Episode'); f.end();
  assert.equal(stop.clicks, 1); assert.equal(hide.clicks, 1);
  assert.equal(next.clicks, 0); assert.equal(f.navigations.length, 0);
});
test('mismatched Next Up image, episode, and no-series cards cannot advance', () => {
  for (const [number, key, series] of [[2, 'a'.repeat(64), true], [1, '1'.repeat(64), true], [2, '2'.repeat(64), false]]) {
    const f = fixture({ series }); const c = nextCard(f, number, key); f.poll(); f.end();
    assert.equal(c.hide.clicks, 1); assert.equal(f.navigations.length, 0);
  }
});
test('next link must be same-origin HTTPS and an observed autoplay episode link', () => {
  for (const href of ['https://evil.example/gp/video/detail/episode2?autoplay=1', '/gp/video/offers?autoplay=1',
    'javascript:alert(1)', '/gp/video/detail/episode2', 'https://name:password@www.amazon.co.jp/gp/video/detail/episode2?autoplay=1']) {
    const f = fixture(); f.rows[1].querySelectorAll('a')[0].attrs.href = href;
    f.poll(); f.end(); assert.equal(f.navigations.length, 0);
  }
});
test('duplicate episode numbers or conflicting links are not guessed', () => {
  const f = fixture(); f.addEpisode(2, 'another episode two'); f.poll(); f.end(); assert.equal(f.navigations.length, 0);
  const g = fixture(); g.rows[1].add(new Element('a', { 'data-testid': 'episodes-playbutton', href: '/gp/video/detail/other?autoplay=1' }));
  g.poll(); g.end(); assert.equal(g.navigations.length, 0);
});
test('OFF after native click prevents the saved-URL fallback', () => {
  const f = fixture(); const b = f.button('次のエピソード'); f.end(); assert.equal(b.clicks, 1);
  f.setting(false); f.poll(6000); assert.equal(f.navigations.length, 0);
});
test('native transition to a new media source prevents the URL fallback', () => {
  const f = fixture(); const b = f.button('Next Episode');
  b.onClick = () => { f.video.ended = false; f.video.currentSrc = 'blob:episode2'; f.video.currentTime = 0; f.root.ownText = 'S1 E2 episode two'; };
  f.end(); f.poll(6000); assert.equal(f.navigations.length, 0);
});
test('same-video episodes advance 1->2->3 using updated metadata despite stale URL', () => {
  const f = fixture(); const b = f.button('Next Episode');
  f.end(); f.video.ended = false; f.video.currentTime = 0; f.video.currentSrc = 'blob:episode2';
  f.root.ownText = 'S1 E2 episode two'; f.poll(); b.hidden = true; f.end();
  f.poll(1400);
  assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode3');
});
test('provided native button ID and label with decorative children work after Hide', () => {
  const f = fixture(); f.video.currentTime = 1300;
  const c = nextCard(f);
  const b = f.button('次のエピソード', {
    id: 'atvwebplayersdk-next-episode-button',
    'aria-label': '次のエピソード',
    class: 'f13imzm1 fg4c0o1 f1kwmyva ff1ld61 f1cet4yo f11un3wk fe9afsx fj0jixm f1rb5ewy fw6qvwa f1vpdgub f1g75y8b',
  });
  b.add(new Element('div', { class: 'f1wt0yvj' }));
  b.add(new Element('img', { class: 'f1wt0yvj', src: 'data:image/svg+xml;base64,PHN2Zy8+', alt: '' }));
  b.hidden = true;
  c.hide.onClick = () => { c.wrapper.isConnected = false; b.hidden = false; };
  f.poll(); assert.equal(c.hide.clicks, 1); assert.equal(b.clicks, 0);
  f.video.currentTime = 1399.99; f.poll(); assert.equal(b.clicks, 0);
  f.end(); assert.equal(b.clicks, 1); assert.equal(f.navigations.length, 0);
});
test('native button mounted on a later render takes priority over URL fallback', () => {
  const f = fixture(); f.end(); assert.equal(f.navigations.length, 0);
  const b = f.button('次のエピソード', { id: 'atvwebplayersdk-next-episode-button' });
  f.poll(800); assert.equal(b.clicks, 1); assert.equal(f.navigations.length, 0);
});
test('autoplay settings switches are never clicked', () => {
  const f = fixture(); f.video.currentTime = 1300;
  const b = f.button('Stop Autoplay', { role: 'switch' }); f.poll(); assert.equal(b.clicks, 0);
});
test('zero-box Next Up wrapper does not hide its visible Hide control from detection', () => {
  const f = fixture(); const c = nextCard(f);
  c.wrapper.rect = { left: 0, top: 0, width: 0, height: 0 };
  f.poll(); assert.equal(c.hide.clicks, 1);
});
test('accessible-hidden but visibly rendered media is still monitored', () => {
  const f = fixture(); f.video.attrs['aria-hidden'] = 'true';
  const c = nextCard(f), b = f.button('次のエピソード', { id: 'atvwebplayersdk-next-episode-button' });
  f.poll(); assert.equal(c.hide.clicks, 1); f.end(); assert.equal(b.clicks, 1);
});
test('exact Hide cancellation works before video metadata is ready, but cannot advance', () => {
  const f = fixture({ duration: NaN }); const c = nextCard(f); const b = f.button('次のエピソード');
  f.poll(); assert.equal(c.hide.clicks, 1); assert.equal(b.clicks, 0); assert.equal(f.navigations.length, 0);
});
test('confirmed TV native Next Episode is independent of missing episode-list links', () => {
  const f = fixture({ series: false }); f.root.ownText = 'S1 E1 episode one';
  const c = nextCard(f), b = f.button('次のエピソード', { id: 'atvwebplayersdk-next-episode-button' });
  f.poll(); assert.equal(c.hide.clicks, 1); assert.equal(b.clicks, 0);
  f.end(); assert.equal(b.clicks, 1); f.poll(6000); assert.equal(f.navigations.length, 0);
});
test('OFF never cancels even when a visible dedicated Hide button exists', () => {
  const f = fixture({ enabled: false, duration: NaN }); const c = nextCard(f);
  f.poll(); assert.equal(c.hide.clicks, 0);
});
test('diagnostics identify injected script and detection without URLs or episode titles', () => {
  const f = fixture(); nextCard(f); f.poll(); const d = f.diagnostics();
  assert.equal(d.scriptVersion, '1.4.2'); assert.equal(d.enabled, true); assert.equal(d.topFrame, true);
  assert.equal(d.videos[0].selected, true); assert.equal(d.session.seriesEpisode, 1);
  const json = JSON.stringify(d);
  assert.ok(!json.includes('https://')); assert.ok(!json.includes('blob:')); assert.ok(!json.includes('episode one'));
});
test('Hide then invisible surface before ended retains listener and next target', () => {
  const f = fixture(); const c = nextCard(f); f.video.currentTime = 1390; f.poll();
  assert.equal(c.hide.clicks, 1);
  f.video.rect.width = 0; f.video.rect.height = 0; f.poll();
  assert.equal(f.diagnostics().session.suspended, true); assert.equal(f.navigations.length, 0);
  f.end(); f.poll(1400); assert.equal(f.navigations.length, 1);
});
test('detached video delivering ended later retains verified next URL', () => {
  const f = fixture(); f.video.currentTime = 1399; f.poll();
  f.video.isConnected = false; f.root.isConnected = false; f.poll();
  assert.equal(f.navigations.length, 0); f.end(); assert.equal(f.navigations.length, 1);
});
test('hidden reset to time zero without ended never advances and records final samples', () => {
  const f = fixture(); f.video.currentTime = 1431; f.video.duration = 1432;
  f.video.dispatchEvent({ type: 'timeupdate' });
  f.video.rect.width = 0; f.video.rect.height = 0; f.video.currentTime = 0; f.video.paused = true;
  f.video.dispatchEvent({ type: 'pause' });
  for (let i = 0; i < 78; i++) f.poll(400);
  assert.equal(f.navigations.length, 0);
  const report = f.diagnostics(); assert.equal(report.session, null);
  assert.equal(report.lastSession.reason, 'hidden-without-end');
  assert.equal(report.lastSession.targetEpisode, 2);
  assert.ok(report.lastSession.samples.some(s => s.time === 1431));
});
test('OFF during invisible end grace period still cancels late ended handling', () => {
  const f = fixture(); f.video.rect.width = 0; f.poll(); f.setting(false); f.end();
  assert.equal(f.navigations.length, 0); assert.equal(f.diagnostics().lastSession.reason, 'disabled');
});

test('Next Up verified episode survives stale player metadata and hidden media recycling', () => {
  const f = fixture(); f.root.ownText = 'S1 E2 episode two';
  nextCard(f, 3); f.poll();
  assert.equal(f.diagnostics().session.targetEpisode, 3);
  f.root.ownText = 'S1 E1 episode one'; f.poll();
  assert.equal(f.diagnostics().session.targetEpisode, 3);
  f.video.rect.width = 0; f.video.ended = true; f.video.currentTime = f.video.duration; f.poll();
  f.video.ended = false; f.video.currentTime = 0; f.video.currentSrc = 'blob:preview';
  f.poll(1500);
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode3');
});
test('fallback tolerates changed link tracking and display title for the same episode ID', () => {
  const f = fixture(); nextCard(f); f.poll(); f.end();
  f.rows[1].querySelectorAll('a')[0].attrs.href += '&ref_=changed';
  f.rows[1].querySelectorAll('h3')[0].ownText = '2. refreshed title';
  f.poll(1500);
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode2');
});
test('different episode ID remains blocked with an actionable diagnostic', () => {
  const f = fixture(); nextCard(f); f.poll(); f.end();
  f.rows[1].querySelectorAll('a')[0].attrs.href = '/gp/video/detail/different?autoplay=1';
  f.poll(1500);
  assert.equal(f.navigations.length, 0);
  assert.equal(f.diagnostics().session.advanceBlocked, 'episode-list-mismatch from=1 to=0');
});

test('early option defaults off and does not pause or click before end', () => {
  const f = fixture(); const b = f.button('Next Episode'); f.video.currentTime = 1399.5; f.poll();
  assert.equal(b.clicks, 0); assert.equal(f.video.paused, false);
});
test('early option leaves manual pause and absent control alone', () => {
  const f = fixture({ earlyNext: true }); f.video.currentTime = 1399.5; f.poll();
  assert.equal(f.video.paused, false); const b = f.button('Next Episode'); f.video.paused = true;
  f.poll(); assert.equal(b.clicks, 0);
});
test('early option never operates finale or movie without verified next episode', () => {
  for (const series of [true, false]) {
    const f = fixture({ earlyNext: true, series });
    if (series) { f.root.ownText = 'S1 E3 episode three'; f.poll(); }
    const b = f.button('Next Episode'); f.video.currentTime = 1399.5; f.poll();
    assert.equal(b.clicks, 0); assert.equal(f.video.paused, false);
  }
});

test('card evidence survives Hide and recovers after delayed player metadata agrees', () => {
  const f = fixture({ earlyNext: true }); const c = nextCard(f, 3); f.poll();
  assert.equal(c.hide.clicks, 1); assert.equal(f.diagnostics().session.cardConflict, true);
  f.root.ownText = 'S1 E2 episode two'; f.poll();
  assert.equal(f.diagnostics().session.targetEpisode, 3);
  assert.equal(f.diagnostics().session.cardConflict, false);
  assert.equal(f.diagnostics().session.nativeConflict, false);
  const b = f.button('Next Episode'); f.video.currentTime = 1399.5; f.poll();
  assert.equal(b.clicks, 0); assert.equal(f.video.paused, false);
  f.end(); assert.equal(b.clicks, 1);
});
test('incomplete card is distinguished from mismatch and may finish loading', () => {
  const f = fixture(); const c = nextCard(f); c.hide.onClick = () => {};
  const img = c.card.querySelectorAll('img')[0], src = img.attrs.src; img.attrs.src = '';
  f.poll(); assert.equal(f.diagnostics().session.cardCheck.reason, 'card-data-incomplete');
  assert.equal(f.diagnostics().session.cardConflict, false);
  img.attrs.src = src; f.poll();
  assert.equal(f.diagnostics().session.cardCheck.reason, 'matched');
  assert.equal(f.diagnostics().session.targetEpisode, 2);
});
test('actual artwork mismatch stays blocked after card disappears', () => {
  const f = fixture({ earlyNext: true }); nextCard(f, 2, 'a'.repeat(64)); f.poll();
  const b = f.button('Next Episode'); f.video.currentTime = 1399.5; f.poll();
  assert.equal(f.diagnostics().session.cardCheck.reason, 'artwork-mismatch');
  assert.equal(b.clicks, 0); f.end(); f.poll(2000);
  assert.equal(b.clicks, 0); assert.equal(f.navigations.length, 0);
});

test('fallback reason survives document reload without changing playback decisions', () => {
  const memory = new Map(); const f = fixture({ earlyNext: true, memory });
  f.video.currentTime = 1399.5; f.poll(); f.end(); f.poll(1500);
  const g = fixture({ memory, startTime: 20000 });
  const previous = g.diagnostics().previousTransition;
  assert.equal(previous.action, 'verified-url-fallback');
  const saved = JSON.parse(memory.get('simple-continuous-play-transition'));
  assert.equal(saved.action, 'verified-url-fallback');
  assert.equal(saved.earlyCheck, null);
  assert.equal(saved.earlyAttempted, false);
  assert.ok(!JSON.stringify(saved).includes('https://'));
  assert.equal(g.navigations.length, 0);
});




test('NEXT_UP suppressed: episode 2 without card or native button still advances after confirmed end', () => {
  const f = fixture();
  f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode2';
  f.root.ownText = 'S1 E2 episode two';
  f.video.currentSrc = 'blob:episode2';
  f.poll();
  assert.equal(f.diagnostics().session.cardCheck.reason, 'no-card');
  assert.equal(f.diagnostics().session.targetLocked, false);
  assert.equal(f.diagnostics().session.targetEpisode, 3);
  f.end(f.video, () => { f.video.isConnected = false; f.root.isConnected = false; });
  f.poll(1600);
  assert.equal(f.navigations.length, 1);
  assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode3');
});

function finalCardFixture(remaining = 1.5, mode = 'nearEnd2') {
  const f = fixture({ duration: 1432.02, suppressNextUpExperiment: true, nextUpExperimentMode: mode });
  f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode2';
  f.root.ownText = 'S1 E2 episode two'; f.video.currentSrc = 'blob:episode2';
  f.video.currentTime = f.video.duration - remaining; f.poll();
  f.document.fullscreenElement = f.root;
  const card = nextCard(f, 3); f.poll(); return { f, ...card };
}
test('final card mode retains verified episode 3, never clicks before end, waits then falls back', () => {
  const { f, hide, card } = finalCardFixture();
  assert.equal(hide.clicks, 0); assert.equal(card.clicks, 0); assert.equal(f.navigations.length, 0);
  assert.equal(f.diagnostics().session.officialCountdown.fullscreenAtCard, true);
  f.end(f.video, () => { f.video.isConnected = false; f.root.isConnected = false; });
  f.poll(6000); assert.equal(f.navigations.length, 0);
  f.poll(1100); assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode3');
});
test('final card mode disarms on rewind and on extension OFF', () => {
  const {f, hide} = finalCardFixture(); f.video.currentTime -= 10; f.poll();
  assert.equal(hide.clicks, 1); assert.equal(f.diagnostics().session.officialCountdown, null);
  const g = finalCardFixture(); g.f.setting(false); g.f.end(); g.f.poll(8000);
  assert.equal(g.f.navigations.length, 0);
});
test('official same-player transition prevents stale fallback and keeps fullscreen in simulated page', () => {
  const {f} = finalCardFixture(); f.end(); f.poll(2000);
  f.video.ended = false; f.video.currentTime = 0; f.video.currentSrc = 'blob:episode3';
  f.root.ownText = 'S1 E3 episode three'; f.poll(); f.poll(10000);
  assert.equal(f.navigations.length, 0); assert.equal(f.diagnostics().session.seriesEpisode, 3);
  assert.equal(f.diagnostics().fullscreen, true);
});
test('final card mode never retains movie or mismatched recommendation cards', () => {
  const f = fixture({ series: false, suppressNextUpExperiment: true, nextUpExperimentMode: 'nearEnd2' });
  f.video.currentTime = f.video.duration - 1; const c = nextCard(f, 3); f.poll(); assert.equal(c.hide.clicks, 1);
  const g = finalCardFixture(); const wrong = nextCard(g.f, 1); g.f.poll();
  assert.equal(wrong.hide.clicks, 1);
});

test('final-card experiment prevents the separate early-next option from cutting the ending', () => {
  const {f} = finalCardFixture(); const button = f.button('次のエピソード');
  f.earlySetting(true); f.video.currentTime = f.video.duration - 0.5; f.poll();
  assert.equal(button.clicks, 0); assert.equal(f.video.paused, false);
});

test('stale episode 3 URL and cached target 4 yield to player episode 2 without matching title text', () => {
  const f = fixture({duration: 1432.021, suppressNextUpExperiment: true, nextUpExperimentMode: 'nearEnd2'});
  f.addEpisode(4, 'episode four'); f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode3';
  f.root.ownText = ''; f.video.currentSrc = 'blob:episode2'; f.poll();
  assert.equal(f.diagnostics().session.targetEpisode, 4);
  f.root.ownText = 'S1 E2 '; f.video.currentTime = 1430.8;
  const c = nextCard(f, 3); f.poll();
  const report = f.diagnostics();
  assert.equal(report.session.seriesEpisode, 2); assert.equal(report.session.targetEpisode, 3);
  assert.equal(report.session.cardCheck.reason, 'matched'); assert.equal(c.hide.clicks, 0);
  assert.equal(report.session.finalCardCheck.reason, 'retained');
});
test('player episode remains authoritative after controls disappear despite stale URL', () => {
  const f = fixture(); f.addEpisode(4, 'episode four');
  f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode3';
  f.root.ownText = 'S1 E2'; f.video.currentSrc = 'blob:episode2'; f.poll();
  f.root.ownText = ''; f.poll(); assert.equal(f.diagnostics().session.targetEpisode, 3);
});
test('ambiguous player or duplicate list identity cannot reuse an old candidate', () => {
  for (const ambiguity of ['player', 'list']) {
    const f = fixture();
    if (ambiguity === 'player') f.root.ownText = 'S1 E1 S1 E2';
    else f.addEpisode(1, 'duplicate episode one');
    f.poll(); assert.equal(f.diagnostics().session.targetEpisode, null);
  }
});


test('terminal card policy retains observed 5.18-second card and records evidence before end', () => {
  const {f, hide, card} = finalCardFixture(5.18, 'nearEnd5');
  assert.equal(hide.clicks, 0); assert.equal(card.clicks, 0);
  const d = f.diagnostics();
  assert.equal(d.session.finalCardCheck.reason, 'retained');
  assert.equal(d.previousTransition.action, 'official-countdown-retained');
  assert.equal(d.previousTransition.completed, false);
  assert.equal(d.previousTransition.fullscreen, true);
  f.poll(1000); assert.equal(hide.clicks, 0);
  f.end(); f.poll(6000); assert.equal(f.navigations.length, 0);
  f.poll(1100); assert.equal(new URL(f.navigations[0]).pathname, '/gp/video/detail/episode3');
});
test('terminal card policy disarms after rewind and preserves monitor-exit evidence', () => {
  const a = finalCardFixture(5.18, 'nearEnd5'); a.f.video.currentTime -= 10; a.f.poll();
  assert.equal(a.hide.clicks, 1); assert.equal(a.f.diagnostics().session.officialCountdown, null);
  const {f} = finalCardFixture(5.18, 'nearEnd5');
  f.video.currentTime = 0; f.video.currentSrc = 'blob:episode3'; f.root.ownText = 'S1 E3 episode three'; f.poll();
  const d = f.diagnostics(); assert.equal(d.previousTransition.action, 'official-countdown-monitor-ended');
  assert.equal(d.previousTransition.completed, false); // no claim the full ending was observed
  assert.equal(d.session.seriesEpisode, 3); assert.equal(d.fullscreen, true);
  f.poll(10000); assert.equal(f.navigations.length, 0);
});

test('standard policy supports episode 3 to 4 with first-card Hide and terminal-card retention', () => {
  const f = fixture({duration: 1520, suppressNextUpExperiment:true, nextUpExperimentMode:'compare'});
  f.addEpisode(4, 'episode four'); f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode3';
  f.root.ownText = 'S2 E3 episode three'; f.video.currentSrc = 'blob:third'; f.video.currentTime = 1400;
  const early = nextCard(f,4); f.poll(); assert.equal(early.hide.clicks,1);
  f.video.currentTime = 1514.82; const late = nextCard(f,4); f.poll();
  assert.equal(late.hide.clicks,0); assert.equal(f.diagnostics().session.targetEpisode,4);
  assert.deepEqual(Array.from(f.diagnostics().session.cardObservations, o => o.action), ['hidden','retained']);
});
test('diagnostics save network summary and media length across a new document without later overwrite', () => {
  const memory = new Map();
  const summary = { experimentMode:'compare', records:[{status:'parsed',fields:[{path:'transitionTimecodes.result.events.0.startTimeMs',value:2100000}]}] };
  const f = fixture({duration:2200, memory, networkSnapshotData:summary, suppressNextUpExperiment:true,nextUpExperimentMode:'compare'});
  f.video.currentTime = 2194.8; nextCard(f,2); f.poll();
  const first = f.diagnostics().previousTransition;
  assert.equal(first.mediaDuration,2200); assert.equal(first.seriesEpisode,1);
  assert.equal(first.networkObservation.records[0].fields[0].value,2100000);
  summary.records.length = 0;
  f.end(); f.poll(8000);
  const g = fixture({memory, startTime:30000}); const previous = g.diagnostics().previousTransition;
  assert.equal(previous.networkObservation.records[0].fields[0].value,2100000);
  assert.equal(previous.cardObservations[0].remaining,5.2);
  assert.equal(previous.targetEpisode,2);
});
test('standard policy rejects mismatched cards and movies, and leaves early-next disabled', () => {
  const f = fixture({suppressNextUpExperiment:true,nextUpExperimentMode:'compare',earlyNext:true});
  f.video.currentTime = f.video.duration - 1; const c = nextCard(f,3); const n = f.button('次のエピソード'); f.poll();
  assert.equal(c.hide.clicks,1); assert.equal(n.clicks,0);
  const g = fixture({series:false,suppressNextUpExperiment:true,nextUpExperimentMode:'compare'});
  g.video.currentTime = g.video.duration - 5; const card = nextCard(g,2); g.poll();
  assert.equal(card.hide.clicks,1); assert.equal(g.diagnostics().session.officialCountdown,null);
});


test('general delay retains verified terminal cards for 3->4 and another duration 1->2', () => {
  for (const [episode,duration] of [[3,1432],[1,1444.943]]) {
    const f = fixture({duration,suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
    f.addEpisode(4,'episode four');
    f.root.ownText = episode===3 ? 'S1 E3 episode three' : 'S1 E1 episode one';
    f.location.href = 'https://www.amazon.co.jp/gp/video/detail/episode'+episode;
    f.video.currentSrc = 'blob:episode'+episode;
    f.video.currentTime = duration-5.18; const c = nextCard(f,episode+1); f.poll();
    assert.equal(c.hide.clicks,0); assert.equal(f.diagnostics().session.targetEpisode,episode+1);
    assert.equal(f.diagnostics().session.finalCardCheck.reason,'retained');
    f.end(); f.poll(8000); assert.equal(new URL(f.navigations[0]).pathname,'/gp/video/detail/episode'+(episode+1));
  }
});
test('general delay falls back to protective Hide for early cards and never infers missing media end', () => {
  const f = fixture({duration:1444.943,suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
  f.video.currentTime = 1335.285; const c=nextCard(f,2); f.poll(); assert.equal(c.hide.clicks,1);
  assert.ok(f.diagnostics().history.some(r=>r.message.includes('保護のためHide')));
  f.video.currentTime = 1444.03; f.video.hidden=true; f.poll();
  f.video.currentTime=0; f.video.duration=NaN; f.poll(31000);
  assert.equal(f.navigations.length,0);
});


test('fullscreen diagnostics retain disconnected prior target and page fullscreen separately', () => {
  const f = fixture();
  f.document.fullscreenElement = f.root;
  f.body.dispatchEvent({ type: 'fullscreenchange' });
  f.root.isConnected = false;
  f.document.fullscreenElement = null;
  f.body.dispatchEvent({ type: 'fullscreenchange' });
  let events = f.diagnostics().lifecycle.filter(e => e.event === 'fullscreen-change');
  assert.equal(events[0].fullscreenTarget.scope, 'player');
  assert.equal(events[1].previousTarget.connected, false);
  assert.equal(events[1].fullscreenTarget, null);
  f.document.fullscreenElement = f.body;
  f.body.dispatchEvent({ type: 'fullscreenchange' });
  assert.equal(f.diagnostics().fullscreenTarget.scope, 'document');
  assert.equal(f.navigations.length, 0);
});
test('lifecycle keeps duration and identity changes after source reset without sensitive strings', () => {
  const f = fixture();
  f.video.duration = 1460;
  f.video.dispatchEvent({ type: 'durationchange' });
  f.root.ownText = '';
  f.location.href = 'https://www.amazon.co.jp/gp/video/detail/unknown';
  f.video.currentSrc = 'blob:private-source'; f.video.currentTime = 0;
  f.poll();
  const trace = f.diagnostics().lifecycle;
  assert.ok(trace.some(e => e.event === 'media-state' && e.trigger === 'durationchange' && e.duration === 1460));
  assert.ok(trace.some(e => e.event === 'episode-identity' && e.targetEpisode === 2));
  assert.ok(trace.some(e => e.event === 'session-reset' && e.sourceChanged));
  assert.ok(trace.some(e => e.event === 'episode-identity' && e.identity === 'unresolved'));
  assert.ok(!JSON.stringify(trace).includes('private-source'));
  assert.ok(!JSON.stringify(trace).includes('https:'));
});
test('bounded lifecycle survives page reload and avoids per-poll growth', () => {
  const memory = new Map(); const f = fixture({ memory });
  f.document.fullscreenElement = f.root;
  f.body.dispatchEvent({ type: 'fullscreenchange' });
  const count = f.diagnostics().lifecycle.length;
  for (let i = 0; i < 10; i++) f.poll();
  assert.equal(f.diagnostics().lifecycle.length, count);
  const g = fixture({ memory, startTime: 15000 });
  assert.ok(g.diagnostics().lifecycle.some(e => e.event === 'fullscreen-change' && e.document === 10000));
  for (let i = 0; i < 120; i++) g.body.dispatchEvent({ type: 'fullscreenerror' });
  assert.equal(g.diagnostics().lifecycle.length, 100);
  assert.ok(memory.get('simple-continuous-play-lifecycle').length < 160000);
});


function transitionWithoutTitle(f, card, number) {
  card.wrapper.isConnected = false; f.root.ownText = '';
  f.video.currentTime = 0; f.video.duration = NaN; f.poll();
  f.video.currentSrc = 'blob:episode' + number; f.video.duration = 1400; f.poll();
  f.video.currentTime = 1; f.poll();
}
test('7 through 11 keeps identity through double resets with no overlay titles', () => {
  const f = fixture({suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
  for (let n=4;n<=11;n++) f.addEpisode(n,'episode '+n, n.toString(16).repeat(64));
  f.root.ownText = 'S1 E7 episode seven'; f.poll();
  for (let n=7;n<=10;n++) {
    f.video.currentTime=1395; const c=nextCard(f,n+1,(n+1).toString(16).repeat(64)); f.poll();
    assert.equal(c.hide.clicks,0,'card retained at episode '+n);
    assert.equal(f.diagnostics().session.targetEpisode,n+1);
    transitionWithoutTitle(f,c,n+1);
    assert.equal(f.diagnostics().session.seriesEpisode,n+1);
    assert.equal(f.diagnostics().session.targetEpisode,null,'hint cannot authorize advance alone');
  }
  assert.equal(f.navigations.length,0);
  assert.ok(f.diagnostics().lifecycle.some(e=>e.event==='episode-handoff-verified'));
});
test('handoff requires matching artwork and cannot authorize fallback without a card', () => {
  const f=fixture({suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
  f.video.currentTime=1395; const c=nextCard(f,2); f.poll(); transitionWithoutTitle(f,c,2);
  f.video.currentTime=1395; const bad=nextCard(f,3,'f'.repeat(64)); f.poll();
  assert.equal(bad.hide.clicks,1); assert.equal(f.diagnostics().session.targetEpisode,null);
  f.end(); f.poll(6000); assert.equal(f.navigations.length,0);
});
test('explicit episode overrides handoff and navigation or late restart discards it', () => {
  for (const kind of ['explicit','route','late']) {
    const f=fixture({suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
    f.video.currentTime=1395; const c=nextCard(f,2); f.poll();
    if (kind==='route') f.location.href='https://www.amazon.co.jp/gp/video/detail/unknown';
    if (kind==='late') f.poll(16000);
    transitionWithoutTitle(f,c,2);
    if (kind==='explicit') {
      f.root.ownText='S1 E1 episode one'; f.poll();
      assert.equal(f.diagnostics().session.seriesEpisode,1);
      assert.equal(f.diagnostics().session.handoff.provisional,false);
    } else assert.equal(f.diagnostics().session.handoff,null);
  }
});


for (const [episode, duration, remaining] of [[12,1454.995,5.824],[1,1444.943,6.044],[1,1444.943,6.213],[1,1400,6.5]]) {
  test('general delay keeps observed terminal card: episode '+episode+' remaining '+remaining, () => {
    const f=fixture({duration,suppressNextUpExperiment:true,nextUpExperimentMode:'delayFallback'});
    for (let n=4;n<=13;n++) f.addEpisode(n,'episode '+n,n.toString(16).repeat(64));
    f.root.ownText='S1 E'+episode+' episode'; f.poll();
    f.document.fullscreenElement=f.root;
    f.video.currentTime=duration-remaining;
    const c=nextCard(f,episode+1,(episode+1).toString(16).repeat(64)); f.poll();
    assert.equal(c.hide.clicks,0);
    assert.equal(f.diagnostics().session.finalCardCheck.reason,'retained');
    assert.equal(f.diagnostics().session.targetEpisode,episode+1);
    assert.equal(f.diagnostics().session.officialCountdown.fullscreenAtCard,true);
    assert.equal(c.card.clicks,0); assert.equal(f.navigations.length,0);
    assert.equal(f.video.paused,false);
  });
}
test('6.5-second margin still rejects early or mismatched cards', () => {
  for (const [mode,remaining,image,reason] of [
    ['delayFallback',6.501,'2'.repeat(64),'card-too-early'],
    ['delayFallback',6.2,'f'.repeat(64),'episode-not-verified']]) {
    const f=fixture({suppressNextUpExperiment:true,nextUpExperimentMode:mode});
    f.video.currentTime=1400-remaining; const c=nextCard(f,2,image); f.poll();
    assert.equal(c.hide.clicks,1);
    assert.equal(f.diagnostics().session.finalCardCheck.reason,reason);
    assert.equal(f.diagnostics().session.officialCountdown,null);
    assert.equal(f.navigations.length,0);
  }
});

test('release ignores persisted experimental options and exposes no playback test commands', () => {
  const f=fixture({earlyNext:true,suppressNextUpExperiment:false,nextUpExperimentMode:'remove'});
  assert.equal(f.diagnostics().nextUpMode,'delayFallback');
  assert.equal(f.diagnostics().nextUpExperiment,true);
  assert.equal(f.diagnostics().earlyNext,false);
  assert.equal(f.pauseTest(),undefined); assert.equal(f.controlsTest(),undefined); assert.equal(f.fullscreenTest(),undefined);
  const next=f.button('次のエピソード'); f.video.currentTime=1399.5; f.poll(12000);
  assert.equal(next.clicks,0); assert.equal(f.video.paused,false);
  f.setting(false); assert.equal(f.diagnostics().enabled,false);
  f.end(); assert.equal(next.clicks,0);
});

test('Firefox failed handoff: retained card plus hidden/reset media is not proof of completed playback', () => {
  const f=fixture({duration:1454.994});
  f.addEpisode(12,'episode twelve','c'.repeat(64)); f.addEpisode(13,'episode thirteen','d'.repeat(64));
  f.root.ownText='S1 E12'; f.poll(); f.document.fullscreenElement=f.root;
  f.video.currentTime=1449.034; const c=nextCard(f,13,'d'.repeat(64)); f.poll();
  assert.equal(c.hide.clicks,0); assert.equal(f.diagnostics().session.targetEpisode,13);
  f.video.currentTime=1454.161; f.video.hidden=true; f.poll();
  f.video.currentTime=0; f.video.currentSrc='blob:new'; f.video.duration=1422; f.poll();
  f.video.currentTime=1276.85; f.video.duration=1421; f.poll(31000);
  assert.equal(f.navigations.length,0);
  assert.equal(f.diagnostics().lastSession.reason,'hidden-without-end');
});
