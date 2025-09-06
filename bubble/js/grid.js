// grid.js - 三角格子（オフセット格子）とユーティリティ
(() => {
  const Grid = {};

  // 格子設定（game.jsから上書きされる）
  Grid.COLS = 12;
  Grid.R = 18; // 半径(px) 画面座標の計算で使用
  Grid.TOP_MARGIN = 24;

  // 行間隔（正三角形高さ）= sqrt(3) * R
  Object.defineProperty(Grid, 'ROW_H', { get(){ return Math.sqrt(3) * Grid.R; } });

  // 行の偶奇でxオフセット（半マス）
  Grid.rowXOffset = (row) => (row % 2 === 1 ? Grid.R : 0);

  // (row,col) -> (x,y) 画面中心座標
  Grid.cellCenter = (row, col, dropOffsetY = 0) => {
    const x = Grid.R + col * Grid.R * 2 + Grid.rowXOffset(row) + 24; // 左余白=24
    const y = Grid.TOP_MARGIN + row * Grid.ROW_H + 24 + dropOffsetY; // 上余白=24
    return { x, y };
  };

  // (x,y) -> 近傍のセル推定（スナップ用に周囲セルを広く検討）
  Grid.nearbyCells = (x, y, dropOffsetY = 0) => {
    // 逆変換の近似：行を推定
    const rowApprox = Math.max(0, Math.floor((y - (Grid.TOP_MARGIN + 24 + dropOffsetY)) / Grid.ROW_H + 0.5));
    const cells = [];
    for (let dr = -2; dr <= 2; dr++) {
      const r = rowApprox + dr;
      if (r < 0) continue;
      const xo = Grid.rowXOffset(r);
      const colApprox = Math.floor((x - (Grid.R + xo + 24)) / (Grid.R * 2) + 0.5);
      for (let dc = -2; dc <= 2; dc++) {
        const c = colApprox + dc;
        if (c < 0 || c >= Grid.COLS) continue;
        cells.push({ row: r, col: c });
      }
    }
    return cells;
  };

  // 近接（同色探索）用の近隣6方向（オフセット格子）
  Grid.neighbors = (row, col) => {
    const odd = row % 2 === 1;
    const deltas = odd
      ? [[-1,0],[-1,1],[0,-1],[0,1],[1,0],[1,1]]
      : [[-1,-1],[-1,0],[0,-1],[0,1],[1,-1],[1,0]];
    return deltas.map(([dr,dc]) => ({ row: row+dr, col: col+dc }));
  };

  // 盤面配列の初期化（可変高さ）
  Grid.createBoard = (rows, cols) => {
    const b = [];
    for (let r = 0; r < rows; r++){
      b[r] = new Array(cols).fill(null); // {color, imgIdx, avatarId}
    }
    return b;
  };

  // 盤面の有効セル判定
  Grid.inBounds = (board, r, c) => (r >= 0 && r < board.length && c >= 0 && c < Grid.COLS);

  // 盤面に存在する色の集合
  Grid.existingColors = (board) => {
    const set = new Set();
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < Grid.COLS; c++){
        const cell = board[r][c];
        if (cell && cell.color) set.add(cell.color);
      }
    }
    return Array.from(set);
  };

  // 同色連結の探索（BFS）
  Grid.findCluster = (board, startR, startC) => {
    const target = board[startR]?.[startC];
    if (!target) return [];
    const color = target.color;
    const vis = new Set();
    const q = [{ r: startR, c: startC }];
    const result = [];
    const key = (r,c)=>`${r},${c}`;

    while(q.length){
      const {r,c} = q.shift();
      const k = key(r,c);
      if (vis.has(k)) continue;
      vis.add(k);
      const cell = board[r]?.[c];
      if (!cell || cell.color !== color) continue;
      result.push({ r, c });
      for (const nb of Grid.neighbors(r,c)){
        if (!Grid.inBounds(board, nb.row, nb.col)) continue;
        q.push({ r: nb.row, c: nb.col });
      }
    }
    return result;
  };

  // 天井（row==0 と連結）に繋がるセル群を探索
  Grid.findCeilingConnected = (board) => {
    const vis = new Set();
    const key = (r,c)=>`${r},${c}`;
    const q = [];
    // row 0 の全セルから開始
    for (let c = 0; c < Grid.COLS; c++){
      if (board[0]?.[c]) q.push({ r:0, c });
    }
    while(q.length){
      const {r,c} = q.shift();
      const k = key(r,c);
      if (vis.has(k)) continue;
      vis.add(k);
      for (const nb of Grid.neighbors(r,c)){
        if (!Grid.inBounds(board, nb.row, nb.col)) continue;
        const cell = board[nb.row][nb.col];
        if (cell) q.push({ r: nb.row, c: nb.col });
      }
    }
    return vis; // "r,c" のセット
  };

  window.PXGrid = Grid;
})();
