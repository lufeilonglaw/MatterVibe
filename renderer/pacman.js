// pacman.js —— 首页隐藏彩蛋：经典大嘴吃豆。浮窗形式，可关闭。
// 触发：首页输入 codeislaw。不出现在任何菜单或版本说明中。
'use strict';

(function () {
  const COLS = 19, ROWS = 21, TILE = 20;
  // 地图：# 墙  . 豆  o 能量豆  空格 通道
  const MAP = [
    '###################',
    '#........#........#',
    '#o##.###.#.###.##o#',
    '#.................#',
    '#.##.#.#####.#.##.#',
    '#....#...#...#....#',
    '####.### # ###.####',
    '   #.#       #.#   ',
    '####.# ##=## #.####',
    '#......#   #......#',
    '####.# ##### #.####',
    '   #.#       #.#   ',
    '####.# ##### #.####',
    '#........#........#',
    '#.##.###.#.###.##.#',
    '#o.#.....P.....#.o#',
    '##.#.#.#####.#.#.##',
    '#....#...#...#....#',
    '#.######.#.######.#',
    '#.................#',
    '###################'
  ];

  let canvas, ctx, raf;
  let grid, pac, ghosts, score, lives, powerTimer, running, dotsLeft;

  function parseMap() {
    grid = [];
    dotsLeft = 0;
    pac = null; ghosts = [];
    for (let r = 0; r < ROWS; r++) {
      grid[r] = [];
      for (let c = 0; c < COLS; c++) {
        const ch = MAP[r][c];
        if (ch === '#') grid[r][c] = 'wall';
        else if (ch === '.') { grid[r][c] = 'dot'; dotsLeft++; }
        else if (ch === 'o') { grid[r][c] = 'power'; dotsLeft++; }
        else grid[r][c] = 'empty';
        if (ch === 'P') pac = { c, r, dx: 0, dy: 0, ndx: 0, ndy: 0, mouth: 0 };
        if (ch === '=') { /* 鬼门 */ grid[r][c] = 'gate'; }
      }
    }
    // 四只鬼出生在中间屋
    const gx = 9, gy = 9;
    const colors = ['#E5484D', '#F5A623', '#4D7CFE', '#8E939E'];
    for (let i = 0; i < 4; i++) ghosts.push({ c: gx, r: gy, dx: 0, dy: -1, color: colors[i], scared: false, home: { c: gx, r: gy } });
    score = 0; lives = 3; powerTimer = 0;
  }

  function canMove(c, r) {
    if (r < 0 || r >= ROWS) return false;
    // 横向隧道
    if (c < 0 || c >= COLS) return true;
    return grid[r][c] !== 'wall' && grid[r][c] !== 'gate';
  }
  function wrap(c) { return (c + COLS) % COLS; }

  function step() {
    if (!running) return;
    // Pac 转向
    if (pac.ndx !== pac.dx || pac.ndy !== pac.dy) {
      if (canMove(wrap(pac.c + pac.ndx), pac.r + pac.ndy)) { pac.dx = pac.ndx; pac.dy = pac.ndy; }
    }
    if (canMove(wrap(pac.c + pac.dx), pac.r + pac.dy)) {
      pac.c = wrap(pac.c + pac.dx); pac.r += pac.dy;
    }
    pac.mouth = (pac.mouth + 1) % 4;
    // 吃豆
    const cell = grid[pac.r][pac.c];
    if (cell === 'dot') { grid[pac.r][pac.c] = 'empty'; score += 10; dotsLeft--; }
    else if (cell === 'power') { grid[pac.r][pac.c] = 'empty'; score += 50; dotsLeft--; powerTimer = 28; ghosts.forEach(g => g.scared = true); }
    if (powerTimer > 0) { powerTimer--; if (powerTimer === 0) ghosts.forEach(g => g.scared = false); }

    // 鬼移动（简单追逐/逃逸）
    for (const g of ghosts) {
      const opts = [];
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (dx === -g.dx && dy === -g.dy) continue; // 不回头
        if (canMove(wrap(g.c + dx), g.r + dy)) opts.push([dx, dy]);
      }
      if (opts.length) {
        // 朝 pac 方向择优；scared 时反向
        opts.sort((a, b) => {
          const da = Math.hypot(wrap(g.c+a[0]) - pac.c, g.r+a[1] - pac.r);
          const db = Math.hypot(wrap(g.c+b[0]) - pac.c, g.r+b[1] - pac.r);
          return g.scared ? db - da : da - db;
        });
        const pick = Math.random() < 0.78 ? opts[0] : opts[Math.floor(Math.random()*opts.length)];
        g.dx = pick[0]; g.dy = pick[1];
      }
      g.c = wrap(g.c + g.dx); g.r += g.dy;
      // 碰撞
      if (g.c === pac.c && g.r === pac.r) handleCollision(g);
    }

    if (dotsLeft <= 0) { running = false; drawWin(); return; }
  }

  function handleCollision(g) {
    if (g.scared) { score += 200; g.c = g.home.c; g.r = g.home.r; g.scared = false; }
    else {
      lives--;
      if (lives <= 0) { running = false; drawOver(); }
      else { pac.c = 9; pac.r = 15; pac.dx = pac.dy = pac.ndx = pac.ndy = 0; }
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0b0b16'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const x = c*TILE, y = r*TILE, cell = grid[r][c];
      if (cell === 'wall') { ctx.fillStyle = '#1f2547'; ctx.fillRect(x+1, y+1, TILE-2, TILE-2); }
      else if (cell === 'gate') { ctx.fillStyle = '#444'; ctx.fillRect(x+2, y+TILE/2-1, TILE-4, 2); }
      else if (cell === 'dot') { ctx.fillStyle = '#ffd24d'; ctx.beginPath(); ctx.arc(x+TILE/2, y+TILE/2, 2, 0, 7); ctx.fill(); }
      else if (cell === 'power') { ctx.fillStyle = '#ffd24d'; ctx.beginPath(); ctx.arc(x+TILE/2, y+TILE/2, 5, 0, 7); ctx.fill(); }
    }
    // Pac
    const px = pac.c*TILE+TILE/2, py = pac.r*TILE+TILE/2;
    const open = [0.05, 0.22, 0.35, 0.22][pac.mouth];
    let ang = 0;
    if (pac.dx === 1) ang = 0; else if (pac.dx === -1) ang = Math.PI;
    else if (pac.dy === 1) ang = Math.PI/2; else if (pac.dy === -1) ang = -Math.PI/2;
    ctx.fillStyle = '#ffd24d';
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.arc(px, py, TILE/2-1, ang + open*Math.PI, ang - open*Math.PI + 2*Math.PI);
    ctx.closePath(); ctx.fill();
    // Ghosts
    for (const g of ghosts) {
      const gx = g.c*TILE+TILE/2, gy = g.r*TILE+TILE/2;
      ctx.fillStyle = g.scared ? '#5a7bd8' : g.color;
      ctx.beginPath();
      ctx.arc(gx, gy, TILE/2-1, Math.PI, 0);
      ctx.lineTo(gx+TILE/2-1, gy+TILE/2-1);
      ctx.lineTo(gx-TILE/2+1, gy+TILE/2-1);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(gx-3, gy-1, 2.5, 0, 7); ctx.arc(gx+3, gy-1, 2.5, 0, 7); ctx.fill();
    }
    drawHud();
  }
  function drawHud() {
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px -apple-system, sans-serif';
    ctx.textAlign = 'left'; ctx.fillText('得分 ' + score, 8, ROWS*TILE + 18);
    ctx.textAlign = 'right'; ctx.fillText('♥ '.repeat(Math.max(0,lives)), COLS*TILE - 8, ROWS*TILE + 18);
  }
  function drawCenter(text, sub) {
    draw();
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, canvas.width, ROWS*TILE);
    ctx.fillStyle = '#ffd24d'; ctx.font = 'bold 26px -apple-system, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(text, canvas.width/2, ROWS*TILE/2 - 6);
    ctx.fillStyle = '#fff'; ctx.font = '13px -apple-system, sans-serif';
    ctx.fillText(sub, canvas.width/2, ROWS*TILE/2 + 20);
  }
  function drawOver() { drawCenter('GAME OVER', '得分 ' + score + ' · 按 R 重新开始'); }
  function drawWin() { drawCenter('YOU WIN! ', '得分 ' + score + ' · 按 R 再玩一次'); }

  let last = 0;
  function currentInterval() {
    // 开局 220ms/步，每吃 30 分加快一点，下限 130ms
    const sp = 220 - Math.min(90, Math.floor(score / 30) * 5);
    return Math.max(130, sp);
  }
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (running && ts - last > currentInterval()) { last = ts; step(); }
    // 渲染每帧都跑，画面平滑不卡顿
    if (running) draw();
  }

  function onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') { pac.ndx = 0; pac.ndy = -1; e.preventDefault(); }
    else if (k === 'arrowdown' || k === 's') { pac.ndx = 0; pac.ndy = 1; e.preventDefault(); }
    else if (k === 'arrowleft' || k === 'a') { pac.ndx = -1; pac.ndy = 0; e.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { pac.ndx = 1; pac.ndy = 0; e.preventDefault(); }
    else if (k === 'r' && !running) { parseMap(); running = true; }
  }

  window.openPacman = function () {
    const float = document.getElementById('pac-float');
    float.classList.remove('hidden');
    canvas = document.getElementById('pac-canvas');
    canvas.width = COLS * TILE;
    canvas.height = ROWS * TILE + 26;
    ctx = canvas.getContext('2d');
    parseMap();
    running = true;
    document.addEventListener('keydown', onKey);
    if (raf) cancelAnimationFrame(raf);
    last = 0;
    raf = requestAnimationFrame(loop);
    draw();
    // 居中浮窗
    if (!float.dataset.placed) {
      float.style.left = Math.max(20, (window.innerWidth - float.offsetWidth) / 2) + 'px';
      float.style.top = '70px';
      float.dataset.placed = '1';
    }
  };
  window.closePacman = function () {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    document.getElementById('pac-float').classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  };
})();
