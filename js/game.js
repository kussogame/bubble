/* =========================================================================
 * bubble / game.js  (上書き用フルコード)
 * 目的: 画像アセットの一部404でもゲームが起動するように初期化を堅牢化
 * 外部I/Fは維持:  index.html 側からは init() / startGame() を同名で呼べます
 * ========================================================================= */

(() => {
  "use strict";

  // ===== グローバル（最小限） =====
  let canvas, ctx;
  let W = 960, H = 540;       // 既定のキャンバス解像度（必要ならCSSで拡縮）
  let rafId = null;
  let lastTs = 0;

  // アセットとデータ構造
  let palette = [];               // 色パレット（avatars.json）
  let avatars = [];               // {id, file, color} の配列
  const images = Object.create(null); // id -> HTMLImageElement
  const sounds = Object.create(null); // name -> HTMLAudioElement

  // ゲーム状態
  const STATE = {
    scene: "title",         // "title" | "playing" | "clear" | "gameover"
    bubbles: [],            // プレイフィールド上の玉
    shooter: null,          // 発射機
    nextQueue: [],          // 次に出る候補
    score: 0,
    time: 0
  };

  // 入力
  const INPUT = {
    pointerDown: false,
    pointerX: 0,
    pointerY: 0
  };

  // ====== 初期化と起動 ======
  async function init() {
    // DOM取得
    canvas = document.getElementById("game");
    if (!canvas) {
      // HTML側に <canvas id="game"> が無いと何も描けない
      console.error("[game] <canvas id='game'> が見つかりません。HTMLを確認してください。");
      return;
    }
    ctx = canvas.getContext("2d", { alpha: false });
    resizeCanvas();

    // 画像/音の読み込み
    try {
      await loadAllAssets();   // ← [CHANGED] 内部で allSettled を使って堅牢化
    } catch (e) {
      // ここに落ちることは基本ありません（allSettled化したため）
      console.error("[game] アセット読み込みで致命的エラー:", e);
    }

    // ロジック初期化
    setupInitialState();

    // 入力イベント
    bindInputs();

    // タイトル表示状態で待機
    STATE.scene = "title";
    draw(0); // 初回描画
    console.info("[game] init 完了");
  }

  function startGame() {
    if (STATE.scene !== "title" && STATE.scene !== "gameover" && STATE.scene !== "clear") {
      return; // すでにプレイ中
    }
    STATE.scene = "playing";
    STATE.score = 0;
    STATE.time = 0;
    STATE.bubbles.length = 0;
    setupShooter();
    setupStage();

    // ループ開始
    cancelAnim();
    lastTs = performance.now();
    const loop = (ts) => {
      const dt = Math.min(33, ts - lastTs);
      lastTs = ts;
      update(dt);
      draw(dt);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    console.info("[game] startGame");
  }

  function cancelAnim() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ====== アセット読み込み ======

  async function loadAllAssets() {
    // avatars.json 読み込み（色/ファイル一覧）
    await loadAvatarsJSON();

    // 画像をまとめて読み込み（欠落を許容）
    await loadAvatarImagesSafe();

    // 必要な効果音あれば（存在しない場合はスキップ）
    await loadSoundsSafe([
      { key: "shoot",  file: "assets/sound/shoot.mp3"  },
      { key: "pop",    file: "assets/sound/pop.mp3"    },
      { key: "clear",  file: "assets/sound/clear.mp3"  },
      { key: "over",   file: "assets/sound/over.mp3"   },
      { key: "bgm",    file: "assets/sound/bgm.mp3", loop: true, volume: 0.4 }
    ]);
  }

  async function loadAvatarsJSON() {
    const resp = await fetch("data/avatars.json", { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`avatars.json 読み込み失敗: ${resp.status} ${resp.statusText}`);
    }
    const data = await resp.json();

    // 色パレット
    palette = Array.isArray(data.palette) ? data.palette.slice() : [];

    // アバター一覧
    if (!Array.isArray(data.avatars)) {
      throw new Error("avatars.json の 'avatars' が配列ではありません。");
    }

    // ID重複チェック（警告のみ）
    const seen = new Set();
    const dup = [];
    for (const a of data.avatars) {
      if (!a || !a.id || !a.file) continue;
      if (seen.has(a.id)) dup.push(a.id);
      seen.add(a.id);
    }
    if (dup.length) {
      console.warn("[game] avatars.json: ID重複があります →", Array.from(new Set(dup)));
    }

    avatars = data.avatars.slice();
  }

  async function loadAvatarImagesSafe() {
    // 画像の同時読み込み（1件でも失敗で全体停止…を避ける）
    const tasks = avatars.map(a =>
      loadImageSmart(a.file).then(img => ({ status: "fulfilled", a, img }))
        .catch(err => ({ status: "rejected", a, err }))
    );

    const results = await Promise.all(tasks); // ← 個別に catch 済みなので allSettled 代替

    // 失敗は除外、成功だけ詰め直す
    const okAvatars = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        images[r.a.id] = r.img;
        okAvatars.push(r.a);
      } else {
        console.warn("[game] missing asset (skip):", r.a && r.a.file, r.err && String(r.err));
      }
    }

    // 1件も成功が無い場合はダミーを1枚作っておく（ゲームが真っ黒を避ける）
    if (okAvatars.length === 0) {
      console.warn("[game] 有効なアバター画像が0件でした。ダミーを生成します。");
      const dummyId = "dummy";
      images[dummyId] = makeDummyImage(48, 48);
      avatars = [{ id: dummyId, file: "(dummy)", color: "#888888" }];
      return;
    }

    avatars = okAvatars;
  }

  function loadImageSmart(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Image 404: ${src}`));
      img.src = src;
    });
  }

  function makeDummyImage(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = "#444";
    x.fillRect(0,0,w,h);
    x.strokeStyle = "#aaa";
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(0,0); x.lineTo(w,h);
    x.moveTo(w,0); x.lineTo(0,h);
    x.stroke();
    return c;
  }

  async function loadSoundsSafe(list) {
    // オーディオはブラウザの自動再生制約があるため、ここではデコードのみ実施
    for (const s of list) {
      const a = new Audio();
      a.preload = "auto";
      if (s.loop) a.loop = true;
      if (typeof s.volume === "number") a.volume = s.volume;
      a.src = s.file;

      // 存在チェック（HEADが使えない環境でもonerrorで拾う）
      try {
        await new Promise((res, rej) => {
          a.oncanplaythrough = () => res();
          a.onerror = () => rej(new Error(`Audio 404: ${s.file}`));
          // iOS系でoncanplaythroughが呼ばれにくいことがあるのでタイムアウト保険
          setTimeout(() => res(), 2000);
        });
        sounds[s.key] = a;
      } catch (e) {
        console.warn("[game] missing sound (skip):", s.file, String(e));
      }
    }
  }

  // ====== ゲームセットアップ ======

  function setupInitialState() {
    // 発射機と次手
    setupShooter();
    setupQueue();
  }

  function setupShooter() {
    // 中央下に設置
    STATE.shooter = {
      x: W * 0.5,
      y: H - 64,
      angle: -Math.PI / 2,   // 上向き
      power: 12,
      ready: true,
      current: pickAvatarId()
    };
  }

  function setupQueue() {
    STATE.nextQueue = [];
    for (let i = 0; i < 3; i++) {
      STATE.nextQueue.push(pickAvatarId());
    }
  }

  function setupStage() {
    // 簡易：上部に数段だけ並べる
    const cols = 12;
    const rows = 6;
    const radius = 20;
    const offsetX = (W - cols * radius * 2) * 0.5 + radius;
    const offsetY = 60;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const id = pickAvatarId();
        STATE.bubbles.push({
          x: offsetX + c * radius * 2,
          y: offsetY + r * radius * 2,
          r: radius,
          id,
          vx: 0,
          vy: 0,
          fixed: true,
          remove: false
        });
      }
    }
  }

  function pickAvatarId() {
    if (avatars.length === 0) return "dummy";
    const i = (Math.random() * avatars.length) | 0;
    return avatars[i].id;
  }

  // ====== 入力処理 ======
  function bindInputs() {
    function localXY(ev) {
      const rect = canvas.getBoundingClientRect();
      let clientX, clientY;
      if (ev.touches && ev.touches.length) {
        clientX = ev.touches[0].clientX; clientY = ev.touches[0].clientY;
      } else {
        clientX = ev.clientX; clientY = ev.clientY;
      }
      return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top)  * (canvas.height / rect.height),
      };
    }

    canvas.addEventListener("pointerdown", (e) => {
      INPUT.pointerDown = true;
      const p = localXY(e);
      INPUT.pointerX = p.x; INPUT.pointerY = p.y;
      aimShooter(p);
    });

    canvas.addEventListener("pointermove", (e) => {
      const p = localXY(e);
      INPUT.pointerX = p.x; INPUT.pointerY = p.y;
      aimShooter(p);
    });

    window.addEventListener("pointerup", () => {
      if (!INPUT.pointerDown) return;
      INPUT.pointerDown = false;
      // 発射
      shoot();
    });

    // リサイズ
    window.addEventListener("resize", resizeCanvas);

    // タイトル→開始のためのキーバインド
    window.addEventListener("keydown", (e) => {
      if (STATE.scene === "title" && (e.code === "Space" || e.code === "Enter")) {
        startGame();
      }
    });
  }

  function aimShooter(p) {
    if (!STATE.shooter) return;
    const dx = p.x - STATE.shooter.x;
    const dy = p.y - STATE.shooter.y;
    STATE.shooter.angle = Math.atan2(dy, dx);
  }

  function shoot() {
    const s = STATE.shooter;
    if (!s || !s.ready || STATE.scene !== "playing") return;

    const speed = s.power;
    const vx = Math.cos(s.angle) * speed;
    const vy = Math.sin(s.angle) * speed;

    STATE.bubbles.push({
      x: s.x,
      y: s.y,
      r: 20,
      id: s.current,
      vx, vy,
      fixed: false,
      remove: false
    });

    s.ready = false;

    // 次弾繰り上げ
    s.current = STATE.nextQueue.shift() || pickAvatarId();
    STATE.nextQueue.push(pickAvatarId());

    // 効果音
    playSound("shoot");
  }

  function playSound(key) {
    const a = sounds[key];
    if (!a) return;
    try {
      // iOS制限対策: ユーザ操作後にのみ再生が通る
      a.currentTime = 0;
      a.play().catch(()=>{});
    } catch {}
  }

  // ====== 更新・描画 ======
  function update(dt) {
    if (STATE.scene !== "playing") return;

    STATE.time += dt;

    // 玉の移動・壁反射
    for (const b of STATE.bubbles) {
      if (b.fixed) continue;
      b.x += b.vx;
      b.y += b.vy;

      // 壁反射
      if (b.x < b.r)   { b.x = b.r;   b.vx *= -1; }
      if (b.x > W-b.r) { b.x = W-b.r; b.vx *= -1; }
      if (b.y < b.r)   { b.y = b.r;   b.vy *= -1; }

      // 既存固定玉に衝突したら固定
      const hit = collideWithFixed(b);
      if (hit) {
        b.fixed = true;
        b.vx = b.vy = 0;
        // 連結消去の簡易ルール
        const removed = tryPopConnected(b);
        if (removed > 0) {
          STATE.score += removed * 10;
          playSound("pop");
        }
        // 次弾OK
        STATE.shooter.ready = true;
      }
    }

    // 画面外に落ちた飛翔体は消す
    for (const b of STATE.bubbles) {
      if (!b.fixed && b.y > H + b.r * 2) b.remove = true;
    }
    purgeRemoved();

    // クリア/ゲームオーバー判定（簡易）
    const anyTop = STATE.bubbles.some(b => b.fixed && b.y < 40);
    if (!STATE.bubbles.some(b => b.fixed)) {
      STATE.scene = "clear";
      playSound("clear");
      STATE.shooter.ready = false;
      cancelAnim();
    } else if (anyTop) {
      STATE.scene = "gameover";
      playSound("over");
      STATE.shooter.ready = false;
      cancelAnim();
    }
  }

  function collideWithFixed(mov) {
    // 固定玉に接触したら「その場で固定」するシンプル仕様
    for (const f of STATE.bubbles) {
      if (!f.fixed) continue;
      const dx = mov.x - f.x;
      const dy = mov.y - f.y;
      const rr = mov.r + f.r;
      if (dx*dx + dy*dy <= rr*rr) {
        // 近傍のグリッドに吸着（簡易: fの上側にくっつける）
        const ang = Math.atan2(dy, dx);
        mov.x = f.x + Math.cos(ang) * rr;
        mov.y = f.y + Math.sin(ang) * rr;
        return true;
      }
    }
    // 天井に着いたら固定
    if (mov.y <= mov.r + 40) {
      mov.y = mov.r + 40;
      return true;
    }
    return false;
  }

  function tryPopConnected(seed) {
    // 同色3つ以上で消える簡易ルール
    const group = floodFill(seed);
    if (group.length >= 3) {
      for (const b of group) b.remove = true;
      purgeRemoved();
      return group.length;
    }
    return 0;
  }

  function floodFill(seed) {
    const stack = [seed];
    const visited = new Set();
    const same = [];
    while (stack.length) {
      const cur = stack.pop();
      const key = STATE.bubbles.indexOf(cur);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!cur.fixed) continue;
      if (cur.id !== seed.id) continue;
      same.push(cur);
      for (const nb of neighbors(cur)) {
        const nk = STATE.bubbles.indexOf(nb);
        if (!visited.has(nk)) stack.push(nb);
      }
    }
    return same;
  }

  function neighbors(b) {
    const near = [];
    const rr = (b.r * 2 + 2) ** 2;
    for (const o of STATE.bubbles) {
      if (!o.fixed || o === b) continue;
      const dx = o.x - b.x;
      const dy = o.y - b.y;
      if (dx*dx + dy*dy <= rr) near.push(o);
    }
    return near;
  }

  function purgeRemoved() {
    for (let i = STATE.bubbles.length - 1; i >= 0; i--) {
      if (STATE.bubbles[i].remove) STATE.bubbles.splice(i, 1);
    }
  }

  function draw(dt) {
    // 背景
    ctx.fillStyle = "#0b0b0b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // タイトル
    if (STATE.scene === "title") {
      drawTitle();
      return;
    }

    // バブル
    for (const b of STATE.bubbles) {
      drawBubble(b);
    }

    // シューター
    drawShooter();

    // HUD
    ctx.fillStyle = "#ffffff";
    ctx.font = "16px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif";
    ctx.fillText(`SCORE: ${STATE.score}`, 16, 24);

    if (STATE.scene === "clear" || STATE.scene === "gameover") {
      drawResultOverlay();
    }
  }

  function drawTitle() {
    ctx.fillStyle = "#10151a";
    ctx.fillRect(0,0,canvas.width, canvas.height);

    ctx.fillStyle = "#fff";
    ctx.font = "bold 36px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("BUBBLE SHOOTER", canvas.width/2, canvas.height/2 - 40);

    ctx.font = "18px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif";
    ctx.fillText("クリック / タップで方向 → 離して発射", canvas.width/2, canvas.height/2 + 6);
    ctx.fillText("Space/Enter でも開始できます", canvas.width/2, canvas.height/2 + 32);
  }

  function drawResultOverlay() {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = STATE.scene === "clear" ? "#124d2b" : "#4d1212";
    ctx.fillRect(0,0,canvas.width, canvas.height);
    ctx.restore();

    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.font = "bold 40px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif";
    ctx.fillText(STATE.scene === "clear" ? "CLEAR!" : "GAME OVER", canvas.width/2, canvas.height/2 - 8);

    ctx.font = "20px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif";
    ctx.fillText("Space/Enter で再スタート", canvas.width/2, canvas.height/2 + 28);
  }

  function drawBubble(b) {
    // 塗り色
    const a = avatars.find(v => v.id === b.id);
    const color = a?.color || "#cccccc";

    // 円
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // 画像（あれば）
    const img = images[b.id];
    if (img) {
      const s = b.r * 1.6;
      ctx.drawImage(img, b.x - s/2, b.y - s/2, s, s);
    }
  }

  function drawShooter() {
    const s = STATE.shooter;
    if (!s) return;

    // 砲台
    ctx.strokeStyle = "#dddddd";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + Math.cos(s.angle) * 40, s.y + Math.sin(s.angle) * 40);
    ctx.stroke();

    // 次弾表示
    const r = 20;
    ctx.fillStyle = "#222";
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 6, 0, Math.PI*2);
    ctx.fill();

    // 現在の弾
    drawBubble({ x: s.x, y: s.y, r, id: s.current, fixed: true });

    // キュー表示
    let ox = s.x + 60;
    for (const id of STATE.nextQueue) {
      drawBubble({ x: ox, y: s.y, r: 14, id, fixed: true });
      ox += 36;
    }
  }

  // ====== ユーティリティ ======

  function resizeCanvas() {
    // CSSサイズに合わせて内部解像度を合わせる（高DPI考慮）
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    const targetW = Math.max(640, Math.floor(rect.width  * dpr));
    const targetH = Math.max(360, Math.floor(rect.height * dpr));

    canvas.width = targetW;
    canvas.height = targetH;

    W = canvas.width;
    H = canvas.height;
  }

  // ====== 公開関数 ======
  window.init = init;
  window.startGame = startGame;

})();
