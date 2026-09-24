(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector("canvas"); const g = c.getContext("2d");
  const W = c.width, H = c.height, C = 17.45, GRID = Math.round(W / C);
  const read = () => {
    const d = g.getImageData(0, 0, W, H).data; const green = new Set(); let fx = 0, fy = 0, fn = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 34) < 50 && Math.abs(gg - 197) < 60 && Math.abs(b - 94) < 50) green.add(Math.round(x / C) + ":" + Math.round(y / C));
      else if (Math.abs(r - 239) < 45 && Math.abs(gg - 68) < 45 && Math.abs(b - 68) < 45) { fx += x; fy += y; fn++; }
    }
    const cells = [...green].map((k) => k.split(":").map(Number));
    return { cells, xs: cells.map((v) => v[0]), ys: cells.map((v) => v[1]), food: fn ? { x: fx / fn / C, y: fy / fn / C } : null };
  };
  const key = (n) => window.dispatchEvent(new KeyboardEvent("keydown", { key: n, bubbles: true }));
  const overlay = () => { const o = document.querySelector(".overlay"); return o && getComputedStyle(o).display !== "none" ? o.textContent.trim().slice(0, 34) : null; };
  const startBtn = () => { const o = document.querySelector(".overlay"); return o && Array.from(o.querySelectorAll("button")).find((x) => /重新开始|开始/.test(x.textContent.trim())); };
  const score = () => Number((document.body.innerText.match(/当前分数\s*(\d+)/) ?? [])[1] ?? -1);
  const out = {};

  if (overlay()) { startBtn()?.click(); await sleep(160); }

  // Eat exactly one food using the heading-aware steering.
  let last = "ArrowRight";
  for (let i = 0; i < 40 && score() < 10; i++) {
    const s = read(); if (!s.food || !s.cells.length) { await sleep(100); continue; }
    let hx, hy;
    if (last === "ArrowRight") { hx = Math.max(...s.xs); hy = s.cells.find((v) => v[0] === hx)[1]; }
    else if (last === "ArrowLeft") { hx = Math.min(...s.xs); hy = s.cells.find((v) => v[0] === hx)[1]; }
    else if (last === "ArrowUp") { hy = Math.min(...s.ys); hx = s.cells.find((v) => v[1] === hy)[0]; }
    else { hy = Math.max(...s.ys); hx = s.cells.find((v) => v[1] === hy)[0]; }
    const dx = s.food.x - hx, dy = s.food.y - hy;
    let dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
    const opp = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowUp: "ArrowDown", ArrowDown: "ArrowUp" }[last];
    if (dir === opp) dir = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? "ArrowDown" : "ArrowUp") : (dx > 0 ? "ArrowRight" : "ArrowLeft");
    if (dir === opp) { await sleep(120); continue; }
    if (dir === "ArrowLeft" && hx <= 2) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowRight" && hx >= GRID - 3) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowUp" && hy <= 2) dir = "ArrowRight";
    if (dir === "ArrowDown" && hy >= GRID - 3) dir = "ArrowLeft";
    if (dir === opp) { await sleep(120); continue; }
    key(dir); last = dir; await sleep(135);
  }
  out.afterEat = { score: score(), overlay: overlay(), cells: read().cells.length };

  // Steer to an open area first so a loop has room, then turn tightly into the body.
  for (let i = 0; i < 6; i++) { const s = read(); const midY = (Math.min(...s.ys) + Math.max(...s.ys)) / 2; if (midY > 6 && midY < GRID - 7) break; key(midY <= 6 ? "ArrowDown" : "ArrowUp"); await sleep(200); }
  out.beforeLoop = { overlay: overlay(), score: score() };
  for (const k of ["ArrowDown", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
    key(k); await sleep(240);
    if (overlay()) { out.endedOn = k; break; }
  }
  await sleep(400);
  const s = read();
  const box = { x0: Math.min(...s.xs), x1: Math.max(...s.xs), y0: Math.min(...s.ys), y1: Math.max(...s.ys) };
  out.selfCollision = { overlay: overlay(), box, touchesEdge: box.x0 <= 0 || box.x1 >= GRID - 1 || box.y0 <= 0 || box.y1 >= GRID - 1, score: score() };

  // Real button click must also steer the snake (the mobile control path).
  if (overlay()) { startBtn()?.click(); await sleep(200); }
  const beforeBtn = read();
  const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "▼");
  if (btn) btn.click();
  await sleep(420);
  const afterBtn = read();
  out.buttonClick = { movedVertically: Math.max(...afterBtn.ys) > Math.max(...beforeBtn.ys), beforeMaxY: Math.max(...beforeBtn.ys), afterMaxY: Math.max(...afterBtn.ys) };
  return JSON.stringify(out);
})()
