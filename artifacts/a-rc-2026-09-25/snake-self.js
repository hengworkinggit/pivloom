(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector("canvas"); const g = c.getContext("2d");
  const W = c.width, H = c.height, C = 17.45, GRID = Math.round(W / C);
  const cells = () => {
    const d = g.getImageData(0, 0, W, H).data; const green = new Set(); let food = null; let fx = 0, fy = 0, fn = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 34) < 50 && Math.abs(gg - 197) < 60 && Math.abs(b - 94) < 50) green.add(Math.round(x / C) + ":" + Math.round(y / C));
      else if (Math.abs(r - 239) < 45 && Math.abs(gg - 68) < 45 && Math.abs(b - 68) < 45) { fx += x; fy += y; fn++; }
    }
    if (fn) food = { x: fx / fn / C, y: fy / fn / C };
    return { green: [...green].map((k) => k.split(":").map(Number)), length: green.size, food };
  };
  const key = (n) => window.dispatchEvent(new KeyboardEvent("keydown", { key: n, bubbles: true }));
  const space = () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true })); };
  const score = () => Number((document.body.innerText.match(/当前分数\s*(\d+)/) ?? [])[1] ?? 0);
  const overlay = () => { const o = document.querySelector(".overlay"); return o && getComputedStyle(o).display !== "none" ? o.textContent.trim().slice(0, 30) : null; };
  const start = () => { const o = document.querySelector(".overlay"); const b = o && Array.from(o.querySelectorAll("button")).find((x) => /重新开始|开始/.test(x.textContent.trim())); if (b) b.click(); };

  if (overlay()) { start(); await sleep(150); }
  const before = cells();
  const out = { lengthBeforeEat: before.length, scoreBefore: score() };

  // Eat one food so the snake grows, using the heading-aware steering that worked.
  let last = "ArrowRight";
  for (let i = 0; i < 40 && score() < 10; i++) {
    const s = cells(); if (!s.food || !s.green.length) { await sleep(100); continue; }
    const pick = (dir) => dir === "ArrowRight" ? [Math.max(...s.green.map((v) => v[0])), 0] : dir === "ArrowLeft" ? [Math.min(...s.green.map((v) => v[0])), 0] : dir === "ArrowUp" ? [0, Math.min(...s.green.map((v) => v[1]))] : [0, Math.max(...s.green.map((v) => v[1]))];
    let [hx, hy] = pick(last);
    if (last === "ArrowRight" || last === "ArrowLeft") hy = s.green.find((v) => v[0] === hx)[1];
    else hx = s.green.find((v) => v[1] === hy)[0];
    const dx = s.food.x - hx, dy = s.food.y - hy;
    let dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : (dy > 0 ? "ArrowDown" : "ArrowUp");
    const opp = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowUp: "ArrowDown", ArrowDown: "ArrowUp" }[last];
    if (dir === opp) dir = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? "ArrowDown" : "ArrowUp") : (dx > 0 ? "ArrowRight" : "ArrowLeft");
    if (dir === opp) { await sleep(120); continue; }
    if (dir === "ArrowLeft" && hx <= 1) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowRight" && hx >= GRID - 2) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowUp" && hy <= 1) dir = "ArrowRight";
    if (dir === "ArrowDown" && hy >= GRID - 2) dir = "ArrowLeft";
    if (dir === opp) { await sleep(120); continue; }
    key(dir); last = dir; await sleep(130);
  }
  const after = cells();
  out.afterEat = { length: after.length, score: score(), grew: after.length > before.length, overlay: overlay() };

  // A tight three-step loop must run the head into the body once the snake is longer than three cells.
  key("ArrowDown"); await sleep(150); key("ArrowLeft"); await sleep(150); key("ArrowUp"); await sleep(400);
  out.selfCollision = { overlay: overlay(), score: score(), high: Number((document.body.innerText.match(/最高分\s*(\d+)/) ?? [])[1] ?? -1) };
  return JSON.stringify(out);
})()
