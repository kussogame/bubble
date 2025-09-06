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

    AVATAR_IMAGE_SIZE: 42,       // 描画用アバターの見た目サイズ
    NEXT_PREVIEW_SIZE: 48,

    INITIAL_ROWS: 7,             // 初期段の高さ
    COLORS_PER_LEVEL: 5,         // 登場色数
  };

  // grid.jsに格子設定を伝える
  PXGrid.COLS = CONFIG.COLS;
  PXGrid.R = CONFIG.R;
  PXGrid.TOP_MARGIN = CONFIG.TOP_MARGIN;

  // ====== 乱数ユーティリティ ======
  const randChoice = (arr) => arr[Math.floor(Math.random()*arr.length)];

  // ====== データ/アセット ======
  let AVATARS = [];   // { id, name, color, img, voice: ["...mp3", ...] }
  let AVATAR_MAP = new Map(); // id -> avatar

  // ====== オーディオ ======
  let audioUnlocked = false;
  let audioCtx = null, bgmGain = null, seGain = null;
  let bgmBuffer = null;
  const voiceBuffers = new Map(); // id -> AudioBuffer[]
  let bgmSource = null;

  async function loadAudioBuffer(url){
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    return await audioCtx.decodeAudioData(arr);
  }

  function playBGM(){
    if (!audioUnlocked || !bgmBuffer) return;
    stopBGM();
    const src = audioCtx.createBufferSource();
    src.buffer = bgmBuffer;
    src.loop = true;
    src.connect(bgmGain);
    bgmGain.connect(audioCtx.destination);
    src.start();
    bgmSource = src;
  }
  function stopBGM(){
    if (bgmSource){
      try{ bgmSource.stop(); }catch{}
      bgmSource.disconnect();
      bgmSource = null;
    }
  }

  function playClearVoice(avatarId){
    if (!audioUnlocked) return;
    const bufs = voiceBuffers.get(avatarId);
    if (!bufs || bufs.length === 0) return;
    const buf = randChoice(bufs);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(seGain);
    seGain.connect(audioCtx.destination);
    src.start();
  }

  let shotBuf = null, hitBuf = null;
  function playShot(){
    if (!audioUnlocked || !shotBuf) return;
    const src = audioCtx.createBufferSource();
    src.buffer = shotBuf;
    src.connect(seGain);
    seGain.connect(audioCtx.destination);
    src.start();
  }
  function playHit(){
    if (!audioUnlocked || !hitBuf) return;
    const src = audioCtx.createBufferSource();
    src.buffer = hitBuf;
    src.connect(seGain);
    seGain.connect(audioCtx.destination);
    src.start();
  }

  // ====== 画像 ======
  const images = new Map(); // id -> HTMLImageElement
  async function loadImage(url){
    return new Promise((resolve,reject)=>{
      const img = new Image();
      img.onload = ()=>resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

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
  if (!startOverlay){
    startOverlay = document.createElement("div");
    startOverlay.id = "startOverlay";
    startOverlay.className = "start-overlay";
    startOverlay.innerHTML = `
      <div class="start-inner">
        <h1>PUZZLE-X</h1>
        <p>音ありでプレイするにはSTARTを押してください</p>
        <div class="start-controls">
          <button id="btnStart" class="primary">START</button>
          <label class="vol">
            BGM:
            <input id="bgmVol" type="range" min="0" max="1" step="0.01" value="0.6">
          </label>
        </div>
      </div>
    `;
    document.body.appendChild(startOverlay);
    btnStart = startOverlay.querySelector("#btnStart");
  }
  const bgmVolInput = document.getElementById("bgmVol") || startOverlay.querySelector("#bgmVol");

  // ====== ゲーム状態 ======
  let board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
  let dropOffsetY = 0;  // 上段の降下演出
  let playerX = cv.width/2;
  let playerY = cv.height - CONFIG.BOTTOM_MARGIN;
  let aimX = cv.width/2, aimY = 200;

  let currentBall = null; // {color, avatarId, img}
  let nextBall = null;

  let movingBall = null;  // {x,y, vx,vy, color, avatarId, img}
  let isPaused = false;
  let shotsCount = 0;
  let shotsUntilDrop = CONFIG.CEILING_DROP_PER_SHOTS;

  let gameOver = false;

  // ====== 初期化 ======
  async function loadData(){
    const avatars = await (await fetch("./data/avatars.json")).json();
    AVATARS = avatars;
    AVATAR_MAP = new Map(avatars.map(a => [a.id, a]));

    // 画像と音声のプリロード
    for (const a of avatars){
      images.set(a.id, await loadImage(a.img));
    }
    // WebAudioはSTART後に
  }

  function randomColorSet(){
    // levelsがあれば参照。なければ色数固定
    const colors = new Set();
    const avail = AVATARS.map(a => a.color);
    while(colors.size < CONFIG.COLORS_PER_LEVEL){
      colors.add(randChoice(avail));
    }
    return Array.from(colors);
  }

  function avatarByColor(color){
    // 同じ色の候補からランダム
    const cands = AVATARS.filter(a => a.color === color);
    return randChoice(cands);
  }

  function randomAvatarFromExistingColors(){
    const colors = PXGrid.existingColors(board);
    if (colors.length === 0){
      // 盤面空なら全体から
      return randChoice(AVATARS);
    }
    const color = randChoice(colors);
    return avatarByColor(color);
  }

  function spawnInitialBoard(){
    const colors = randomColorSet();
    const rows = CONFIG.INITIAL_ROWS;
    for (let r = 0; r < rows; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        // 斜め列の最右は詰めの関係で空にすることがある
        const color = randChoice(colors);
        const av = avatarByColor(color);
        board[r][c] = { color, avatarId: av.id };
      }
    }
  }

  function spawnNextBalls(){
    const av1 = randomAvatarFromExistingColors();
    currentBall = {
      color: av1.color,
      avatarId: av1.id,
    };
    const av2 = randomAvatarFromExistingColors();
    nextBall = {
      color: av2.color,
      avatarId: av2.id,
    };
  }

  function updateShotsLeftUI(){
    shotsLeftEl.textContent = shotsUntilDrop;
  }

  // ====== 入力 ======
  let isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);

  function clampAngleDeg(a){
    const min = CONFIG.MIN_AIM_ANGLE_DEG;
    if (a > -min && a < min){
      a = (a >= 0) ? min : -min;
    }
    return a;
  }

  function handlePointerMove(x, y){
    if (isMobile){
      // モバイルは狙いのYを固定して狙いやすく
      y = CONFIG.AIM_Y_OFFSET_MOBILE;
    }
    const dx = x - playerX;
    const dy = y - playerY;
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; // deg
    ang = clampAngleDeg(ang);
    const rad = ang * Math.PI / 180;
    aimX = playerX + Math.cos(rad) * 240;
    aimY = playerY + Math.sin(rad) * 240;
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

  function shoot(){
    if (isPaused || gameOver) return;
    if (!currentBall || movingBall) return;

    const dx = aimX - playerX;
    const dy = aimY - playerY;
    const ang = Math.atan2(dy, dx);
    const vx = Math.cos(ang) * CONFIG.SHOT_SPEED;
    const vy = Math.sin(ang) * CONFIG.SHOT_SPEED;

    movingBall = {
      x: playerX, y: playerY,
      vx, vy,
      color: currentBall.color,
      avatarId: currentBall.avatarId,
    };
    playShot();
  }

  cv.addEventListener("mousedown", (e)=>{
    shoot();
  });
  cv.addEventListener("touchstart", (e)=>{
    shoot();
  }, {passive:true});

  // ====== 物理/接触 ======
  function updateMovingBall(dt){
    if (!movingBall) return;

    let nx = movingBall.x + movingBall.vx * dt;
    let ny = movingBall.y + movingBall.vy * dt;

    // 壁反射
    if (nx < CONFIG.LEFT_MARGIN + CONFIG.R){
      nx = CONFIG.LEFT_MARGIN + CONFIG.R;
      movingBall.vx *= -1;
    }
    if (nx > cv.width - CONFIG.RIGHT_MARGIN - CONFIG.R){
      nx = cv.width - CONFIG.RIGHT_MARGIN - CONFIG.R;
      movingBall.vx *= -1;
    }

    // 天井接触
    if (ny < CONFIG.TOP_MARGIN + CONFIG.R){
      // スナップ配置
      snapMovingBallToBoard(nx, ny);
      return;
    }

    // 既存バブルと接触判定
    // 近傍セルを調べて、中心距離 <= 2R で衝突
    const near = PXGrid.nearbyCells(nx, ny, dropOffsetY);
    for (const {row, col} of near){
      if (!PXGrid.inBounds(board, row, col)) continue;
      const cell = board[row][col];
      if (!cell) continue;
      const {x: cx, y: cy} = PXGrid.cellCenter(row, col, dropOffsetY);
      const dx = nx - cx, dy = ny - cy;
      const d2 = dx*dx + dy*dy;
      const rr = CONFIG.R*2;
      if (d2 <= rr*rr){
        // 接触 → スナップ
        snapMovingBallToBoard(nx, ny);
        return;
      }
    }

    movingBall.x = nx;
    movingBall.y = ny;
  }

  function snapMovingBallToBoard(nx, ny){
    // 近傍セルから最も近い空セルを探す
    const near = PXGrid.nearbyCells(nx, ny, dropOffsetY);
    let best = null, bestD2 = Infinity;
    for (const {row, col} of near){
      if (!PXGrid.inBounds(board, row, col)) continue;
      if (board[row][col]) continue;
      const {x, y} = PXGrid.cellCenter(row, col, dropOffsetY);
      const dx = nx - x, dy = ny - y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2){
        bestD2 = d2;
        best = {r: row, c: col};
      }
    }
    if (!best){
      // 万一空きが見つからなければ天井行に押し込む
      best = { r: 0, c: Math.max(0, Math.min(CONFIG.COLS-1, Math.floor((nx - CONFIG.LEFT_MARGIN) / (CONFIG.R*2)))) };
      if (board[best.r][best.c]) {
        // 詰んだら近傍の空きを強引に探す
        outer:
        for (let r=0; r<board.length; r++){
          for (let c=0; c<CONFIG.COLS; c++){
            if (!board[r][c]) { best = {r,c}; break outer; }
          }
        }
      }
    }

    // 配置
    board[best.r][best.c] = { color: movingBall.color, avatarId: movingBall.avatarId };
    movingBall = null;
    playHit();

    // 消去＆落下処理
    handleMatchesAndFalls(best.r, best.c);

    // 弾補充
    currentBall = nextBall;
    const av2 = randomAvatarFromExistingColors();
    nextBall = { color: av2.color, avatarId: av2.id };

    // 天井降下
    shotsCount++;
    shotsUntilDrop = CONFIG.CEILING_DROP_PER_SHOTS - (shotsCount % CONFIG.CEILING_DROP_PER_SHOTS);
    updateShotsLeftUI();
    if (shotsCount % CONFIG.CEILING_DROP_PER_SHOTS === 0){
      dropOneRow();
    }
  }

  function dropOneRow(){
    dropOffsetY += PXGrid.ROW_H;
    // 一番下が画面下に到達 → ゲームオーバー判定
    const lastRowY = CONFIG.TOP_MARGIN + (board.length-1)*PXGrid.ROW_H + 24 + dropOffsetY;
    if (lastRowY + CONFIG.R >= playerY){
      gameOver = true;
      overlay.classList.add("show");
      overlayText.textContent = "GAME OVER";
    }
  }

  // ====== マッチ＆落下 ======
  function handleMatchesAndFalls(sr, sc){
    const cluster = PXGrid.findCluster(board, sr, sc);
    if (cluster.length >= CONFIG.CLEAR_MATCH){
      // --- gareso 隣接追加消去の準備（クラスタ内にgaresoがある場合のみ）---
      const hasGareso = cluster.some(({r,c}) => {
        const cell = board[r]?.[c];
        return cell && cell.avatarId === "gareso";
      });
      const extraToClear = new Set();
      if (hasGareso){
        for (const {r,c} of cluster){
          const cell = board[r]?.[c];
          if (!cell || cell.avatarId !== "gareso") continue;
          const nbs = PXGrid.neighbors(r,c);
          for (const nb of nbs){
            if (!PXGrid.inBounds(board, nb.row, nb.col)) continue;
            const ncell = board[nb.row][nb.col];
            if (!ncell) continue;
            extraToClear.add(`${nb.row},${nb.col}`);
          }
        }
      }

      // --- 既存：同色クラスタ本体の消去 ---
      for (const {r,c} of cluster){
        if (board[r][c]){
          if (audioUnlocked) playClearVoice(board[r][c].avatarId);
          board[r][c] = null;
        }
      }

      // --- 追加：gareso が含まれていた場合のみ、隣接1層を消去 ---
      if (hasGareso){
        for (const key of extraToClear){
          const [rr, cc] = key.split(",").map(Number);
          const cell = board[rr]?.[cc];
          if (!cell) continue; // 既にクラスタ消去で消えている可能性に配慮
          if (audioUnlocked) playClearVoice(cell.avatarId);
          board[rr][cc] = null;
        }
      }

      // --- 孤立塊の落下（既存） ---
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

  // ====== 描画 ======
  function draw(){
    ctx.clearRect(0,0,cv.width, cv.height);

    // 背景
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0,0,cv.width, cv.height);

    // 盤面
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < CONFIG.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const {x,y} = PXGrid.cellCenter(r, c, dropOffsetY);
        drawAvatarBall(x,y, cell.avatarId);
      }
    }

    // プレイヤー砲台
    ctx.fillStyle = "#3dd5f3";
    ctx.fillRect(playerX-18, playerY, 36, 8);

    // 照準
    ctx.strokeStyle = "#3dd5f3";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playerX, playerY);
    ctx.lineTo(aimX, aimY);
    ctx.stroke();

    // 弾（現弾/移動中/次弾）
    if (currentBall){
      drawAvatarBall(playerX, playerY-28, currentBall.avatarId, CONFIG.AVATAR_IMAGE_SIZE);
    }
    if (movingBall){
      drawAvatarBall(movingBall.x, movingBall.y, movingBall.avatarId);
    }
    if (nextBall){
      const nctx = cvNext.getContext("2d");
      nctx.clearRect(0,0,cvNext.width, cvNext.height);
      drawAvatarBall(cvNext.width/2, cvNext.height/2, nextBall.avatarId, CONFIG.NEXT_PREVIEW_SIZE, nctx);
    }

    // 天井ライン
    ctx.strokeStyle = "#30343a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CONFIG.LEFT_MARGIN, CONFIG.TOP_MARGIN + dropOffsetY);
    ctx.lineTo(cv.width - CONFIG.RIGHT_MARGIN, CONFIG.TOP_MARGIN + dropOffsetY);
    ctx.stroke();
  }

  function drawAvatarBall(x,y, avatarId, size=CONFIG.AVATAR_IMAGE_SIZE, targetCtx=ctx){
    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.arc(x, y, CONFIG.R, 0, Math.PI*2);
    targetCtx.closePath();
    targetCtx.fillStyle = "#222";
    targetCtx.fill();

    const img = images.get(avatarId);
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

  // ====== ループ ======
  let lastTime = 0;
  function loop(t){
    const now = t || performance.now();
    const dt = Math.min(0.033, (now - lastTime)/1000);
    lastTime = now;

    if (!isPaused && !gameOver){
      updateMovingBall(dt);
      draw();
    }
    requestAnimationFrame(loop);
  }

  // ====== ポーズ/再開/リトライ ======
  btnPause.addEventListener("click", ()=>{
    if (gameOver) return;
    isPaused = true;
    overlay.classList.add("show");
    overlayText.textContent = "PAUSE";
  });
  btnResume.addEventListener("click", ()=>{
    isPaused = false;
    overlay.classList.remove("show");
  });
  btnRetry.addEventListener("click", resetGame);
  btnOverlayRetry.addEventListener("click", resetGame);

  function resetGame(){
    // 状態初期化
    board = PXGrid.createBoard(CONFIG.BOARD_ROWS, CONFIG.COLS);
    dropOffsetY = 0;
    shotsCount = 0;
    shotsUntilDrop = CONFIG.CEILING_DROP_PER_SHOTS;
    updateShotsLeftUI();
    gameOver = false;
    isPaused = false;
    overlay.classList.remove("show");

    spawnInitialBoard();
    spawnNextBalls();
  }

  // ====== START（オーディオ解禁） ======
  btnStart.addEventListener("click", async ()=>{
    if (!audioCtx){
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      bgmGain = audioCtx.createGain();
      seGain = audioCtx.createGain();
      bgmGain.gain.value = parseFloat(bgmVolInput.value || "0.6");
      seGain.gain.value = 0.9;

      // BGM/SEのロード
      bgmBuffer = await loadAudioBuffer("./assets/sound/bgm.mp3").catch(()=>null);
      shotBuf = await loadAudioBuffer("./assets/sound/shot.mp3").catch(()=>null);
      hitBuf = await loadAudioBuffer("./assets/sound/hit.mp3").catch(()=>null);

      // ボイスのロード
      for (const a of AVATARS){
        const bufs = [];
        if (a.voice && a.voice.length){
          for (const v of a.voice){
            const b = await loadAudioBuffer(v).catch(()=>null);
            if (b) bufs.push(b);
          }
        }
        voiceBuffers.set(a.id, bufs);
      }
    }

    audioUnlocked = true;
    playBGM();

    // UI片付け
    startOverlay.classList.add("hide");
    setTimeout(()=>startOverlay.remove(), 250);
  });

  bgmVolInput.addEventListener("input", ()=>{
    if (bgmGain){
      bgmGain.gain.value = parseFloat(bgmVolInput.value || "0.6");
    }
  });

  // ====== 起動 ======
  (async function init(){
    await loadData();
    cv.width = 480;
    cv.height = 720;
    cvNext.width = 96;
    cvNext.height = 96;

    playerX = cv.width/2;
    playerY = cv.height - CONFIG.BOTTOM_MARGIN;

    spawnInitialBoard();
    spawnNextBalls();
    updateShotsLeftUI();
    requestAnimationFrame(loop);
  })();

})();
