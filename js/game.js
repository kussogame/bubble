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
      // iOSでは <audio>.volume は効かないが、他ブラウザでは一応保険で反映
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
    // 反映先：Web Audio（優先）/ <audio>.volume（保険）
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

  // ====== ランダム初期配置 ======
  async function loadLevel(){
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    for (let r = 0; r < CONFIG.INIT_ROWS; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (Math.random() < CONFIG.EMPTY_RATE) continue;
        const avatar = avatars[Math.floor(Math.random() * avatars.length)];
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
    const avatar = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : avatars[Math.floor(Math.random() * avatars.length)];
    return { color: avatar.color, avatarId: avatar.id };
  }

  // ====== 初期化 ======
  async function init(){
    await loadAvatars();
    await loadLevel();
    shooter = { x: cv.width/2, y: cv.height - CONFIG.BOTTOM_MARGIN };
    aim.x = shooter.x;
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    dropOffsetY = 0;
    shotsUsed = 0;
    state = "ready";
    moving = null;
    nextBall = makeNextBall();
    if (shotsLeftEl){
      shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    }
    hideOverlay();
    loop(0);
  }

  // ====== 入力（PCマウス） ======
  cv.addEventListener("mousemove", e=>{
    if (touchAiming) return;
    const {x,y} = clientToCanvas(e.clientX, e.clientY);
    aim.x = clampAimX(x);
    aim.y = Math.min(y, shooter.y - 12);
  });
  cv.addEventListener("click", ()=>{ if (state === "ready") fire(); });

  // ====== 入力（モバイル） ======
  cv.addEventListener("touchstart", (e)=>{
    if (e.changedTouches.length === 0) return;
    const t = e.changedTouches[0];
    const {x} = clientToCanvas(t.clientX, t.clientY);
    touchAiming = true;
    activeTouchId = t.identifier;
    aim.x = clampAimX(x);
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    e.preventDefault();
  }, {passive:false});
  cv.addEventListener("touchmove", (e)=>{
    if (!touchAiming) return;
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    const {x} = clientToCanvas(t.clientX, t.clientY);
    aim.x = clampAimX(x);
    aim.y = shooter.y - CONFIG.AIM_Y_OFFSET_MOBILE;
    e.preventDefault();
  }, {passive:false});
  cv.addEventListener("touchend", (e)=>{
    if (!touchAiming) return;
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    touchAiming = false;
    activeTouchId = null;
    if (state === "ready") fire();
    e.preventDefault();
  }, {passive:false});
  cv.addEventListener("touchcancel", (e)=>{
    if (!touchAiming) return;
    const t = findTouch(e.changedTouches, activeTouchId);
    if (!t) return;
    touchAiming = false;
    activeTouchId = null;
    e.preventDefault();
  }, {passive:false});

  function findTouch(touchList, id){
    for (let i=0;i<touchList.length;i++){
      if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
  }

  // ====== ユーティリティ ======
  function clientToCanvas(clientX, clientY){
    const rect = cv.getBoundingClientRect();
    const scaleX = cv.width / rect.width;
    const scaleY = cv.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }
  function clampAimX(x){
    const minX = CONFIG.LEFT_MARGIN + CONFIG.R;
    const maxX = cv.width - CONFIG.RIGHT_MARGIN - CONFIG.R;
    return Math.min(maxX, Math.max(minX, x));
  }
  function applyMinAngle(vx, vy){
    const angle = Math.atan2(-vy, vx);
    const min = CONFIG.MIN_AIM_ANGLE_DEG * Math.PI / 180;
    const sign = angle < 0 ? -1 : 1;
    if (Math.abs(angle) < min){
      const a = sign * min;
      const speed = Math.hypot(vx, vy) || 1;
      return { vx: Math.cos(a) * speed, vy: -Math.sin(a) * speed };
    }
    return { vx, vy };
  }

  // ====== 発射 ======
  function fire(){
    if (state !== "ready" || !nextBall) return;
    let dx = aim.x - shooter.x;
    let dy = aim.y - shooter.y;
    if (dy >= -4) dy = -4; // 上方向限定
    const len = Math.hypot(dx,dy) || 1;
    let vx = (dx/len) * CONFIG.SHOT_SPEED;
    let vy = (dy/len) * CONFIG.SHOT_SPEED;
    ({vx, vy} = applyMinAngle(vx, vy));
    moving = {
      x: shooter.x, y: shooter.y, r: CONFIG.R,
      vx, vy,
      color: nextBall.color, avatarId: nextBall.avatarId
    };
    state = "firing";

    if (audioUnlocked) {
      playShotSfx();                  // 共通発射音
      playFireVoice(nextBall.avatarId); // 個別ボイス
    }

    nextBall = makeNextBall();
  }

  // ====== 配置・消去 ======
  function placeAt(row,col,ball){
    if (!PXGrid.inBounds(board,row,col)) return false;
    if (row >= board.length) return false;
    board[row][col] = { color: ball.color, avatarId: ball.avatarId };
    return true;
  }

  function handleMatchesAndFalls(sr, sc){
    const cluster = PXGrid.findCluster(board, sr, sc);
    if (cluster.length >= CONFIG.CLEAR_MATCH){
      for (const {r,c} of cluster){
        if (board[r][c]){
          if (audioUnlocked) playClearVoice(board[r][c].avatarId);
          board[r][c] = null;
        }
      }
      const connected = PXGrid.findCeilingConnected(board);
      for (let r = 0; r < board.length; r++){
        for (let c = 0; c < CONFIG.COLS; c++){
          const cell = board[r][c];
          if (!cell) continue;
          const key = `${r},${c}`;
          if (!connected.has(key)){
            if (audioUnlocked) playClearVoice(cell.avatarId);
            board[r][c] = null;
          }
        }
      }
    }
  }

  // ====== 判定 ======
  function isCleared(){
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (board[r][c]) return false;
      }
    }
    return true;
  }
  function isGameOver(){
    const bottomY = cv.height - CONFIG.BOTTOM_MARGIN;
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const {x,y} = PXGrid.cellCenter(r,c,dropOffsetY);
        if (y + CONFIG.R >= bottomY) return true;
      }
    }
    return false;
  }
  function dropCeilingIfNeeded(){
    if (shotsUsed > 0 && shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS === 0){
      dropOffsetY += PXGrid.ROW_H;
    }
  }

  // ====== UIボタン ======
  if (btnPause){
    btnPause.addEventListener("click", ()=>{
      if (state === "paused") return;
      state = "paused";
      if (audioUnlocked) stopBGM();
      showOverlay("PAUSED");
    });
  }
  if (btnRetry){ btnRetry.addEventListener("click", ()=> reset()); }
  if (btnResume){
    btnResume.addEventListener("click", ()=>{
      if (state !== "paused") return;
      hideOverlay();
      state = "ready";
      if (audioUnlocked) playBGM();
    });
  }
  if (btnOverlayRetry){ btnOverlayRetry.addEventListener("click", ()=> reset()); }

  // ====== START クリックでオーディオ解禁＆ゲーム開始 ======
  btnStart.addEventListener("click", async ()=>{
    if (!audioUnlocked) {
      audioUnlocked = true;
      ensureAudioGraph();
      try { await audioCtx.resume(); } catch {}
      setBgmVolumeNorm(bgmVolume); // UI値をGainに反映
      playBGM();                   // ユーザー操作の文脈で確実に再生
    }
    startOverlay.classList.add("hidden");
    if (!board) await init(); else await reset();
  });

  // ====== reset/init 共通 ======
  async function reset(){
    await loadLevel();
    dropOffsetY = 0;
    shotsUsed = 0;
    moving = null;
    nextBall = makeNextBall();
    state = "ready";
    if (shotsLeftEl){
      shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    }
    hideOverlay();
    if (audioUnlocked) playBGM();
  }
  function showOverlay(text){
    if (!overlay) return;
    overlayText.textContent = text;
    overlay.classList.remove("hidden");
    const resumeBtn = document.getElementById("btnResume");
    if (resumeBtn){
      if (text === "GAME OVER" || text === "GAME CLEAR!"){
        resumeBtn.style.display = "none";
      } else {
        resumeBtn.style.display = "";
      }
    }
  }
  function hideOverlay(){ if (overlay) overlay.classList.add("hidden"); }

  // ====== メインループ ======
  let last = 0;
  function loop(ts){
    const dt = (ts - last) / 1000 || 0;
    last = ts;

    if (state === "firing" && moving){
      moving.x += moving.vx * dt;
      moving.y += moving.vy * dt;

      PXPhys.reflectIfNeeded(moving, {
        left: CONFIG.LEFT_MARGIN,
        right: cv.width - CONFIG.RIGHT_MARGIN
      });

      if (PXPhys.hitCeiling(moving, CONFIG.TOP_MARGIN + 24 + dropOffsetY, CONFIG.R)){
        const cells = PXGrid.nearbyCells(moving.x, moving.y, dropOffsetY);
        let best = null, bestD2 = 1e15;
        for (const cell of cells){
          if (cell.row !== 0) continue;
          if (board[cell.row][cell.col]) continue;
          const ctr = PXGrid.cellCenter(cell.row, cell.col, dropOffsetY);
          const d2 = (ctr.x-moving.x)**2 + (ctr.y-moving.y)**2;
          if (d2 < bestD2){ bestD2 = d2; best = cell; }
        }
        if (best){
          placeAt(best.row, best.col, moving);
          if (audioUnlocked) playHitSfx();
          handleMatchesAndFalls(best.row, best.col);
          moving = null;
          shotsUsed++;
          dropCeilingIfNeeded();
          state = "ready";
        } else {
          moving.y += 1;
        }
      } else {
        const col = PXPhys.checkCollision(moving, board, dropOffsetY, CONFIG.R);
        if (col.hit){
          const snap = PXPhys.chooseSnapCell(board, dropOffsetY, CONFIG.R, moving.x, moving.y, {r:col.r, c:col.c});
          if (snap){
            placeAt(snap.row, snap.col, moving);
            if (audioUnlocked) playHitSfx();
            handleMatchesAndFalls(snap.row, snap.col);
            moving = null;
            shotsUsed++;
            dropCeilingIfNeeded();
            state = "ready";
          } else {
            moving.x -= moving.vx * dt;
            moving.y -= moving.vy * dt;
          }
        }
      }
    }

    if (state !== "paused" && state !== "over" && state !== "clear"){
      if (isGameOver()){
        state = "over";
        if (audioUnlocked) stopBGM();
        showOverlay("GAME OVER");
      } else if (isCleared()){
        state = "clear";
        if (audioUnlocked) stopBGM();
        showOverlay("GAME CLEAR!");
      }
    }

    if (shotsLeftEl){
      shotsLeftEl.textContent = CONFIG.CEILING_DROP_PER_SHOTS - (shotsUsed % CONFIG.CEILING_DROP_PER_SHOTS);
    }

    ctx.clearRect(0,0,cv.width,cv.height);

    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      CONFIG.LEFT_MARGIN,
      CONFIG.TOP_MARGIN,
      cv.width - CONFIG.LEFT_MARGIN - CONFIG.RIGHT_MARGIN,
      cv.height - CONFIG.TOP_MARGIN - CONFIG.BOTTOM_MARGIN
    );

    PXRender.drawBoard(ctx, board, dropOffsetY, CONFIG.R, images);

    if (state === "ready"){
      PXRender.drawAimGuide(ctx, shooter.x, shooter.y, aim.x, aim.y);
    }

    if (moving){
      const img = images[moving.avatarId];
      PXRender.drawAvatarBubble(ctx, img, moving.x, moving.y, CONFIG.R, moving.color);
    }

    ctx.fillStyle = "#fff";
    ctx.globalAlpha = .15;
    ctx.beginPath(); ctx.arc(shooter.x, shooter.y, CONFIG.R*0.9, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    PXRender.drawNext(cvNext, nextBall, CONFIG.R, images);

    requestAnimationFrame(loop);
  }

  // 自動起動しない（START待ち）
  // init();

  // STARTが押されるまで待つ
  btnStart.addEventListener("click", async ()=>{
    if (!audioUnlocked) {
      audioUnlocked = true;
      ensureAudioGraph();
      try { await audioCtx.resume(); } catch {}
      setBgmVolumeNorm(bgmVolume); // UI値をGainに反映
      playBGM();                   // ユーザー操作の文脈で確実に再生
    }
    startOverlay.classList.add("hidden");
    if (!board) await init(); else await reset();
  });
})();
