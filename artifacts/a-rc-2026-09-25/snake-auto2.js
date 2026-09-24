(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector("canvas"); const g = c.getContext("2d");
  const W = c.width, H = c.height, C = 17.45, GRID = Math.round(W / C);
  const sample = () => {
    const d = g.getImageData(0, 0, W, H).data; const cells = new Map();
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
      const key = Math.round(x / C) + ":" + Math.round(y / C);
      if (Math.abs(r - 34) < 50 && Math.abs(gg - 197) < 60 && Math.abs(b - 94) < 50) cells.set(key, "green");
      else if (Math.abs(r - 239) < 45 && Math.abs(gg - 68) < 45 && Math.abs(b - 68) < 45) cells.set(key, "red");
    }
    return cells;
  };
  const key = (n) => window.dispatchEvent(new KeyboardEvent("keydown", { key: n, bubbles: true }));
  const score = () => Number((document.body.innerText.match(/当前分数\s*(\d+)/) ?? [])[1] ?? 0);
  const over = () => { const o = document.querySelector(".overlay"); return !!o && getComputedStyle(o).display !== "none"; };
  const startBtn = () => { const o = document.querySelector(".overlay"); return o && Array.from(o.querySelectorAll("button")).find((x) => /重新开始|开始/.test(x.textContent.trim())); };

  const results = [];
  for (let attempt = 1; attempt <= 3 && score() < 10; attempt++) {
    if (over()) { const b = startBtn(); if (b) b.click(); await sleep(120); }
    let last = "ArrowRight";   // the snake starts heading right; a reversal is ignored by the game
    let steps = 0;
    while (steps++ < 60 && !over() && score() < 10) {
      const cells = sample();
      const green = [...cells].filter(([, v]) => v === "green").map(([k]) => k.split(":").map(Number));
      const red = [...cells].filter(([, v]) => v === "red").map(([k]) => k.split(":").map(Number));
      if (!green.length || !red.length) { await sleep(100); continue; }
      const fx = red.reduce((a, v) => a + v[0], 0) / red.length, fy = red.reduce((a, v) => a + v[1], 0) / red.length;
      // Head = the extreme green cell along the direction of travel, inside the body's row/column.
      let hx, hy;
      if (last === "ArrowRight") { const m = Math.max(...green.map((v) => v[0])); const row = green.filter((v) => v[0] === m); hx = m; hy = row[0][1]; }
      else if (last === "ArrowLeft") { const m = Math.min(...green.map((v) => v[0])); const row = green.filter((v) => v[0] === m); hx = m; hy = row[0][1]; }
      else if (last === "ArrowUp") { const m = Math.min(...green.map((v) => v[1])); const col = green.filter((v) => v[1] === m); hy = m; hx = col[0][0]; }
      else { const m = Math.max(...green.map((v) => v[1])); const col = green.filter((v) => v[1] === m); hy = m; hx = col[0][0]; }
      const dx = fx - hx, dy = fy - hy;
      let dir;
      if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? "ArrowRight" : "ArrowLeft";
      else dir = dy > 0 ? "ArrowDown" : "ArrowUp";
      const opposite = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowUp: "ArrowDown", ArrowDown: "ArrowUp" }[last];
      if (dir === opposite) dir = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? "ArrowDown" : "ArrowUp") : (dx > 0 ? "ArrowRight" : "ArrowLeft");
      if (dir === opposite) { await sleep(120); continue; }
      // Never steer into a wall the head is already touching.
      if (dir === "ArrowLeft" && hx <= 1) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
      if (dir === "ArrowRight" && hx >= GRID - 2) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
      if (dir === "ArrowUp" && hy <= 1) dir = "ArrowRight";
      if (dir === "ArrowDown" && hy >= GRID - 2) dir = "ArrowLeft";
      if (dir === opposite) { await sleep(120); continue; }
      key(dir); last = dir;
      await sleep(130);
    }
    results.push({ attempt, score: score(), over: over(), steps });
    if (over() && score() < 10) await sleep(100);
  }
  return JSON.stringify({ score: score(), high: Number((document.body.innerText.match(/最高分\s*(\d+)/) ?? [])[1] ?? -1), over: over(), results });
})()
