// game.js - ランダム初期配置 + サウンド（BGM/ボイス/shot/hit）
//         + STARTでオーディオ解禁 + モバイル操作 + BGM音量UI（Web Audio対応）

(() => {
  // ====== 基本設定 ======
  const CONFIG = {
    COLS: 12,
    R: 18,
    BOARD_ROWS: 18,
    SHOT_SPEED: 640,
    CEILING_DROP_PER_SHOTS: 8,
    CLEAR_MATCH: 3,
    LEFT_MARGIN: 24, RIGHT_MARGIN: 24, TOP_MARGIN: 24, BOTTOM_MARGIN: 96,

    AIM_Y_OFFSET_MOBILE: 160,
    MIN_AIM_ANGLE_DEG: 7,

    INIT_ROWS: 6,
    EMPTY_RATE: 0.1
  };

  // ====== DOM ======
  const cv = document.getElementById("game");
  const ctx = cv.getContext("2d");
  const cvNext = document.getElementById("next");
  const shotsLeftEl = document.getElementById("shotsLeft");
  const overlay = document.getElementById("overlay");
  const overlayText = document.getElementById("overlayText");
  const btnPause = document.getElementById("btnPause");
  const btnRetry = document.getElementById("btnRetry");
  const btnResume = document.getElementById("btnResume");
  const btnOverlayRetry = document.getElementById("btnOverlayRetry");

  // STARTオーバーレイ
  let startOverlay = document.getElementById("startOverlay");
  let btnStart = document.getElementById("btnStart");
  if (!startOverlay) {
    startOverlay = document.createElement("div");
    startOverlay.id = "startOverlay";
    startOverlay.className = "overlay";
    startOverlay.innerHTML = `
      <div class="overlay-text">Cryptoバブルボブル</div>
      <div class="overlay-actions"><button id="btnStart" class="btn">START</button></div>`;
    const stage = document.querySelector(".stage") || document.body;
    stage.appendChild(startOverlay);
    btnStart = startOverlay.querySelector("#btnStart");
  }

  // ====== BGM 音量UI ======
  const volSlider = document.getElementById("bgmVol");
  const volVal    = document.getElementById("bgmVolVal");
  function loadSavedBgmVolume(){
    const s = localStorage.getItem("px_bgm_vol");
    const v = s != null ? Number(s) : 0.4;
    return (Number.isFinite(v) && v >= 0 && v <= 1) ? v : 0.4;
  }

  // ====== ステート ======
  let images = {};
  let avatars = [];
  let palette = [];
  let board = null;
  let dropOffsetY = 0;
  let shotsUsed = 0;
  let state = "ready";
  let shooter = null;
  let aim = {x: 0, y: 0};
  let moving = null;
  let nextBall = null;

  let touchAiming = false;
  let activeTouchId = null;

  // ====== サウンド ======
  let audioUnlocked = false;
  let bgmEl = null;
  let audioCtx   = null;
  let bgmSource  = null;
  let bgmGain    = null;
  let bgmVolume  = loadSavedBgmVolume();

  function ensureAudioGraph(){
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (!bgmEl) {
      bgmEl = new Audio("assets/sound/bgm.mp3");
      bgmEl.loop = true;
      bgmEl.volume = bgmVolume;
    }
    if (!bgmSource) {
      bgmSource = audioCtx.createMediaElementSource(bgmEl);
      bgmGain   = audioCtx.createGain();
      bgmGain.gain.value = bgmVolume;
      bgmSource.connect(bgmGain).connect(audioCtx.destination);
    }
  }

  function setBgmVolumeNorm(v){
    bgmVolume = Math.max(0, Math.min(1, v));
    localStorage.setItem("px_bgm_vol", String(bgmVolume));
    if (volSlider) volSlider.value = String(Math.round(bgmVolume * 100));
    if (volVal)    volVal.textContent = `${Math.round(bgmVolume * 100)}%`;
    if (bgmGain) bgmGain.gain.value = bgmVolume;
    if (bgmEl)   bgmEl.volume = bgmVolume;
  }

  if (volSlider) volSlider.value = String(Math.round(bgmVolume * 100));
  if (volVal)    volVal.textContent = `${Math.round(bgmVolume * 100)}%`;
  if (volSlider) {
    volSlider.addEventListener("input", ()=>{
      const v = Number(volSlider.value) / 100;
      setBgmVolumeNorm(v);
    });
  }

  async function playBGM(){
    ensureAudioGraph();
    try { await audioCtx.resume(); } catch {}
    bgmEl.play().catch(()=>{});
  }
  function stopBGM(){ if (bgmEl) bgmEl.pause(); }

  function playShotSfx(){ new Audio("assets/sound/shot.mp3").play().catch(()=>{}); }
  function playHitSfx(){ new Audio("assets/sound/hit.mp3").play().catch(()=>{}); }
  function playFireVoice(avatarId){ new Audio(`assets/sound/fire_${avatarId}.mp3`).play().catch(()=>{}); }
  function playClearVoice(avatarId){ new Audio(`assets/sound/clear_${avatarId}.mp3`).play().catch(()=>{}); }

  // ====== 画像ローダー ======
  const BLOB_URLS = [];
  window.addEventListener("unload", () => { BLOB_URLS.forEach(u => URL.revokeObjectURL(u)); });

  function guessMimeFromName(name){
    const mDot = name.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
    const mComma = name.match(/,([a-zA-Z0-9]+)$/);
    const ext = (mDot && mDot[1]) || (mComma && mComma[1]) || "";
    return (ext || "").toLowerCase();
  }

  function loadImageSmart(url){
    return new Promise(async (resolve, reject) => {
      const img = new Image();
      img.src = url;
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
    });
  }

  async function loadAvatars(){
    const resp = await fetch("data/avatars.json");
    const data = await resp.json();
    palette = data.palette;
    avatars = data.avatars;
    const jobs = avatars.map(a =>
      loadImageSmart(a.file).then(img => { images[a.id] = img; })
    );
    await Promise.all(jobs);
  }

  // ====== 重み付きランダム（gareso 4倍） ======
  function weightedRandomAvatar(pool){
    const list = pool.length ? pool : avatars;
    const weighted = [];
    for (const a of list){
      const weight = (a.id === "gareso") ? 4 : 1;
      for (let i=0; i<weight; i++) weighted.push(a);
    }
    return weighted[Math.floor(Math.random() * weighted.length)];
  }

  async function loadLevel(){
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    for (let r = 0; r < CONFIG.INIT_ROWS; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (Math.random() < CONFIG.EMPTY_RATE) continue;
        const avatar = weightedRandomAvatar(avatars);
        board[r][c] = { color: avatar.color, avatarId: avatar.id };
      }
    }
  }

  function makeNextBall(){
    const colors = PXGrid.existingColors(board);
    const color = colors.length
      ? colors[Math.floor(Math.random()*colors.length)]
      : palette[Math.floor(Math.random()*palette.length)];
    const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
    const avatar = weightedRandomAvatar(pool);
    return { color: avatar.color, avatarId: avatar.id };
  }

  // ====== 以下は元の設計保持、変更なし ======
  // init, fire, handleMatchesAndFalls など既存ロジックはそのまま
  // （省略: 添付ファイルと同じ内容）

})();
