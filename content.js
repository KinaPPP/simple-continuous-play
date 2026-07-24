// シンプル連続再生 - content.js
// Amazonプライムビデオで OP/ED をスキップせずに次話へ自動遷移する

(function () {
  'use strict';

  const NEXT_EPISODE_BTN_ID = 'atvwebplayersdk-next-episode-button';
  const WATCH_CREDITS_BTN_ID = 'atvwebplayersdk-watch-credits-button';
  const STOP_AUTOPLAY_SELECTOR = 'button[aria-label="Stop Autoplay"]';
  const SKIP_INTRO_SELECTOR = 'button[aria-label="イントロをスキップ"]';
  // 「非表示」ボタンはUIパイプラインによってclass名が変わりaria-labelも付かないことがある
  // (FreeVee系コンテンツなど)。テキスト内容(日本語/英語)で探すのが一番安定する。
  const HIDE_RECOMMENDATIONS_TEXTS = ['非表示', 'hide'];

  const POLL_INTERVAL_MS = 400; // MutationObserverの取りこぼし対策の定期チェック間隔
  const ADVANCE_RETRY_INTERVAL_MS = 500; // ended後、次のエピソードボタンを探すリトライ間隔
  const ADVANCE_RETRY_MAX = 20; // 最大リトライ回数(合計10秒ほど)

  let enabled = true; // popupのトグルで上書きされる
  let creditsHandled = false; // このエピソードで「クレジットを観る」を処理済みか
  let advanceHandled = false; // このエピソードで次話遷移を処理済みか
  let recsHidden = false; // 「あなたにおすすめの商品」を非表示済みか(映画・TV共通)
  let autoplayStopped = false; // 映画の「Stop Autoplay」を処理済みか
  let currentVideoSrcMarker = null;
  let lastKnownTime = 0;
  let lastKnownDuration = 0;
  const BACKWARD_JUMP_THRESHOLD_SEC = 20; // これ以上巻き戻ったら新しいエピソード開始とみなす
  const DURATION_CHANGE_THRESHOLD_SEC = 5; // 尺がこれ以上変わったら新しいエピソードとみなす
  const BOUNDARY_CONFIRM_TICKS = 3; // 巻き戻り/尺変化がこの回数連続で観測されたら確定(瞬間的なブレを無視)
  const SELF_ACTION_SUPPRESS_MS = 4000; // 自分でボタンをクリックした直後はこの時間、境界判定を止める
  let boundaryCandidateTicks = 0;
  let suppressBoundaryUntil = 0;
  let introSkipButtonVisible = false; // 「イントロをスキップ」が今表示中か(出現の立ち上がりだけを検知するため)
  let advanceRetryTimer = null;
  let advanceRetryCount = 0;

  function log(...args) {
    console.log('[シンプル連続再生]', ...args);
  }

  // ---- 自分自身のクリック直後は境界判定を一時停止する(誤検知の連鎖防止) ----
  function suppressBoundaryChecks() {
    suppressBoundaryUntil = Date.now() + SELF_ACTION_SUPPRESS_MS;
    boundaryCandidateTicks = 0;
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
    boundaryCandidateTicks = 0;
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
      suppressBoundaryChecks();
    }
  }

  // ---- テキスト内容からボタンを探す(class名やaria-labelがUIパイプラインごとに変わる対策) ----
  function findButtonByText(texts) {
    const targets = texts.map((t) => t.toLowerCase());
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text && targets.includes(text)) return btn;
    }
    return null;
  }

  // ---- 「あなたにおすすめの商品」パネルをAmazon純正の「非表示」ボタンで畳む(映画・TV共通) ----
  // 独自CSSで透明化するとAmazon側の内部ロジックに干渉する恐れがあるため、
  // 必ずAmazonが用意しているボタンを実際にクリックする形にする。
  // class名やaria-labelがUIパイプライン(通常/FreeVee等)によって変わるため、テキスト内容で探す。
  function handleHideRecommendations() {
    if (!enabled || recsHidden) return;
    const btn = findButtonByText(HIDE_RECOMMENDATIONS_TEXTS);
    if (btn) {
      recsHidden = true;
      log('「非表示」ボタンを検知 → 自動クリックして「あなたにおすすめの商品」を畳みます');
      btn.click();
      suppressBoundaryChecks();
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
      suppressBoundaryChecks();
    }
  }

  // ---- コントロールバーを一瞬表示させる(次のエピソードボタンがマウスホバー時のみDOMに存在する場合の対策) ----
  // 座標なしのイベントだと「カーソルがプレイヤー領域内にあるか」判定に引っかかって
  // コントロールバーが実際には表示されないことがあるため、動画の中心座標を指定して送る。
  function nudgePlayerControls(video) {
    if (!video) return;
    const rect = video.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    const targets = [video, video.parentElement, document].filter(Boolean);
    const types = ['pointermove', 'mousemove', 'mouseover', 'mouseenter'];
    targets.forEach((target) => {
      types.forEach((type) => {
        try {
          target.dispatchEvent(new MouseEvent(type, opts));
        } catch (e) {
          /* 一部のイベントタイプ/ターゲットの組み合わせは無視してよい */
        }
      });
    });
  }

  // ---- 診断用: 次のエピソードボタンが見つからなかった時、その瞬間存在するボタンをログに出す ----
  function logAvailableButtonsForDebug() {
    const labels = Array.from(document.querySelectorAll('button[aria-label], button[id]'))
      .map((b) => b.id || b.getAttribute('aria-label'))
      .filter(Boolean);
    log('現在DOM上にあるボタン一覧(診断用):', labels);
  }

  // ---- 動画が本当に終わったら「次のエピソード」を自動クリック(見つからない場合はリトライ) ----
  function handleVideoEnded(video) {
    if (!enabled || advanceHandled) return;

    advanceRetryCount = 0;
    if (advanceRetryTimer) clearInterval(advanceRetryTimer);

    advanceRetryTimer = setInterval(() => {
      advanceRetryCount++;
      nudgePlayerControls(video);

      const btn = document.getElementById(NEXT_EPISODE_BTN_ID);
      if (btn) {
        advanceHandled = true;
        clearInterval(advanceRetryTimer);
        advanceRetryTimer = null;
        log(`動画終了を検知 → 次のエピソードへ自動遷移します(${advanceRetryCount}回目で検出)`);
        btn.click();
        suppressBoundaryChecks();
        return;
      }

      if (advanceRetryCount >= ADVANCE_RETRY_MAX) {
        clearInterval(advanceRetryTimer);
        advanceRetryTimer = null;
        log('動画は終了しましたが「次のエピソード」ボタンが見つかりませんでした(最終話、または未対応のUI状態の可能性があります)');
        logAvailableButtonsForDebug();
      }
    }, ADVANCE_RETRY_INTERVAL_MS);
  }

  // ---- loadedmetadataが発火しないシームレス連結再生対策:
  // 再生位置の巻き戻り、または尺(duration)の大きな変化から「新しいエピソードが始まった」を検知する。
  // 自分自身のボタンクリック直後の一瞬のブレを拾わないよう、抑制ウィンドウと連続確認(デバウンス)を設ける。
  // 注意: 確認中(candidateTicks>0)は基準値を更新しない。ここで基準値を更新してしまうと
  // 差分が1ティックしか観測されず、3回連続確認に絶対到達できなくなる(以前のバグ)。
  function checkForEpisodeBoundary(video) {
    if (!video || Number.isNaN(video.currentTime)) return;

    if (Date.now() < suppressBoundaryUntil) {
      // 抑制中は基準値も更新しない(抑制解除直後にその場のブレで誤反応しないようにするため)
      return;
    }

    const t = video.currentTime;
    const d = Number.isFinite(video.duration) ? video.duration : 0;

    const jumpedBackward = t < lastKnownTime - BACKWARD_JUMP_THRESHOLD_SEC;
    const durationChanged =
      lastKnownDuration > 0 && d > 0 && Math.abs(d - lastKnownDuration) > DURATION_CHANGE_THRESHOLD_SEC;

    if (jumpedBackward || durationChanged) {
      boundaryCandidateTicks++;
      if (boundaryCandidateTicks >= BOUNDARY_CONFIRM_TICKS) {
        resetStateForNewEpisode();
        boundaryCandidateTicks = 0;
        lastKnownTime = t;
        lastKnownDuration = d;
      }
      // 確定するまでは基準値を更新せず、同じ基準と比較し続けて確認を積み上げる
    } else {
      boundaryCandidateTicks = 0;
      lastKnownTime = t;
      lastKnownDuration = d;
    }
  }

  function attachVideoListeners(video) {
    if (video.dataset.simpleRenzokuAttached) return;
    video.dataset.simpleRenzokuAttached = '1';

    video.addEventListener('ended', () => handleVideoEnded(video));

    video.addEventListener('loadedmetadata', () => {
      const marker = video.currentSrc || video.src;
      if (marker && marker !== currentVideoSrcMarker) {
        currentVideoSrcMarker = marker;
        resetStateForNewEpisode();
        suppressBoundaryChecks();
        lastKnownTime = video.currentTime || 0;
        lastKnownDuration = Number.isFinite(video.duration) ? video.duration : 0;
      }
    });
  }

  // ---- 「イントロをスキップ」ボタンの出現を新エピソード開始の合図として使う ----
  // 1本の動画ファイルに話数ごとのチャプターが打ってあるだけの作品では、
  // currentTime/durationが話数をまたいでも変化しないため上の巻き戻り/尺変化検知が機能しない。
  // 「イントロをスキップ」は各話の頭にだけ出るはずなので、その出現の立ち上がり(非表示→表示)を
  // 新エピソード開始の合図として使う。ボタン自体はクリックしない(OPは常にフル再生させたいため)。
  function handleIntroSkipAppearance() {
    const btn = document.querySelector(SKIP_INTRO_SELECTOR);
    const visibleNow = Boolean(btn);

    if (visibleNow && !introSkipButtonVisible) {
      introSkipButtonVisible = true;
      log('「イントロをスキップ」ボタンの出現を検知 → 新しいエピソードの開始とみなします');
      resetStateForNewEpisode();
      suppressBoundaryChecks();
    } else if (!visibleNow) {
      introSkipButtonVisible = false;
    }
  }

  // ---- 一覧ページのホバー・プレビュー動画を誤検知しないためのガード ----
  // サムネイルにマウスオーバーすると小さなプレビュー用<video>が生成され、
  // そこにも(全く別機能の)「非表示」ボタン等が出ることがあるため、
  // 「本編を再生している大きなプレイヤーかどうか」を判定する。
  // 固定ピクセル数だとホバー時に拡大されるカードがギリギリ超えてしまうことがあるため、
  // ウィンドウ全体に対する比率で判定する(一覧カードはどれだけ拡大されても画面の3〜4割には届かない)。
  const MIN_MAIN_PLAYER_WIDTH_RATIO = 0.4;
  const MIN_MAIN_PLAYER_HEIGHT_RATIO = 0.4;
  const MIN_MAIN_PLAYER_DURATION_SEC = 60;

  function isMainPlayerVideo(video) {
    if (!video) return false;
    const rect = video.getBoundingClientRect();
    const bigEnough =
      rect.width >= window.innerWidth * MIN_MAIN_PLAYER_WIDTH_RATIO &&
      rect.height >= window.innerHeight * MIN_MAIN_PLAYER_HEIGHT_RATIO;
    const longEnough =
      !Number.isFinite(video.duration) || video.duration === 0 || video.duration >= MIN_MAIN_PLAYER_DURATION_SEC;
    // durationがまだ0/未確定(読み込み直後)の場合はサイズだけで判定し、後続のtickで尺も確認する
    return bigEnough && longEnough;
  }

  function findMainPlayerVideo() {
    const videos = document.querySelectorAll('video');
    let best = null;
    let bestArea = 0;
    videos.forEach((v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    });
    return best;
  }

  function tick() {
    if (!enabled) return;

    const video = findMainPlayerVideo();
    const mainPlayer = isMainPlayerVideo(video);

    if (video && mainPlayer) {
      attachVideoListeners(video);
      checkForEpisodeBoundary(video);
    }

    if (!mainPlayer) return; // 一覧ページのホバー・プレビュー等では以降の自動クリック系処理を一切行わない

    handleIntroSkipAppearance();
    handleWatchCredits();
    handleHideRecommendations();
    handleStopAutoplay();
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
