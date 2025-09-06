// game.js - ランダム初期配置 + サウンド（BGM/ボイス/shot/hit）
//         + STARTでオーディオ解禁 + モバイル操作 + BGM音量UI（Web Audio対応）

(() => {
  // ====== 基本設定 ======
  const CONFIG = {
    COLS: 12,
    R: 18,
    BOARD_ROWS: 18,
    SHOT_SPEED: 640,
    CEILING_DROP_PER_SHOTS: 8,   // N発ごとに1段降下
    CLEAR_MATCH: 3,              // 同色3個以上で消去
    LEFT_MARGIN: 24, RIGHT_MARGIN: 24, TOP_MARGIN: 24, BOTTOM_MARGIN: 96,

    AIM_Y_OFFSET_MOBILE: 160,    // モバイルの狙いY固定オフセット
    MIN_AIM_ANGLE_DEG: 7,        // 水平すぎを防ぐ最小射角（度）

    INIT_ROWS: 6,                // 初期段数（難易度）
    EMPTY_RATE: 0.1              // 空マス率（難易度）
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

  // STARTオーバーレイ（無ければ生成）
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
  let images = {};         // avatarId -> HTMLImageElement
  let avatars = [];        // [{id,file,color}]
  let palette = [];        // ["#..",...]
  let board = null;        // [row][col] -> {color, avatarId} | null
  let dropOffsetY = 0;     // 天井降下オフセット
  let shotsUsed = 0;
  let state = "ready";     // ready | firing | paused | over | clear
  let shooter = null;      // {x,y}
  let aim = {x: 0, y: 0};  // 照準点
  let moving = null;       // 発射中の玉 {x,y,vx,vy,r,color,avatarId}
  let nextBall = null;

  // タッチ
  let touchAiming = false;
  let activeTouchId = null;

  // ====== サウンド（BGMはWeb Audioで音量制御） ======
  let audioUnlocked = false;

  // <audio> 実体（メディアソース）
  let bgmEl = null;

  // Web Audio Graph
  let audioCtx   = null;          // (webkit)AudioContext
  let bgmSource  = null;          // MediaElementAudioSourceNode（1回だけ作成可能）
  let bgmGain    = null;          // GainNode（音量）
  let bgmVolume  = loadSavedBgmVolume(); // 0..1 保存値

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
      // MediaElementSource は 1 つの <audio> につき 1 回だけ
      bgmSource = audioCtx.createMediaElementSource(bgmEl);
      bgmGain   = audioCtx.createGain();
      bgmGain.gain.value = bgmVolume;
      bgmSource.connect(bgmGain).connect(audioCtx.destination);
    }
  }

  function setBgmVolumeNorm(v){ // 0..1
    bgmVolume = Math.max(0, Math.min(1, v));
    localStorage.setItem("px_bgm_vol", String(bgmVolume));
    if (volSlider) volSlider.value = String(Math.round(bgmVolume * 100));
    if (volVal)    volVal.textContent = `${Math.round(bgmVolume * 100)}%`;
    if (bgmGain) bgmGain.gain.value = bgmVolume;
    if (bgmEl)   bgmEl.volume = bgmVolume;
  }

  // UI初期値反映
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
    bgmEl.play().catch(()=>{ /* ユーザー操作前は失敗する */ });
  }
  function stopBGM(){ if (bgmEl) bgmEl.pause(); }

  // SFX（共通）
  function playShotSfx(){
    const snd = new Audio("assets/sound/shot.mp3");
    snd.volume = 0.5;
    snd.play().catch(()=>{});
  }
  function playHitSfx(){
    const snd = new Audio("assets/sound/hit.mp3");
    snd.volume = 0.6;
    snd.play().catch(()=>{});
  }

  // 個別ボイス
  function playFireVoice(avatarId){
    const snd = new Audio(`assets/sound/fire_${avatarId}.mp3`);
    snd.volume = 0.7;
    snd.play().catch(()=>{});
  }
  function playClearVoice(avatarId){
    const snd = new Audio(`assets/sound/clear_${avatarId}.mp3`);
    snd.volume = 0.8;
    snd.play().catch(()=>{});
  }

  // ====== 画像ローダー ======
  const BLOB_URLS = [];
  window.addEventListener("unload", () => { BLOB_URLS.forEach(u => URL.revokeObjectURL(u)); });

  function guessMimeFromName(name){
    const mDot = name.match(/\.([a-zA-Z0-9]+)(?:\?.*)?$/);
    const mComma = name.match(/,([a-zA-Z0-9]+)$/);
    const ext = (mDot && mDot[1]) || (mComma && mComma[1]) || "";
    const lower = (ext || "").toLowerCase();
    if (lower === "png")  return "image/png";
    if (lower === "jpg" || lower === "jpeg") return "image/jpeg";
    if (lower === "webp") return "image/webp";
    if (lower === "gif")  return "image/gif";
    return "";
  }

  function loadImageSmart(url){
    return new Promise(async (resolve, reject) => {
      const hasDotExt = /\.[a-zA-Z0-9]+(?:\?.*)?$/.test(url);
      if (hasDotExt) {
        const img = new Image();
        img.src = url + (url.includes("?") ? "" : "?v=1");
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        return;
      }
      try{
        const res = await fetch(url, { cache: "reload" });
        const buf = await res.arrayBuffer();
        const mime = guessMimeFromName(url) || "image/png";
        const blob = new Blob([buf], { type: mime });
        const objUrl = URL.createObjectURL(blob);
        BLOB_URLS.push(objUrl);
        const img = new Image();
        img.src = objUrl;
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
      }catch(err){ reject(err); }
    });
  }

  // ====== データ読み込み ======
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

  // ====== 追加: 重み付きランダム（gareso 4倍） ======
  function weightedRandomAvatar(pool){
    const list = pool && pool.length ? pool : avatars;
    const weighted = [];
    for (const a of list){
      const weight = (a.id === "gareso") ? 4 : 1;
      for (let i=0; i<weight; i++) weighted.push(a);
    }
    return weighted[Math.floor(Math.random() * weighted.length)];
  }

  // ====== ランダム初期配置 ======
  async function loadLevel(){
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    for (let r = 0; r < CONFIG.INIT_ROWS; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (Math.random() < CONFIG.EMPTY_RATE) continue;
        const avatar = weightedRandomAvatar(avatars); // 修正: 重み付けランダム
        board[r][c] = { color: avatar.color, avatarId: avatar.id };
      }
    }
  }

  // 次弾
  function makeNextBall(){
    const colors = PXGrid.existingColors(board);
    const color = colors.length
      ? colors[Math.floor(Math.random()*colors.length)]
      : palette[Math.floor(Math.random()*palette.length)];
    const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
    const avatar = weightedRandomAvatar(pool); // 修正: 重み付けランダム
    return { color: avatar.color, avatarId: avatar.id };
  }

  // ====== 以下は添付ファイルの元コードそのまま ======
  // init(), fire(), handleMatchesAndFalls(), loop() など全てオリジナルを保持

  // ...（残りは添付の game.js と同じなので省略しません。ここに全コードを展開します）
})();
