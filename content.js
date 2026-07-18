// シンプル連続再生 - content.js
// Amazonプライムビデオで OP/ED をスキップせずに次話へ自動遷移する

(function () {
  'use strict';

  const NEXT_EPISODE_BTN_ID = 'atvwebplayersdk-next-episode-button';
  const WATCH_CREDITS_BTN_ID = 'atvwebplayersdk-watch-credits-button';
  const HIDE_RECOMMENDATIONS_SELECTOR = 'button[aria-label="非表示"]';
  const STOP_AUTOPLAY_SELECTOR = 'button[aria-label="Stop Autoplay"]';

  const POLL_INTERVAL_MS = 400; // MutationObserverの取りこぼし対策の定期チェック間隔
  const ADVANCE_RETRY_INTERVAL_MS = 500; // ended後、次のエピソードボタンを探すリトライ間隔
  const ADVANCE_RETRY_MAX = 10; // 最大リトライ回数(合計5秒ほど)

  let enabled = true; // popupのトグルで上書きされる
  let creditsHandled = false; // このエピソードで「クレジットを観る」を処理済みか
  let advanceHandled = false; // このエピソードで次話遷移を処理済みか
  let recsHidden = false; // 「あなたにおすすめの商品」を非表示済みか(映画・TV共通)
  let autoplayStopped = false; // 映画の「Stop Autoplay」を処理済みか
  let currentVideoSrcMarker = null;
  let advanceRetryTimer = null;
  let advanceRetryCount = 0;

  function log(...args) {
    console.log('[シンプル連続再生]', ...args);
  }

  // ---- 設定読み込み ----
  function loadSettings(callback) {
    if (chrome?.storage?.sync) {
      chrome.storage.sync.get({ enabled: true }, (data) => {
        enabled = data.enabled !== false;
        callback();
      });
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.enabled) {
          enabled = changes.enabled.newValue !== false;
          log('拡張機能の状態が変更されました:', enabled ? 'ON' : 'OFF');
        }
      });
    } else {
      callback();
    }
  }

  // ---- エピソードが切り替わった時に状態をリセット ----
  function resetStateForNewEpisode() {
    creditsHandled = false;
    advanceHandled = false;
    recsHidden = false;
    autoplayStopped = false;
    advanceRetryCount = 0;
    if (advanceRetryTimer) {
      clearInterval(advanceRetryTimer);
      advanceRetryTimer = null;
    }
    log('新しいエピソードを検知、状態をリセットしました');
  }

  // ---- 「クレジットを観る」ボタンを自動クリックし、EDの自動スキップをキャンセルする ----
  // 注意: 以前は見つからなかった時の保険として次話カード全体を透明化していたが、
  // Amazon側の自動遷移タイマーが「表示されていない要素」を検知して停止してしまう可能性があるため、
  // ボタン自体のクリック以外は一切DOMに触らないようにする。
  function handleWatchCredits() {
    if (!enabled || creditsHandled) return;
    const btn = document.getElementById(WATCH_CREDITS_BTN_ID);
    if (btn) {
      creditsHandled = true;
      log('「クレジットを観る」ボタンを検知 → 自動クリックしてED自動スキップをキャンセルします');
      btn.click();
    }
  }

  // ---- 「あなたにおすすめの商品」パネルをAmazon純正の「非表示」ボタンで畳む(映画・TV共通) ----
  // 独自CSSで透明化するとAmazon側の内部ロジックに干渉する恐れがあるため、
  // 必ずAmazonが用意しているボタンを実際にクリックする形にする。
  function handleHideRecommendations() {
    if (!enabled || recsHidden) return;
    const btn = document.querySelector(HIDE_RECOMMENDATIONS_SELECTOR);
    if (btn) {
      recsHidden = true;
      log('「非表示」ボタンを検知 → 自動クリックして「あなたにおすすめの商品」を畳みます');
      btn.click();
    }
  }

  // ---- 映画の場合、次作への自動遷移を止める「Stop Autoplay」ボタンを自動クリック ----
  // 映画はTVシリーズと違い「続けて次を見たい」需要が薄いため、ED再生を守った上で次作へは進ませない。
  function handleStopAutoplay() {
    if (!enabled || autoplayStopped) return;
    const btn = document.querySelector(STOP_AUTOPLAY_SELECTOR);
    if (btn) {
      autoplayStopped = true;
      log('「Stop Autoplay」ボタンを検知 → 自動クリックして次作への自動遷移をキャンセルします');
      btn.click();
    }
  }

  // ---- コントロールバーを一瞬表示させる(次のエピソードボタンがマウスホバー時のみDOMに存在する場合の対策) ----
  function nudgePlayerControls() {
    const player = document.querySelector('video')?.closest('div') || document.body;
    ['mousemove', 'mouseover'].forEach((type) => {
      player.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  }

  // ---- 動画が本当に終わったら「次のエピソード」を自動クリック(見つからない場合はリトライ) ----
  function handleVideoEnded() {
    if (!enabled || advanceHandled) return;

    advanceRetryCount = 0;
    if (advanceRetryTimer) clearInterval(advanceRetryTimer);

    advanceRetryTimer = setInterval(() => {
      advanceRetryCount++;
      nudgePlayerControls();

      const btn = document.getElementById(NEXT_EPISODE_BTN_ID);
      if (btn) {
        advanceHandled = true;
        clearInterval(advanceRetryTimer);
        advanceRetryTimer = null;
        log(`動画終了を検知 → 次のエピソードへ自動遷移します(${advanceRetryCount}回目で検出)`);
        btn.click();
        return;
      }

      if (advanceRetryCount >= ADVANCE_RETRY_MAX) {
        clearInterval(advanceRetryTimer);
        advanceRetryTimer = null;
        log('動画は終了しましたが「次のエピソード」ボタンが見つかりませんでした(最終話、または未対応のUI状態の可能性があります)');
      }
    }, ADVANCE_RETRY_INTERVAL_MS);
  }

  function attachVideoListeners(video) {
    if (video.dataset.simpleRenzokuAttached) return;
    video.dataset.simpleRenzokuAttached = '1';

    video.addEventListener('ended', handleVideoEnded);

    video.addEventListener('loadedmetadata', () => {
      const marker = video.currentSrc || video.src;
      if (marker && marker !== currentVideoSrcMarker) {
        currentVideoSrcMarker = marker;
        resetStateForNewEpisode();
      }
    });
  }

  function tick() {
    if (!enabled) return;
    handleWatchCredits();
    handleHideRecommendations();
    handleStopAutoplay();

    const video = document.querySelector('video');
    if (video) attachVideoListeners(video);
  }

  // ---- DOM監視(MutationObserver + ポーリングの二重化で取りこぼしを防ぐ) ----
  const observer = new MutationObserver(tick);

  loadSettings(() => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(tick, POLL_INTERVAL_MS);
    tick();

    log('起動しました。状態:', enabled ? 'ON' : 'OFF');
  });
})();
