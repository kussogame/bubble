// physics.js - 発射・反射・衝突・スナップ
(() => {
  const Phys = {};

  // 壁反射（水平のみ）
  Phys.reflectIfNeeded = (ball, bounds) => {
    const { x, y, vx, vy, r } = ball;
    if (x - r <= bounds.left && vx < 0) ball.vx *= -1;
    if (x + r >= bounds.right && vx > 0) ball.vx *= -1;
  };

  // 既存セルとの衝突検出（距離 <= 2R - ε）
  Phys.checkCollision = (ball, board, dropOffsetY, R) => {
    const eps = 0.5;
    for (let r = 0; r < board.length; r++){
      for (let c = 0; c < PXGrid.COLS; c++){
        const cell = board[r][c];
        if (!cell) continue;
        const { x, y } = PXGrid.cellCenter(r, c, dropOffsetY);
        const dx = ball.x - x, dy = ball.y - y;
        const dist2 = dx*dx + dy*dy;
        const minD = (R*2 - eps);
        if (dist2 <= minD*minD) return { hit:true, r, c, x, y };
      }
    }
    return { hit:false };
  };

  // 天井に付くか？
  Phys.hitCeiling = (ball, topY, R) => (ball.y - R <= topY);

  // スナップ先セルの決定：
  //  - 衝突対象の周辺の空セルから、最も中心距離が近い場所へ
  Phys.chooseSnapCell = (board, dropOffsetY, R, impactX, impactY, aroundCell) => {
    const candidates = [];

    const pushIfEmpty = (rr,cc) => {
      if (!PXGrid.inBounds(board, rr, cc)) return;
      if (!board[rr][cc]) {
        const {x,y} = PXGrid.cellCenter(rr, cc, dropOffsetY);
        const dx = x - impactX, dy = y - impactY;
        candidates.push({ r:rr, c:cc, dist2: dx*dx+dy*dy });
      }
    };

    // 優先：衝突セルの周辺
    const around = [{row:aroundCell.r, col:aroundCell.c}, ...PXGrid.neighbors(aroundCell.r, aroundCell.c)];
    for (const cell of around){
      pushIfEmpty(cell.row, cell.col);
    }
    // 無ければ近傍広め
    if (!candidates.length){
      for (const nb of PXGrid.nearbyCells(impactX, impactY, dropOffsetY)){
        pushIfEmpty(nb.row, nb.col);
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a,b)=>a.dist2-b.dist2);
    return { row:candidates[0].r, col:candidates[0].c };
  };

  window.PXPhys = Phys;
})();
