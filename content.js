// Simple Continuous Play — keep OP/ED intact; advance only after native media end.
(() => {
  'use strict';
  const VERSION = '1.4.2';
  // #dv-web-player observed on amazon.co.jp, 2026-09-26. Others: compatibility only.
  const PLAYER = '#dv-web-player, .webPlayerSDKContainer, [aria-label="Web Player"]';
  const CONTROL = 'button, [role="button"], a[href]';
  const NEXT_CARD = '.atvwebplayersdk-nextupcard-wrapper';
  const CARD_BUTTON = '.atvwebplayersdk-nextupcard-button';
  const CARD_EPISODE = '.atvwebplayersdk-nextupcard-episode';
  const CARD_HIDE = '.atvwebplayersdk-nextupcardhide-button';
  const ATTRS = ['id', 'data-testid', 'data-test-id', 'data-automation-id'];
  const labels = {
    next: ['次のエピソード', '次のエピソードを再生', '次の話', '次の話を再生', 'next episode',
      'play next episode', 'nächste folge', 'épisode suivant', 'episodio siguiente',
      'prossimo episodio', 'próximo episódio', '다음 에피소드', '下一集'],
    credits: ['クレジットを観る', 'クレジットを見る', 'エンドクレジットを観る',
      'watch credits', 'abspann ansehen', 'voir le générique', 'ver créditos',
      'guarda i titoli di coda', 'assistir aos créditos', '크레딧 보기', '观看片尾', '觀看片尾'],
    stop: ['stop autoplay', '自動再生を停止', '自動再生を停止する', '自動再生をキャンセル',
      'automatische wiedergabe stoppen', 'arrêter la lecture automatique',
      'detener reproducción automática', 'interrompi riproduzione automatica',
      'parar reprodução automática', '자동 재생 중지', '停止自动播放', '停止自動播放'],
    hide: ['非表示', 'hide', 'ausblenden', 'masquer', 'ocultar', 'nascondi', '숨기기', '隐藏', '隱藏'],
  };
  const tokens = {
    next: ['next-episode', 'next-episode-button', 'atvwebplayersdk-next-episode-button'],
    credits: ['watch-credits', 'watch-credits-button', 'atvwebplayersdk-watch-credits-button'],
    stop: ['stop-autoplay', 'stop-autoplay-button', 'atvwebplayersdk-stop-autoplay-button'],
    hide: [],
  };
  const normalize = value => (value || '').normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  let enabled = false;
  const earlyNext = false; // Retained in diagnostic reports for comparison with 1.3.x.
  const nextUpExperiment = true, nextUpMode = 'delayFallback';
  const finalCardMode = () => ['nearEnd2','nearEnd5','compare','delayFallback'].includes(nextUpMode);
  // General-delay observations: 5.824s and 6.213s terminal cards need this margin.
  const finalCardWindow = () => nextUpMode === 'delayFallback' ? 6.5
    : ['nearEnd5','compare'].includes(nextUpMode) ? 5.5 : 2.5;
  let active = null;
  let lastSession = null;
  const MEDIA_EVENTS = ['loadedmetadata', 'durationchange', 'emptied', 'playing', 'seeking', 'pause', 'timeupdate'];
  // Bounded diagnostics only: never store URLs, DOM text, titles or raw selectors.
  const TRACE_KEY = 'simple-continuous-play-lifecycle';
  const lifecycle = [];
  const elementIds = new WeakMap();
  let nextElementId = 0, lastFullscreen = null;
  const diagnosticDocument = Date.now();
  function elementInfo(element) {
    if (!element) return null;
    if (!elementIds.has(element)) elementIds.set(element, ++nextElementId);
    const contains = other => !!other && !!element.contains?.(other);
    return { token: elementIds.get(element), tag: String(element.tagName || '').toLowerCase(),
      connected: element.isConnected === true,
      scope: element === document.documentElement ? 'document' : element === document.body ? 'body'
        : element.matches?.(PLAYER) ? 'player' : element.matches?.('video') ? 'video' : 'other',
      containsPlayer: contains(active?.root), containsVideo: contains(active?.video) };
  }
  function trace(event, session = active, details = {}) {
    const v = session?.video;
    const finite = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    lifecycle.push({ at: Date.now(), document: diagnosticDocument, event,
      video: elementInfo(v), fullscreenTarget: elementInfo(document.fullscreenElement),
      time: finite(v?.currentTime), duration: finite(v?.duration),
      paused: v?.paused ?? null, ended: v?.ended ?? null,
      seriesEpisode: session?.seriesEpisode ?? null, targetEpisode: session?.target?.number ?? null,
      ...details });
    if (lifecycle.length > 100) lifecycle.splice(0, lifecycle.length - 100);
    try { sessionStorage.setItem(TRACE_KEY, JSON.stringify(lifecycle)); } catch { /* optional */ }
  }
  try {
    const raw = sessionStorage.getItem(TRACE_KEY);
    if (raw && raw.length < 160000) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) lifecycle.push(...saved.filter(e => e && Number.isFinite(e.at) &&
        Date.now() >= e.at && Date.now() - e.at < 1800000).slice(-100));
    }
  } catch { /* optional */ }
  function observeFullscreen(trigger) {
    const current = document.fullscreenElement || null;
    if (current !== lastFullscreen || trigger === 'fullscreenchange') {
      trace('fullscreen-change', active, { trigger, previousTarget: elementInfo(lastFullscreen) });
      lastFullscreen = current;
    }
  }
  function observeIdentity(session) {
    if (!session) return;
    const state = { seriesEpisode: session.seriesEpisode ?? null, targetEpisode: session.target?.number ?? null,
      identity: session.episodeIdentity || 'unresolved', locked: !!session.targetLocked };
    const key = JSON.stringify(state);
    if (key !== session.diagnosticIdentity) {
      trace('episode-identity', session, state);
      session.diagnosticIdentity = key;
    }
  }

  const history = [];
  const TRANSITION_KEY = 'simple-continuous-play-transition';
  let previousTransition = null;
  try {
    const raw = sessionStorage.getItem(TRANSITION_KEY);
    if (raw && raw.length < 64000) {
      const saved = JSON.parse(raw);
      if (saved && Date.now() - saved.at >= 0 && Date.now() - saved.at < 1800000) previousTransition = saved;
    }
  } catch { /* Diagnostics must not affect playback when storage is unavailable. */ }
  function networkSnapshot() {
    try { return globalThis.__scpNetworkSnapshot?.() || null; } catch { return null; }
  }
  function saveTransition(session, action, archiveReason = null) {
    const record = { at: Date.now(), scriptVersion: VERSION, action, archiveReason, nextUpMode, earlyNext,
      seriesEpisode: session.seriesEpisode,
      mediaDuration: [...session.samples].reverse().find(s => Number.isFinite(s.duration) && s.duration >= 60)?.duration || null,
      cardObservations: [...session.cardObservations],
      networkObservation: session.networkAtCard || networkSnapshot(),
      finalSamples: session.samples.slice(-8),
      lifecycle: lifecycle.slice(-24),
      earlyCheck: session.earlyCheck, earlyAttempted: session.earlyAttempted,
      officialCountdown: session.officialCountdown || null, fullscreen: !!document.fullscreenElement, cardCheck: session.cardCheck, targetEpisode: session.target?.number || null,
      completed: session.completed, history: [...history] };
    previousTransition = record;
    try { sessionStorage.setItem(TRANSITION_KEY, JSON.stringify(record)); } catch { /* optional */ }
  }
  const hideAttempts = new WeakMap();
  const log = (...args) => {
    history.push({ at: Date.now(), message: args.join(' ') });
    if (history.length > 30) history.shift();
    console.info('[シンプル連続再生]', ...args);
  };

  function visible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let e = element; e; e = e.parentElement) {
      const css = getComputedStyle(e);
      // aria-hidden affects accessibility, not whether media is rendered.
      if (e.hidden || e.inert ||
          css.display === 'none' || css.visibility === 'hidden' || Number(css.opacity) === 0) return false;
    }
    return true;
  }
  function clickable(element) {
    return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' &&
      !['switch', 'checkbox'].includes(element.getAttribute('role')) &&
      getComputedStyle(element).pointerEvents !== 'none';
  }
  function names(element) {
    const refs = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return [element.getAttribute('aria-label'), element.getAttribute('title'),
      refs.map(id => document.getElementById(id)?.textContent || '').join(' '), element.textContent]
      .map(normalize).filter(Boolean);
  }
  function score(element, kind) {
    // Exact tokens / labels: never match generic "Next" or "Play".
    if (ATTRS.some(attr => tokens[kind].includes(normalize(element.getAttribute(attr)))) ||
        (kind === 'next' && element.matches('.atvwebplayersdk-next-episode-button'))) return 2;
    return names(element).some(name => labels[kind].includes(name)) ? 1 : 0;
  }
  function find(root, kind) {
    const selector = kind === 'next' ? CONTROL + ', .atvwebplayersdk-next-episode-button' : CONTROL;
    return [...root.querySelectorAll(selector)].filter(clickable)
      .map(element => ({ element, rank: score(element, kind) }))
      .filter(item => item.rank).sort((a, b) => b.rank - a.rank)[0]?.element || null;
  }
  const first = (root, selector) => root?.querySelectorAll(selector)[0] || null;
  function cardShown(card) {
    // display:contents / zero-sized wrappers can contain a visible real button.
    return visible(first(card, CARD_BUTTON)) || clickable(first(card, CARD_HIDE));
  }
  function retainFinalCard(session, card) {
    if (!enabled || !nextUpExperiment || !finalCardMode() || !session || !cardShown(card)) return false;
    const v = session.video, remaining = v.duration - v.currentTime;
    const reject = reason => {
      session.finalCardCheck = { reason, remaining: Number.isFinite(remaining) ? Math.round(remaining * 100) / 100 : null,
        seriesEpisode: session.seriesEpisode, targetEpisode: session.target?.number || null };
      return false;
    };
    const correctEpisode = ['compare','delayFallback'].includes(nextUpMode)
      ? session.seriesEpisode > 0 && session.target?.from.number === session.seriesEpisode && session.target.number === session.seriesEpisode + 1
      : session.seriesEpisode === 2 && session.target?.number === 3;
    if (!correctEpisode ||
        session.cardCheck?.reason !== 'matched' || session.cardConflict || session.nativeConflict) return reject('episode-not-verified');
    if (recommendationHide(session.root)) return reject('recommendation-panel');
    if (v.seeking || !Number.isFinite(remaining) || remaining < 0 ||
        (v.currentSrc || v.src) !== session.src || location.href !== session.url) return reject('media-state-changed');
    if (remaining > finalCardWindow()) return reject('card-too-early');
    const number = Number(normalize(first(card, CARD_EPISODE)?.textContent).match(/^e\s*(\d+)$/)?.[1]);
    if (number !== session.target.number || !artwork(first(card, CARD_BUTTON) || card).some(key => session.target.imageKeys.includes(key))) return reject('card-mismatch');
    session.finalCardCheck = { reason: 'retained', remaining: Math.round(remaining * 100) / 100,
      seriesEpisode: session.seriesEpisode, targetEpisode: session.target.number };
    if (!session.officialCountdown) {
      session.officialCountdown = { at: Date.now(), remaining, fullscreenAtCard: !!document.fullscreenElement };
      recordCard(session, 'retained');
      session.networkAtCard = networkSnapshot();
      log('終了直前のNext Upを保持。公式の次話送りを待機。次話:', session.target.number, '残り秒:', Math.round(remaining * 100) / 100);
      saveTransition(session, 'official-countdown-retained');
    }
    return true;
  }
  function recordCard(session, action) {
    const v = session.video;
    const finite = n => Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
    session.cardObservations.push({ at: Date.now(), action, time: finite(v.currentTime), duration: finite(v.duration),
      remaining: finite(v.duration - v.currentTime), seriesEpisode: session.seriesEpisode,
      targetEpisode: session.target?.number || null, fullscreen: !!document.fullscreenElement,
      reason: session.finalCardCheck?.reason || session.cardCheck?.reason || null });
    if (session.cardObservations.length > 10) session.cardObservations.shift();
  }
  function hideNextUp(root) {
    for (const hide of root.querySelectorAll(CARD_HIDE)) {
      if (!clickable(hide) || !hide.closest(NEXT_CARD)) continue;
      if (active?.root === root && retainFinalCard(active, hide.closest(NEXT_CARD))) continue;
      const state = hideAttempts.get(hide) || { count: 0, at: -Infinity };
      if (state.count >= 3 || Date.now() - state.at < 500) continue;
      if (state.count === 0) {
        if (active?.root === root) {
          recordCard(active, 'hidden');
          if (nextUpExperiment && nextUpMode === 'delayFallback')
            log('遅延試験: 保持条件外のカードを保護のためHide。理由:', active.finalCardCheck?.reason || '未照合');
        }
        if (active?.root === root && active.finalCardCheck) log('最終カード判定:', active.finalCardCheck.reason);
        const video = selectVideo();
        if (video) log('Next Up検出 再生秒:', Math.round(video.currentTime * 100) / 100, '残り秒:', Math.round((video.duration - video.currentTime) * 100) / 100);
      }
      hideAttempts.set(hide, { count: state.count + 1, at: Date.now() });
      log('操作: hideNext 試行:', state.count + 1);
      trace('hide-next-up', active, { reason: active?.finalCardCheck?.reason || 'unverified' });
      hide.click();
    }
  }
  function rememberSeries(session) {
    const text = normalize(session.root.textContent);
    const matches = [...text.matchAll(/\bs\s*\d+\s*e\s*(\d+)\b/g),
      ...text.matchAll(/シーズン\s*\d+\s*[,、・]?\s*エピソード\s*(\d+)/g)];
    const numbers = [...new Set(matches.map(m => Number(m[1])))];
    if (!session.targetLocked && numbers.length === 1) {
      session.seriesEpisode = numbers[0];
      session.handoffProvisional = false;
    }
    for (const card of [...session.root.querySelectorAll(NEXT_CARD)].filter(cardShown)) {
      const next = Number(normalize(first(card, CARD_EPISODE)?.textContent).match(/^e\s*(\d+)$/)?.[1]);
      if (next && session.seriesEpisode && next !== session.seriesEpisode + 1) session.nativeConflict = true;
    }
  }
  function playURL(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:' || url.origin !== new URL(location.href).origin ||
          url.username || url.password || url.searchParams.get('autoplay') !== '1' ||
          !/^\/(?:gp\/video\/detail|detail)\/[a-z0-9]+\/?$/i.test(url.pathname)) return null;
      // The observed episode links use t=seconds, including resume offsets.
      // Start the next episode at the beginning, rather than a stored resume point.
      url.searchParams.set('t', '0');
      return url.href;
    } catch { return null; }
  }
  function artwork(root) {
    return [...root.querySelectorAll('img')].map(img =>
      (img.getAttribute('src') || '').match(/\/pv-target-images\/([a-f0-9]{64})(?:[._/]|$)/i)?.[1]?.toLowerCase()
    ).filter(Boolean);
  }
  function episodeRows() {
    // Observed on the real detail page. Recommendations live in a different panel.
    const panel = document.getElementById('tab-content-episodes');
    if (!panel) return [];
    return [...panel.querySelectorAll('[data-testid="episode-list-item"]')].map(row => {
      const title = normalize(first(row, 'h3')?.textContent);
      const number = Number(title.match(/^(\d+)\s*\./)?.[1]);
      const urls = [...new Set([...row.querySelectorAll('[data-testid="episodes-playbutton"]')]
        .filter(a => !a.disabled && a.getAttribute('aria-disabled') !== 'true')
        .map(a => a.getAttribute('href')).filter(Boolean).map(playURL).filter(Boolean))];
      if (!number || urls.length !== 1) return null;
      const imageKeys = artwork(first(row, '[data-testid="episode-packshot"]') || row);
      return { number, title: title.replace(/^\d+\s*\.\s*/, ''), url: urls[0], imageKeys };
    }).filter(Boolean);
  }
  function currentEpisode(session, rows) {
    const path = new URL(location.href).pathname;
    const byPath = rows.filter(row => new URL(row.url).pathname === path);
    const text = normalize(session.root.textContent);
    const matches = [...text.matchAll(/\bs\s*(\d+)\s*e\s*(\d+)\b/g),
      ...text.matchAll(/シーズン\s*(\d+)\s*[,、・]?\s*エピソード\s*(\d+)/g)];
    const numbers = [...new Set(matches.map(m => Number(m[2])))];
    // Episode titles may be absent or formatted differently when controls hide.
    // An explicit player episode number must not fall back to a stale page URL.
    session.episodeIdentity = 'unresolved';
    if (numbers.length > 1) { session.episodeIdentity = 'ambiguous-player'; return null; }
    let number = numbers.length === 1 ? numbers[0] : session.seriesEpisode;
    if (!number && session.handoff) {
      const matching = rows.filter(row => row.number === session.handoff.number && row.url === session.handoff.url);
      if (matching.length === 1) {
        number = session.handoff.number;
        session.seriesEpisode = number;
        session.handoffProvisional = true;
        trace('episode-handoff-used', session, { expectedEpisode: number });
      }
    }
    if (number) {
      const byNumber = rows.filter(row => row.number === number);
      session.episodeIdentity = byNumber.length === 1 ? (session.handoffProvisional ? 'official-transition-provisional' : 'player-episode-number') : 'ambiguous-list';
      return byNumber.length === 1 ? byNumber[0] : null;
    }
    session.episodeIdentity = byPath.length === 1 ? 'page-url' : 'unresolved';
    return byPath.length === 1 ? byPath[0] : null;
  }
  function rememberNext(session) {
    const rows = episodeRows();
    if (!rows.length) return;
    const current = session.targetLocked ? session.currentEpisode : currentEpisode(session, rows);
    if (!session.targetLocked && (session.episodeIdentity === 'ambiguous-player' || session.episodeIdentity === 'ambiguous-list' ||
        (!current && session.seriesEpisode && session.currentEpisode?.number !== session.seriesEpisode))) {
      session.currentEpisode = null; session.target = null; return;
    }
    if (current) {
      if (session.currentEpisode && current.number !== session.currentEpisode.number)
        log('現在話をプレイヤー表示で更新:', current.number);
      session.currentEpisode = current;
    }
    const known = current || session.currentEpisode;
    if (!known) return;
    const sameCurrent = rows.filter(row => row.number === known.number && row.url === known.url && row.title === known.title);
    if (sameCurrent.length !== 1) { session.target = null; return; }
    const nextRows = rows.filter(row => row.number === known.number + 1);
    if (nextRows.length !== 1) { session.target = null; return; }
    const target = nextRows[0];
    // When Next Up exists, require its episode number AND artwork to agree.
    // This is evidence for the specific episode, not a guess from "Next up".
    const cards = [...session.root.querySelectorAll(NEXT_CARD)].filter(cardShown);
    if (cards.length) session.cardEvidence = cards.map(card => ({
      number: Number(normalize(first(card, CARD_EPISODE)?.textContent).match(/^e\s*(\d+)$/)?.[1]) || null,
      imageKeys: artwork(first(card, CARD_BUTTON) || card),
    }));
    for (const evidence of session.cardEvidence) {
      const reason = !evidence.number || !evidence.imageKeys.length || !target.imageKeys.length
        ? 'card-data-incomplete' : evidence.number !== target.number
          ? 'episode-number-mismatch' : !evidence.imageKeys.some(key => target.imageKeys.includes(key))
            ? 'artwork-mismatch' : null;
      if (reason) {
        session.target = null;
        session.cardConflict = reason !== 'card-data-incomplete';
        if (session.cardCheck?.reason !== reason || session.cardCheck?.expectedEpisode !== target.number) {
          log('Next Up照合:', reason, '候補:', target.number, 'カード:', evidence.number ?? '未取得');
        }
        session.cardCheck = { reason, expectedEpisode: target.number, cardEpisode: evidence.number,
          cardImageCount: evidence.imageKeys.length, listImageCount: target.imageKeys.length };
        return;
      }
    }
    // A transition hint alone must never authorize list navigation or a click.
    // Require the new card's episode AND artwork to match the next list row.
    if (session.handoffProvisional && !session.cardEvidence.length) {
      session.target = null;
      session.cardCheck = { reason: 'awaiting-card-after-handoff', expectedEpisode: target.number };
      return;
    }
    session.cardConflict = false;
    session.cardCheck = { reason: session.cardEvidence.length ? 'matched' : 'no-card', expectedEpisode: target.number };
    if (session.cardEvidence.length) session.nativeConflict = false;
    if (!session.target) log('次話を一覧で確認:', target.number);
    session.target = { ...target, from: known };
    if (session.cardEvidence.length && !session.targetLocked) {
      if (session.handoffProvisional) trace('episode-handoff-verified', session, { expectedEpisode: known.number, nextEpisode: target.number });
      session.handoffProvisional = false;
      session.targetLocked = true;
      session.seriesEpisode = known.number;
      log('Next Upと照合し次話を固定:', target.number);
    }
  }
  function selectVideo() {
    return [...document.querySelectorAll('video')].filter(video => {
      const rect = video.getBoundingClientRect();
      return video.closest(PLAYER) && visible(video) && Number.isFinite(video.duration) &&
        video.duration >= 60 && rect.width >= innerWidth * 0.4 && rect.height >= innerHeight * 0.4;
    }).sort((a, b) => {
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      return y.width * y.height - x.width * x.height;
    })[0] || null;
  }
  function reset(session) {
    const now = Date.now(), v = session.video;
    const rows = episodeRows();
    const target = session.target;
    const recentEnd = session.samples?.some(s => Number.isFinite(s.duration) && s.duration >= 60 &&
      s.time >= s.duration - 10 && now - s.at <= 15000);
    const sameRoute = session.url === location.href;
    let handoff = null;
    if (sameRoute && v.currentTime <= 10 && session.officialCountdown && target &&
        session.cardCheck?.reason === 'matched' && recentEnd &&
        rows.filter(r => r.number === target.number && r.url === target.url).length === 1) {
      handoff = { number: target.number, url: target.url, at: now };
      trace('episode-handoff-created', session, { expectedEpisode: target.number });
    } else if (sameRoute && v.currentTime <= 10 && session.handoff && now - session.handoff.at <= 15000) {
      handoff = session.handoff;
      trace('episode-handoff-loading', session, { expectedEpisode: handoff.number });
    }
    session.handoff = handoff;
    session.handoffProvisional = false;
    trace('session-reset', session, { sourceChanged: !!session.src && session.src !== (session.video.currentSrc || session.video.src), previousTime: session.lastTime ?? null });
    session.diagnosticIdentity = null;
    session.diagnosticMedia = null;
    if (session.samples) archiveSession(session, 'source-or-restart');
    session.src = session.video.currentSrc || session.video.src;
    session.url = location.href;
    session.lastTime = session.video.currentTime;
    session.deadline = 0;
    session.expired = false;
    session.count = { credits: 0, stop: 0, hide: 0, next: 0 };
    session.lastClick = {};
    session.lastNudge = 0;
    session.target = null;
    session.targetLocked = false;
    session.officialCountdown = null;
    session.finalCardCheck = null;
    session.cardObservations = [];
    session.networkAtCard = null;
    session.episodeIdentity = 'unresolved';
    session.earlyAttempted = false;
    session.earlyCheck = null;
    session.advanceBlocked = null;
    session.currentEpisode = null;
    session.cardConflict = false;
    session.cardEvidence = [];
    session.cardCheck = null;
    session.completed = false;
    session.count.hideNext = 0;
    session.navigated = false;
    session.nativeAttemptAt = null;
    session.seriesEpisode = null;
    session.nativeConflict = false;
    session.suspendedSince = null;
    session.routeInvalidated = false;
    session.samples = [];
  }
  function sample(session, event) {
    const v = session.video;
    const number = x => Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
    const media = { duration: number(v.duration), sourceChanged: (v.currentSrc || v.src) !== session.src, connected: v.isConnected, visible: visible(v) };
    const mediaKey = JSON.stringify(media);
    if (mediaKey !== session.diagnosticMedia || ['loadedmetadata', 'durationchange', 'emptied', 'playing', 'seeking', 'pause', 'ended'].includes(event)) {
      trace('media-state', session, { trigger: event, ...media });
      session.diagnosticMedia = mediaKey;
    }
    const entry = { at: Date.now(), event, time: number(v.currentTime), duration: number(v.duration),
      ended: v.ended, paused: v.paused, seeking: v.seeking, connected: v.isConnected,
      visible: visible(v), sourceChanged: (v.currentSrc || v.src) !== session.src };
    // Polling keeps a final sample even if timeupdate stops. Do not duplicate
    // synchronous DOM mutations dozens of times within the same clock tick.
    const previous = session.samples.at(-1);
    if (event === 'poll' && previous && entry.at - previous.at < 200) return;
    if (event === 'poll' && previous && Object.keys(entry).every(key =>
      key === 'at' || key === 'event' || entry[key] === previous[key])) return;
    session.samples.push(entry);
    if (session.samples.length > 30) session.samples.shift();
  }
  function archiveSession(session, reason) {
    trace('session-archive', session, { reason });
    if (session.officialCountdown && !session.navigated) saveTransition(session, 'official-countdown-monitor-ended', reason);
    else if (['compare','delayFallback'].includes(nextUpMode) && session.cardObservations.length && !session.navigated) saveTransition(session, 'comparison-monitor-ended', reason);
    lastSession = { reason, at: Date.now(), completed: session.completed,
      targetEpisode: session.target?.number || null, seriesEpisode: session.seriesEpisode,
      cardObservations: [...session.cardObservations], lastTime: session.lastTime, samples: [...session.samples] };
    log('監視状態を保存:', reason);
  }
  function detach(reason = 'video-replaced') {
    if (!active) return;
    archiveSession(active, reason);
    active.video.removeEventListener('ended', onEnded);
    for (const event of MEDIA_EVENTS) {
      active.video.removeEventListener(event, onMediaEvent);
    }
    active = null;
  }
  function bind(video) {
    detach();
    active = { video, root: video.closest(PLAYER) };
    reset(active);
    rememberSeries(active);
    rememberNext(active);
    video.addEventListener('ended', onEnded);
    for (const event of MEDIA_EVENTS) {
      video.addEventListener(event, onMediaEvent);
    }
  }
  function onMediaEvent(event) {
    if (!enabled || !active || event.target !== active.video) return;
    sample(active, event.type);
    tick();
  }
  function click(session, kind, button) {
    if (!enabled || active !== session || !clickable(button) || !session.root.contains(button)) return false;
    const now = Date.now();
    // Retry ignored clicks, but cap attempts across DOM replacements too.
    if (session.count[kind] >= 3 || now - (session.lastClick[kind] ?? -Infinity) < 500) return false;
    session.count[kind]++;
    session.lastClick[kind] = now;
    log('操作:', kind, '試行:', session.count[kind]);
    button.click();
    return true;
  }
  function recommendationHide(root) {
    for (const button of root.querySelectorAll(CONTROL)) {
      if (!clickable(button) || button.matches(CARD_HIDE) || !score(button, 'hide')) continue;
      // Generic "Hide" elsewhere must never be clicked.
      for (let panel = button.parentElement; panel && panel !== root; panel = panel.parentElement) {
        const text = normalize(panel.textContent);
        if (/あなたにおすすめの商品|recommended for you|products in this video|このビデオの商品/.test(text)) return button;
      }
    }
    return null;
  }
  function cancelAutoplay(session) {
    // Remember the independent episode-list URL BEFORE native Hide removes the card.
    if (!session.completed) {
      rememberSeries(session);
      rememberNext(session);
    }
    if (!session.completed && (session.video.seeking || session.video.duration - session.video.currentTime > finalCardWindow())) session.officialCountdown = null;
    hideNextUp(session.root);
    if ([...session.root.querySelectorAll(NEXT_CARD)].some(card => retainFinalCard(session, card))) return;
    const credits = find(session.root, 'credits');
    if (credits) click(session, 'credits', credits);
    const recommendations = recommendationHide(session.root);
    // Recommendations may count down even AFTER media end. Stop before hiding.
    if (recommendations || (!credits && session.count.credits === 0 &&
        (session.completed || session.video.currentTime >= session.video.duration * 0.8))) {
      const stop = find(session.root, 'stop');
      if (stop) click(session, 'stop', stop);
    }
    if (recommendations) click(session, 'hide', recommendations);
  }
  function complete(session) {
    const video = session.video;
    if (session.completed || !video.ended || video.seeking || !Number.isFinite(video.duration) ||
        video.duration < 60 || (video.currentSrc || video.src) !== session.src ||
        location.href !== session.url) return;
    session.completed = true;
    session.deadline = Date.now() + 30000;
    if (session.officialCountdown) saveTransition(session, 'official-countdown-wait');
    else if (['compare','delayFallback'].includes(nextUpMode)) saveTransition(session, 'comparison-media-ended');
    log('動画終了を検知。次話候補:', session.target?.number ?? '未特定');
  }
  function onEnded(event) {
    if (!enabled || !active || event.target !== active.video) return;
    sample(active, 'ended-event');
    log('endedイベントを受信');
    complete(active);
    queueMicrotask(tick);
  }
  function nudge(session) {
    if (Date.now() - session.lastNudge < 1000) return;
    session.lastNudge = Date.now();
    const rect = session.root.getBoundingClientRect();
    const options = { bubbles: true, view: window, clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2 };
    const top = document.elementFromPoint?.(options.clientX, options.clientY);
    const targets = new Set([session.video, session.root]);
    // The video is often covered by a sibling interaction layer. DOM events
    // dispatched on video do not reach that sibling's handlers.
    if (top && session.root.contains(top)) targets.add(top);
    for (const target of targets) {
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        target.dispatchEvent(new MouseEvent(type, { ...options, bubbles: type !== 'mouseenter' }));
      }
      if (typeof PointerEvent !== 'undefined') {
        for (const type of ['pointerover', 'pointerenter', 'pointermove']) {
          target.dispatchEvent(new PointerEvent(type, { ...options, bubbles: type !== 'pointerenter', pointerType: 'mouse' }));
        }
      }
    }
  }
  function advance(session) {
    if (!enabled || active !== session || !session.completed || session.navigated || session.expired ||
        location.href !== session.url) return;
    const now = Date.now();
    if (now >= session.deadline) {
      session.expired = true;
      log('次話への移動を確認できませんでした。最終話または未対応のUIの可能性があります。');
      return;
    }
    const target = session.target;
    const blocked = reason => {
      if (session.advanceBlocked !== reason) log('次話待機:', reason);
      session.advanceBlocked = reason;
    };
    if (session.officialCountdown && nextUpExperiment && finalCardMode() &&
        now < session.deadline - 30000 + 7000) {
      blocked('official-countdown-wait'); return;
    }
    // A recognized TV episode and the explicit native next-episode control do
    // not require the detail-page list. Only URL navigation needs that proof.
    if (!session.nativeConflict && !session.cardConflict && (session.seriesEpisode || target) &&
        session.nativeAttemptAt === null && session.root.isConnected) {
      nudge(session);
      const next = find(session.root, 'next');
      if (next && click(session, 'next', next)) {
        session.nativeAttemptAt = now;
        return;
      }
      if (now < session.deadline - 30000 + 1200) { blocked('native-control-wait'); return; }
    }
    if (!target || session.cardConflict) {
      blocked(session.cardConflict ? 'card-conflict' : 'no-verified-target');
      if (session.root.isConnected) nudge(session);
      return;
    }
    // Recheck the same season's rows, including after the player closes itself.
    const rows = episodeRows();
    const sameEpisode = (a, b) => a.number === b.number && new URL(a.url).pathname === new URL(b.url).pathname;
    const from = rows.filter(r => sameEpisode(r, target.from));
    const to = rows.filter(r => sameEpisode(r, target));
    if (from.length !== 1 || to.length !== 1 || target.number !== target.from.number + 1 ||
        new URL(target.url).pathname === new URL(target.from.url).pathname || playURL(target.url) !== target.url) {
      blocked(`episode-list-mismatch from=${from.length} to=${to.length}`);
      return;
    }
    // One native click only. If it gives no observable transition, use the
    // already verified URL rather than repeatedly clicking a moving control.
    if (session.nativeAttemptAt !== null && now - session.nativeAttemptAt < 5000) return;
    session.navigated = true;
    session.advanceBlocked = null;
    log('動画終了を確認 → 保存した同一シーズンの次話を開始:', target.number);
    saveTransition(session, 'verified-url-fallback');
    location.assign(to[0].url);
  }
  function tick() {
    observeFullscreen('poll');
    try { playbackTick(); } finally { observeIdentity(active); }
  }
  function playbackTick() {
    if (!enabled) return;
    const candidate = selectVideo();
    if (active && location.href !== active.url) {
      if (candidate && candidate !== active.video) {
        detach('page-changed');
        bind(candidate);
      } else if (active.video.ended && (active.video.currentSrc || active.video.src) === active.src) {
        // A route change must not rebind the old ended element as a new episode.
        if (!active.routeInvalidated) archiveSession(active, 'page-changed');
        active.routeInvalidated = true;
        return;
      } else {
        reset(active);
      }
    }
    // The site's own ended handler may remove the entire player. A completion
    // captured before removal authorizes only the already verified next URL.
    if (active?.completed && (!active.video.isConnected || !active.root.isConnected)) {
      if (candidate) { detach(); bind(candidate); }
      else { advance(active); return; }
    }
    // Do not detach an ended listener merely because the site hides or removes
    // the surface first. Keep it for a bounded grace period; hidden != ended.
    if (candidate && candidate !== active?.video) bind(candidate);
    if (!active) {
      // This exact native cancellation button is safe to recognize independently
      // of media duration/size readiness. Never advance from this branch.
      for (const root of document.querySelectorAll(PLAYER)) {
        if (root.querySelectorAll('video').length) hideNextUp(root);
      }
      return;
    }
    const session = active, video = session.video;
    sample(session, 'poll');
    if (!video.isConnected || !session.root.isConnected || !visible(video)) {
      if (session.suspendedSince === null) {
        session.suspendedSince = Date.now();
        log('動画が非表示または切断。終了通知を待機');
      }
      complete(session);
      if (session.completed) { advance(session); return; }
      if (Date.now() - session.suspendedSince >= 30000) detach('hidden-without-end');
      return;
    }
    session.suspendedSince = null;
    const source = video.currentSrc || video.src;
    if (session.url !== location.href) {
      // SPA navigation may leave the old ended media and its controls mounted.
      if (video.ended && source === session.src) return;
      reset(session);
    }
    if (source !== session.src || video.currentTime < session.lastTime - 20 ||
        (session.completed && !video.ended)) reset(session);
    session.lastTime = video.currentTime;
    if (candidate !== video && !video.ended) {
      rememberSeries(session);
      rememberNext(session);
      hideNextUp(session.root);
      return;
    }
    if (!Number.isFinite(video.duration) || video.duration < 60 || video.seeking) return;
    complete(session);
    cancelAutoplay(session);
    if (session.completed) advance(session);
  }
  function setEnabled(value) {
    enabled = value !== false;
    log('有効状態:', enabled ? 'ON' : 'OFF');
    if (!enabled) { detach('disabled'); }
    else tick();
  }
  let pending = false;
  function diagnostics() {
    const finite = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
    const summarize = element => {
      const rect = element.getBoundingClientRect();
      return { visible: visible(element), clickable: clickable(element), width: Math.round(rect.width),
        height: Math.round(rect.height), inPlayer: !!element.closest(PLAYER) };
    };
    return {
      scriptVersion: VERSION, enabled, earlyNext, nextUpExperiment, nextUpMode, fullscreen: !!document.fullscreenElement, earlyPending: false, topFrame: window === window.top,
      viewport: { width: innerWidth, height: innerHeight },
      players: document.querySelectorAll(PLAYER).length,
      videos: [...document.querySelectorAll('video')].map(v => ({ ...summarize(v),
        duration: finite(v.duration), time: finite(v.currentTime), paused: v.paused, ended: v.ended,
        seeking: v.seeking, selected: v === active?.video })),
      hideButtons: [...document.querySelectorAll(CARD_HIDE)].map(b => ({ ...summarize(b),
        inCard: !!b.closest(NEXT_CARD), attempts: hideAttempts.get(b)?.count || 0 })),
      nextButtons: [...document.querySelectorAll('#atvwebplayersdk-next-episode-button')].map(summarize),
      episodeRows: episodeRows().length,
      session: active ? { completed: active.completed, seriesEpisode: active.seriesEpisode,
        handoff: active.handoff ? { expectedEpisode: active.handoff.number, at: active.handoff.at, provisional: active.handoffProvisional } : null,
        cardObservations: [...active.cardObservations], officialCountdown: active.officialCountdown, finalCardCheck: active.finalCardCheck, episodeIdentity: active.episodeIdentity, targetLocked: active.targetLocked, advanceBlocked: active.advanceBlocked,
        cardCheck: active.cardCheck, earlyCheck: active.earlyCheck || null,
        targetEpisode: active.target?.number || null, nativeConflict: active.nativeConflict,
        cardConflict: active.cardConflict, nativeAttempted: active.nativeAttemptAt !== null,
        suspended: active.suspendedSince !== null, samples: [...active.samples] } : null,
      lastSession, previousTransition,
      fullscreenTarget: elementInfo(document.fullscreenElement), lifecycle: [...lifecycle],
      history: [...history],
    };
  }
  globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type === 'scp-diagnostics') respond(diagnostics());
  });
  trace('diagnostics-start');
  document.addEventListener('fullscreenchange', () => observeFullscreen('fullscreenchange'), true);
  document.addEventListener('fullscreenerror', () => {
    trace('fullscreen-error');
  }, true);
  // Capture phase runs before the normal player ended handler can unmount video.
  document.addEventListener('ended', onEnded, true);
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; tick(); });
  });
  const storage = globalThis.chrome?.storage;
  storage?.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.enabled) setEnabled(changes.enabled.newValue);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-label',
      'aria-labelledby', 'aria-disabled', 'disabled', 'id', 'data-testid', 'data-test-id', 'data-automation-id', 'href', 'src'],
    characterData: true });
  setInterval(tick, 400);
  // Ignore obsolete test preferences; preserve only the user's master ON/OFF.
  if (storage?.sync) storage.sync.get({ enabled: true }, data => {
    setEnabled(data.enabled);
  });
  else setEnabled(true);
})();
