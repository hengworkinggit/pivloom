import { useEffect, useRef, useState } from 'react';

type Point = { x: number; y: number };

const GRID = 20;
const CELL = 22;
const CANVAS_SIZE = GRID * CELL;
const TICK = 130;
const FOOD_SCORE = 10;
const STORAGE_KEY = 'snake-high-score';

const DIRS: Record<string, Point> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

function randomFood(snake: Point[]): Point {
  let p: Point;
  do {
    p = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
  } while (snake.some((s) => s.x === p.x && s.y === p.y));
  return p;
}

function draw(ctx: CanvasRenderingContext2D, snake: Point[], food: Point) {
  ctx.fillStyle = '#e8eaf0';
  ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL, 0);
    ctx.lineTo(i * CELL, CANVAS_SIZE);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL);
    ctx.lineTo(CANVAS_SIZE, i * CELL);
    ctx.stroke();
  }

  const cx = food.x * CELL + CELL / 2;
  const cy = food.y * CELL + CELL / 2;
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.arc(cx, cy, CELL * 0.35, 0, Math.PI * 2);
  ctx.fill();

  snake.forEach((seg, i) => {
    ctx.fillStyle = i === 0 ? '#16a34a' : '#22c55e';
    ctx.fillRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2);
    if (i === 0) {
      ctx.strokeStyle = '#14532d';
      ctx.strokeRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2);
    }
  });
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<'idle' | 'running' | 'paused' | 'over'>('idle');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);

  const snakeRef = useRef<Point[]>([]);
  const dirRef = useRef<Point>(DIRS.ArrowRight);
  const nextDirRef = useRef<Point>(DIRS.ArrowRight);
  const foodRef = useRef<Point>({ x: 12, y: 10 });
  const scoreRef = useRef(0);
  const highScoreRef = useRef(0);

  const drawCanvas = () => {
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) draw(ctx, snakeRef.current, foodRef.current);
  };

  const resetGame = (start = false) => {
    const s = [
      { x: 5, y: 10 },
      { x: 4, y: 10 },
      { x: 3, y: 10 },
    ];
    snakeRef.current = s;
    dirRef.current = DIRS.ArrowRight;
    nextDirRef.current = DIRS.ArrowRight;
    foodRef.current = randomFood(s);
    scoreRef.current = 0;
    setScore(0);
    setGameState(start ? 'running' : 'idle');
    requestAnimationFrame(drawCanvas);
  };

  const gameOver = () => {
    setGameState('over');
    try {
      if (scoreRef.current > highScoreRef.current) {
        highScoreRef.current = scoreRef.current;
        setHighScore(scoreRef.current);
        localStorage.setItem(STORAGE_KEY, String(scoreRef.current));
      }
    } catch {}
  };

  const updateGame = () => {
    const current = dirRef.current;
    const next = nextDirRef.current;
    if (!(next.x === -current.x && next.y === -current.y)) {
      dirRef.current = next;
    }

    const head = snakeRef.current[0];
    const newHead = { x: head.x + dirRef.current.x, y: head.y + dirRef.current.y };

    if (newHead.x < 0 || newHead.x >= GRID || newHead.y < 0 || newHead.y >= GRID) {
      gameOver();
      return;
    }
    const ate = newHead.x === foodRef.current.x && newHead.y === foodRef.current.y;
    const bodyToCheck = ate ? snakeRef.current : snakeRef.current.slice(0, -1);
    if (bodyToCheck.some((seg) => seg.x === newHead.x && seg.y === newHead.y)) {
      gameOver();
      return;
    }

    const newSnake = [newHead, ...snakeRef.current];
    if (ate) {
      scoreRef.current += FOOD_SCORE;
      setScore(scoreRef.current);
      if (scoreRef.current > highScoreRef.current) {
        highScoreRef.current = scoreRef.current;
        setHighScore(scoreRef.current);
        try {
          localStorage.setItem(STORAGE_KEY, String(scoreRef.current));
        } catch {}
      }
      foodRef.current = randomFood(newSnake);
    } else {
      newSnake.pop();
    }
    snakeRef.current = newSnake;
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const val = saved ? parseInt(saved, 10) : 0;
      highScoreRef.current = Number.isFinite(val) ? val : 0;
      setHighScore(highScoreRef.current);
    } catch {}
    resetGame(false);
  }, []);

  useEffect(() => {
    if (gameState !== 'running') return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const step = (now: number) => {
      const dt = now - last;
      last = now;
      acc += dt;
      if (acc >= TICK) {
        acc = 0;
        updateGame();
      }
      drawCanvas();
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [gameState]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = e.key;
      if (key === ' ') {
        e.preventDefault();
        setGameState((prev) => {
          if (prev === 'running') return 'paused';
          if (prev === 'paused') return 'running';
          return prev;
        });
        return;
      }
      if (DIRS[key]) {
        e.preventDefault();
        const d = DIRS[key];
        const current = dirRef.current;
        if (!(d.x === -current.x && d.y === -current.y)) {
          nextDirRef.current = d;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <main className="snake-app">
      <h1>贪吃蛇</h1>
      <div className="scores">
        <span>当前分数：<b>{score}</b></span>
        <span>最高分：<b>{highScore}</b></span>
      </div>
      <div className="board-wrap">
        <canvas ref={canvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} />
        {gameState === 'idle' && (
          <div className="overlay">
            <p>点击“开始游戏”开始</p>
          </div>
        )}
        {gameState === 'paused' && (
          <div className="overlay">
            <p>已暂停，按空格继续</p>
          </div>
        )}
        {gameState === 'over' && (
          <div className="overlay">
            <p>游戏结束</p>
            <p>最终得分：{score}</p>
            <button onClick={() => resetGame(true)}>重新开始</button>
          </div>
        )}
      </div>
      <div className="controls">
        {gameState === 'idle' || gameState === 'over' ? (
          <button onClick={() => resetGame(true)}>
            {gameState === 'idle' ? '开始游戏' : '重新开始'}
          </button>
        ) : (
          <button onClick={() => setGameState((prev) => (prev === 'paused' ? 'running' : 'paused'))}>
            {gameState === 'paused' ? '继续游戏' : '暂停游戏'}
          </button>
        )}
      </div>
      <section className="instructions">
        <h3>操作说明</h3>
        <p>使用方向键 ↑ ↓ ← → 控制蛇的移动方向</p>
        <p>按空格键暂停或继续游戏</p>
        <p>吃到红色食物可增长蛇身并加分</p>
        <p>撞墙或撞到自己的身体则游戏结束</p>
      </section>
    </main>
  );
}
