(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c = document.querySelector("canvas"); const g = c.getContext("2d");
  const W = c.width, H = c.height, C = 17.45;
  const box = () => {
    const d = g.getImageData(0, 0, W, H).data; let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
    for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
      const i = (y * W + x) * 4;
      if (Math.abs(d[i] - 34) < 50 && Math.abs(d[i + 1] - 197) < 60 && Math.abs(d[i + 2] - 94) < 50) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    return { minX: Math.round(minX / C), maxX: Math.round(maxX / C), minY: Math.round(minY / C), maxY: Math.round(maxY / C), w: Math.round((maxX - minX) / C) + 1, h: Math.round((maxY - minY) / C) + 1, samples: n };
  };
  const key = (n) => window.dispatchEvent(new KeyboardEvent("keydown", { key: n, bubbles: true }));
  const over = () => { const o = document.querySelector(".overlay"); return !!o && getComputedStyle(o).display !== "none"; };
  const startBtn = () => { const o = document.querySelector(".overlay"); return o && Array.from(o.querySelectorAll("button")).find((x) => /重新开始|开始/.test(x.textContent.trim())); };
  const out = {};

  // Fresh game
  if (over()) { const b = startBtn(); if (b) b.click(); await sleep(150); }
  const horizontal = box();
  out.initial = { box: horizontal, shape: horizontal.w > horizontal.h ? "horizontal" : "vertical" };

  // Direction change: Up must turn the snake, and the resulting body must be vertical.
  key("ArrowUp"); await sleep(350);
  const turned = box();
  out.afterUp = { box: turned, shape: turned.w > turned.h ? "horizontal" : "vertical" };

  // Reverse must be ignored: pressing Down while heading up must not move the head down.
  const beforeReverse = box();
  key("ArrowDown"); await sleep(320);
  const afterReverse = box();
  out.reverseBlocked = { before: beforeReverse, after: afterReverse, headKeptGoingUp: afterReverse.minY <= beforeReverse.minY };

  // Space pauses: position must stop changing, then resume on the second press.
  key(" "); const pausedA = box(); await sleep(500); const pausedB = box();
  out.paused = { a: pausedA, b: pausedB, frozen: pausedA.minY === pausedB.minY && pausedA.maxY === pausedB.maxY };
  key(" "); const resumedA = box(); await sleep(400); const resumedB = box();
  out.resumed = { a: resumedA, b: resumedB, moved: resumedA.minY !== resumedB.minY };
  out.gameOver = over();
  return JSON.stringify(out);
})()
