(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector("canvas");
  const g = c.getContext("2d");
  const W = c.width, H = c.height, d = g.getImageData(0, 0, W, H).data;
  const cells = (pred) => {
    const set = new Set();
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (pred(d[i], d[i + 1], d[i + 2])) set.add(Math.round(x / 9) + ":" + Math.round(y / 9));
    }
    return set;
  };
  const green = (r, gg, b) => Math.abs(r - 34) < 45 && Math.abs(gg - 197) < 55 && Math.abs(b - 94) < 45;
  const red = (r, gg, b) => Math.abs(r - 239) < 45 && Math.abs(gg - 68) < 45 && Math.abs(b - 68) < 45;
  const centroid = (set) => {
    let sx = 0, sy = 0, n = 0;
    for (const k of set) { const [x, y] = k.split(":").map(Number); sx += x; sy += y; n++; }
    return n ? { x: sx / n, y: sy / n, n } : null;
  };
  const key = (name) => window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  const score = () => Number((document.body.innerText.match(/当前分数\s*(\d+)/) ?? [])[1] ?? 0);
  const over = () => { const o = document.querySelector(".overlay"); return !!o && getComputedStyle(o).display !== "none"; };
  const log = [];
  // The snake keeps moving until it hits a wall, so the game must be started in
  // the same tick as the loop: restart first, then steer.
  const overlay = document.querySelector(".overlay");
  const start = overlay ? Array.from(overlay.querySelectorAll("button")).find((b) => /重新开始|开始/.test(b.textContent.trim())) : null;
  if (start) start.click();
  await sleep(120);
  let last = "";
  for (let step = 0; step < 90; step++) {
    if (over()) break;
    if (score() >= 10) break;
    const s = centroid(cells(green)), f = centroid(cells(red));
    if (!s || !f) { await sleep(120); continue; }
    const half = Math.max(1, Math.floor(s.n)); // sampling density, used only for edge guard
    let dx = f.x - s.x, dy = f.y - s.y;
    let dir;
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? "ArrowRight" : "ArrowLeft";
    else dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    const opposite = { ArrowRight: "ArrowLeft", ArrowLeft: "ArrowRight", ArrowUp: "ArrowDown", ArrowDown: "ArrowUp" }[last];
    if (dir === opposite) dir = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? "ArrowDown" : "ArrowUp") : (dx > 0 ? "ArrowRight" : "ArrowLeft");
    // Edge guard: never steer into the wall we are already pressed against.
    if (dir === "ArrowLeft" && s.x < 3) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowRight" && s.x > W / 9 - 4) dir = dy > 0 ? "ArrowDown" : "ArrowUp";
    if (dir === "ArrowUp" && s.y < 3) dir = dx > 0 ? "ArrowRight" : "ArrowLeft";
    if (dir === "ArrowDown" && s.y > H / 9 - 4) dir = dx > 0 ? "ArrowRight" : "ArrowLeft";
    if (dir === opposite) { await sleep(120); continue; }
    key(dir); last = dir;
    log.push(dir.replace("Arrow", "") + "@" + score());
    await sleep(150);
  }
  return JSON.stringify({ score: score(), high: Number((document.body.innerText.match(/最高分\s*(\d+)/) ?? [])[1] ?? -1), over: over(), steps: log.length, tail: log.slice(-8) });
})()
