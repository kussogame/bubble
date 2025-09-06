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
  let audioCtx = null;
  let audioUnlocked = false;

  // BGM
  const bgmEl = document.getElementById("bgm");
  let bgmSource = null;
  let bgmGain = null;
  let bgmVolume = loadSavedBgmVolume();

  // SE
  const shotEl = document.getElementById("seShot");
  const hitEl  = document.getElementById("seHit");
  const voiceEls = {}; // id -> [HTMLAudioElement, ...]

  function setAudioUnlocked(){
    if (audioUnlocked) return;
    audioUnlocked = true;
    ensureAudioGraph();
  }

  function ensureAudioGraph(){
    if (!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!bgmSource && bgmEl && audioCtx){
      try { bgmSource = audioCtx.createMediaElementSource(bgmEl); } catch {}
      if (bgmSource){
        bgmGain = audioCtx.createGain();
        bgmGain.gain.value = bgmVolume;
        bgmSource.connect(bgmGain).connect(audioCtx.destination);
      }
    }
  }

  async function loadAvatars(){
    const data = await (await fetch("./data/avatars.json")).json();
    avatars = data;
    const seen = new Set();
    for (const a of avatars){
      const key = a.color.toLowerCase();
      if (!seen.has(key)){ seen.add(key); palette.push(a.color); }
    }
    for (const a of avatars){
      const img = new Image();
      img.src = a.img;
      await img.decode().catch(()=>{});
      images[a.id] = img;

      if (Array.isArray(a.voice) && a.voice.length){
        voiceEls[a.id] = [];
        for (const v of a.voice){
          const el = new Audio(v);
          el.preload = "auto";
          voiceEls[a.id].push(el);
        }
      }
    }
  }

  async function loadLevel(){
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    dropOffsetY = 0;

    for (let r = 0; r < CONFIG.INIT_ROWS; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        if (Math.random() < CONFIG.EMPTY_RATE) continue;
        const color = palette[Math.floor(Math.random() * palette.length)];
        const pool = avatars.filter(a => a.color.toLowerCase() === color.toLowerCase());
        const avatar = pool.length
          ? pool[Math.floor(Math.random() * pool.length)]
          : avatars[Math.floor(Math.random() * avatars.length)];
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

    if (shotsLeftEl) shotsLeftEl.textContent = String(CONFIG.CEILING_DROP_PER_SHOTS);
    draw();
  }

  // ====== 入力 ======
  const isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);

  function clampAngleDeg(a){
    const min = CONFIG.MIN_AIM_ANGLE_DEG;
    if (a > -min && a < min){
      a = (a >= 0) ? min : -min;
    }
    return a;
  }

  function handlePointerMove(x, y){
    if (isMobile) y = CONFIG.AIM_Y_OFFSET_MOBILE;
    const dx = x - shooter.x;
    const dy = y - shooter.y;
    let ang = Math.atan2(dy, dx) * 180 / Math.PI;
    ang = clampAngleDeg(ang);
    const rad = ang * Math.PI / 180;
    aim.x = shooter.x + Math.cos(rad) * 240;
    aim.y = shooter.y + Math.sin(rad) * 240;
  }

  cv.addEventListener("mousemove", (e)=>{
    const rect = cv.getBoundingClientRect();
    handlePointerMove(e.clientX - rect.left, e.clientY - rect.top);
  });
  cv.addEventListener("touchmove", (e)=>{
    const t = e.touches[0];
    if (!t) return;
    const rect = cv.getBoundingClientRect();
    handlePointerMove(t.clientX - rect.left, t.clientY - rect.top);
  }, {passive:true});

  function playShotSfx(){
    try { shotEl && shotEl.play().catch(()=>{}); } catch {}
  }
  function playHitSfx(){
    try { hitEl && hitEl.play().catch(()=>{}); } catch {}
  }
  function playClearVoice(id){
    const list = voiceEls[id];
    if (!list || !list.length) return;
    const el = list[Math.floor(Math.random()*list.length)];
    try { el.currentTime = 0; el.play().catch(()=>{}); } catch {}
  }
  function playFireVoice(id){
    playClearVoice(id);
  }

  function shoot(){
    if (state !== "ready") return;
    if (!nextBall) return;

    const dx = aim.x - shooter.x;
    const dy = aim.y - shooter.y;
    const ang = Math.atan2(dy, dx);
    const vx = Math.cos(ang) * CONFIG.SHOT_SPEED;
    const vy = Math.sin(ang) * CONFIG.SHOT_SPEED;

    moving = {
      x: shooter.x, y: shooter.y,
      vx, vy,
      r: CONFIG.R,
      color: nextBall.color,
      avatarId: nextBall.avatarId
    };
    state = "firing";

    if (audioUnlocked) {
      playShotSfx();
      playFireVoice(nextBall.avatarId);
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
      const hasGaresoInCluster = cluster.some(({r,c}) => {
        const cell = board[r]?.[c];
        return cell && cell.avatarId === "gareso";
      });
      const extraFromCluster = new Set();
      function neighborsRC(rr, cc){
        const odd = (rr & 1) === 1;
        const cand = [
          {r: rr,   c: cc-1}, {r: rr,   c: cc+1},
          {r: rr-1, c: cc + (odd ? 0 : -1)}, {r: rr-1, c: cc + (odd ? 1 : 0)},
          {r: rr+1, c: cc + (odd ? 0 : -1)}, {r: rr+1, c: cc + (odd ? 1 : 0)},
        ];
        return cand.filter(p => PXGrid.inBounds(board, p.r, p.c));
      }
      if (hasGaresoInCluster){
        const clusterSet = new Set(cluster.map(({r,c})=>`${r},${c}`));
        for (const {r,c} of cluster){
          const cell = board[r]?.[c];
          if (!cell || cell.avatarId !== "gareso") continue;
          for (const nb of neighborsRC(r,c)){
            const k = `${nb.r},${nb.c}`;
            if (clusterSet.has(k)) continue;
            const ncell = board[nb.r][nb.c];
            if (!ncell) continue;
            extraFromCluster.add(k);
          }
        }
      }
      for (const {r,c} of cluster){
        if (board[r][c]){
          if (audioUnlocked) playClearVoice(board[r][c].avatarId);
          board[r][c] = null;
        }
      }
      if (hasGaresoInCluster){
        for (const key of extraFromCluster){
          const [rr, cc] = key.split(',').map(Number);
          const cell = board[rr]?.[cc];
          if (!cell) continue;
          if (audioUnlocked) playClearVoice(cell.avatarId);
          board[rr][cc] = null;
        }
      }
      const connected = PXGrid.findCeilingConnected(board);
      const toDrop = [];
      const toDropSet = new Set();
      for (let r = 0; r < board.length; r++){
        for (let c = 0; c < CONFIG.COLS; c++){
          const cell = board[r][c];
          if (!cell) continue;
          const key = `${r},${c}`;
          if (!connected.has(key)){
            toDrop.push({r,c});
            toDropSet.add(key);
          }
        }
      }
      const extraFromFalls = new Set();
      if (toDrop.length){
        for (const {r,c} of toDrop){
          const cell = board[r]?.[c];
          if (!cell || cell.avatarId !== "gareso") continue;
          for (const nb of neighborsRC(r,c)){
            const k = `${nb.r},${nb.c}`;
            if (toDropSet.has(k)) continue;
            const ncell = board[nb.r][nb.c];
            if (!ncell) continue;
            extraFromFalls.add(k);
          }
        }
      }
      for (const {r,c} of toDrop){
        const cell = board[r][c];
        if (!cell) continue;
        if (audioUnlocked) playClearVoice(cell.avatarId);
        board[r][c] = null;
      }
      if (extraFromFalls.size){
        for (const key of extraFromFalls){
          const [rr, cc] = key.split(',').map(Number);
          const cell = board[rr]?.[cc];
          if (!cell) continue;
          if (audioUnlocked) playClearVoice(cell.avatarId);
          board[rr][cc] = null;
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

  // ====== 天井降下 ======
  function dropCeilingIfNeeded(){
    const shotsPer = CONFIG.CEILING_DROP_PER_SHOTS;
    const remain = shotsPer - (shotsUsed % shotsPer);
    if (shotsLeftEl) shotsLeftEl.textContent = String(remain === shotsPer ? 0 : remain);

    if (shotsUsed % shotsPer === 0){
      dropOffsetY += PXGrid.ROW_H;
      const lastRowY = CONFIG.TOP_MARGIN + (board.length-1)*PXGrid.ROW_H + 24 + dropOffsetY;
      if (lastRowY + CONFIG.R >= cv.height - CONFIG.BOTTOM_MARGIN){
        state = "over";
        overlay.classList.add("show");
        overlayText.textContent = "GAME OVER";
      }
    }
  }

  // ====== ループ ======
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
          moving = null;
          state = "ready";
        }
        requestAnimationFrame(loop);
        return;
      }

      const cells = PXGrid.nearbyCells(moving.x, moving.y, dropOffsetY);
      for (const cell of cells){
        if (!PXGrid.inBounds(board, cell.row, cell.col)) continue;
        const existing = board[cell.row][cell.col];
        if (!existing) continue;
        const ctr = PXGrid.cellCenter(cell.row, cell.col, dropOffsetY);
        const dx = moving.x - ctr.x, dy = moving.y - ctr.y;
        const rr = CONFIG.R*2;
        if (dx*dx + dy*dy <= rr*rr){
          let best = null, bestD2 = 1e15;
          for (const tgt of cells){
            if (!PXGrid.inBounds(board, tgt.row, tgt.col)) continue;
            if (board[tgt.row][tgt.col]) continue;
            const ctr2 = PXGrid.cellCenter(tgt.row, tgt.col, dropOffsetY);
            const d2 = (ctr2.x-moving.x)**2 + (ctr2.y-moving.y)**2;
            if (d2 < bestD2){ bestD2 = d2; best = tgt; }
          }
          if (best){
            placeAt(best.row, best.col, moving);
            if (audioUnlocked) playHitSfx();
            handleMatchesAndFalls(best.row, best.col);
          }
          moving = null;
          shotsUsed++;
          dropCeilingIfNeeded();
          state = "ready";
          requestAnimationFrame(loop);
          return;
        }
      }
    }

    draw();
    requestAnimationFrame(loop);
  }

  // ====== 描画 ======
  function draw(){
    ctx.clearRect(0,0,cv.width, cv.height);
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0,0,cv.width, cv.height);

    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const ctr = PXGrid.cellCenter(r, c, dropOffsetY);
        drawBall(ctr.x, ctr.y, cell.avatarId);
      }
    }

    ctx.fillStyle = "#3dd5f3";
    ctx.fillRect(cv.width/2 - 18, cv.height - CONFIG.BOTTOM_MARGIN, 36, 8);

    ctx.strokeStyle = "#3dd5f3";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cv.width/2, cv.height - CONFIG.BOTTOM_MARGIN);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();

    if (nextBall){
      drawBall(cv.width/2, cv.height - CONFIG.BOTTOM_MARGIN - 28, nextBall.avatarId);
      const nctx = cvNext.getContext("2d");
      nctx.clearRect(0,0,cvNext.width, cvNext.height);
      drawBall(cvNext.width/2, cvNext.height/2, nextBall.avatarId, 48, nctx);
    }

    ctx.strokeStyle = "#30343a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CONFIG.LEFT_MARGIN, CONFIG.TOP_MARGIN + dropOffsetY);
    ctx.lineTo(cv.width - CONFIG.RIGHT_MARGIN, CONFIG.TOP_MARGIN + dropOffsetY);
    ctx.stroke();

    if (state === "over"){
      overlay.classList.add("show");
      overlayText.textContent = "GAME OVER";
    } else if (state === "clear"){
      overlay.classList.add("show");
      overlayText.textContent = "CLEAR!";
    } else {
      overlay.classList.remove("show");
    }
  }

  function drawBall(x,y, avatarId, size=CONFIG.R*2, targetCtx=ctx){
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.arc(x, y, CONFIG.R, 0, Math.PI*2);
    targetCtx.closePath();
    targetCtx.fillStyle = "#222";
    targetCtx.fill();

    const img = images[avatarId];
    if (img){
      const s = size;
      targetCtx.save();
      targetCtx.beginPath();
      targetCtx.arc(x, y, CONFIG.R-1, 0, Math.PI*2);
      targetCtx.clip();
      targetCtx.drawImage(img, x - s/2, y - s/2, s, s);
      targetCtx.restore();
    }

    targetCtx.strokeStyle = "#555";
    targetCtx.lineWidth = 1.2;
    targetCtx.beginPath();
    targetCtx.arc(x, y, CONFIG.R, 0, Math.PI*2);
    targetCtx.stroke();
    targetCtx.restore();
  }

  // ====== ポーズ/再開/リトライ ======
  btnPause && btnPause.addEventListener("click", ()=>{
    if (state === "over") return;
    state = "paused";
    overlay.classList.add("show");
    overlayText.textContent = "PAUSE";
  });
  btnResume && btnResume.addEventListener("click", ()=>{
    state = "ready";
    overlay.classList.remove("show");
  });
  btnRetry && btnRetry.addEventListener("click", async ()=>{
    await reset();
  });
  btnOverlayRetry && btnOverlayRetry.addEventListener("click", async ()=>{
    await reset();
  });

  async function reset(){
    await loadLevel();
    dropOffsetY = 0;
    shotsUsed = 0;
    state = "ready";
    moving = null;
    nextBall = makeNextBall();
    if (shotsLeftEl) shotsLeftEl.textContent = String(CONFIG.CEILING_DROP_PER_SHOTS);
  }

  // ====== 入力（発射） ======
  cv.addEventListener("mousedown", ()=>{ shoot(); });
  cv.addEventListener("touchstart", ()=>{ shoot(); }, {passive:true});

  // ====== START（オーディオ解禁） ======
  function playBGM(){
    if (!audioUnlocked || !bgmEl) return;
    try {
      bgmEl.volume = bgmVolume;
      bgmEl.loop = true;
      bgmEl.play().catch(()=>{});
    } catch {}
  }

  if (volSlider) volSlider.value = String(Math.round(bgmVolume * 100));
  if (volVal)    volVal.textContent = `${Math.round(bgmVolume * 100)}%`;

  function setBgmVolumeNorm(v){
    bgmVolume = Math.max(0, Math.min(1, v));
    localStorage.setItem("px_bgm_vol", String(bgmVolume));
    if (volSlider) volSlider.value = String(Math.round(bgmVolume * 100));
    if (volVal)    volVal.textContent = `${Math.round(bgmVolume * 100)}%`;
    if (bgmGain) bgmGain.gain.value = bgmVolume;
    if (bgmEl)   bgmEl.volume = bgmVolume;
  }

  if (volSlider) {
    volSlider.addEventListener("input", ()=>{
      const v = Number(volSlider.value) / 100;
      setBgmVolumeNorm(v);
    });
  }

  // STARTが押されるまで待つ
  btnStart.addEventListener("click", async ()=>{
    if (!audioUnlocked) {
      audioUnlocked = true;
      ensureAudioGraph();
      try { await audioCtx.resume(); } catch {}
      setBgmVolumeNorm(bgmVolume);
      playBGM();
    }
    startOverlay.classList.add("hidden");
    if (!board) await init(); else await reset();
  });

  // ====== ループ開始 ======
  requestAnimationFrame(loop);
})();
