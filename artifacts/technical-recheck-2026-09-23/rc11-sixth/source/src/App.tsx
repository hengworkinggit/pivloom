import { useEffect, useRef, useState } from 'react';

type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
type GameStatus = 'notStarted' | 'running' | 'paused' | 'gameOver';
type Pos = { x: number; y: number };

const COLS = 20;
const ROWS = 20;
const CELL_SIZE = 24;
const CANVAS_WIDTH = COLS * CELL_SIZE;
const CANVAS_HEIGHT = ROWS * CELL_SIZE;
const TICK_MS = 150;
const HIGH_SCORE_KEY = 'snake_high_score';

const INITIAL_SNAKE: Pos[] = [
  { x: 5, y: 10 },
  { x: 4, y: 10 },
  { x: 3, y: 10 },
];
const INITIAL_DIRECTION: Direction = 'RIGHT';

function equalPos(a: Pos, b: Pos) {
  return a.x === b.x && a.y === b.y;
}

function randomFood(snake: Pos[]): Pos {
  const occupied = new Set(snake.map((p) => `${p.x},${p.y}`));
  const free: Pos[] = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (!occupied.has(`${x},${y}`)) {
        free.push({ x, y });
      }
    }
  }
  if (free.length === 0) return { x: -1, y: -1 };
  return free[Math.floor(Math.random() * free.length)];
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [status, setStatus] = useState<GameStatus>('notStarted');
  const statusRef = useRef<GameStatus>('notStarted');

  const [snake, setSnake] = useState<Pos[]>(INITIAL_SNAKE);
  const snakeRef = useRef<Pos[]>(INITIAL_SNAKE);

  const [direction, setDirection] = useState<Direction>(INITIAL_DIRECTION);
  const directionRef = useRef<Direction>(INITIAL_DIRECTION);
  const nextDirectionRef = useRef<Direction>(INITIAL_DIRECTION);

  const [food, setFood] = useState<Pos>(() => randomFood(INITIAL_SNAKE));
  const foodRef = useRef<Pos>(food);

  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);

  const [highScore, setHighScore] = useState(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(HIGH_SCORE_KEY) : null;
    return saved ? Number(saved) : 0;
  });

  const syncStatus = (value: GameStatus) => {
    statusRef.current = value;
    setStatus(value);
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL_SIZE, 0);
      ctx.lineTo(x * CELL_SIZE, CANVAS_HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL_SIZE);
      ctx.lineTo(CANVAS_WIDTH, y * CELL_SIZE);
      ctx.stroke();
    }

    const currentFood = foodRef.current;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(
      currentFood.x * CELL_SIZE + CELL_SIZE / 2,
      currentFood.y * CELL_SIZE + CELL_SIZE / 2,
      CELL_SIZE / 2 - 3,
      0,
      Math.PI * 2
    );
    ctx.fill();

    const currentSnake = snakeRef.current;
    currentSnake.forEach((segment, index) => {
      if (index === 0) {
        ctx.fillStyle = '#22c55e';
      } else {
        const ratio = index / (currentSnake.length - 1 || 1);
        const g = Math.round(34 + (74 - 34) * (1 - ratio));
        ctx.fillStyle = `rgb(34, ${g + 128}, 94)`;
      }
      const pad = 2;
      ctx.fillRect(
        segment.x * CELL_SIZE + pad,
        segment.y * CELL_SIZE + pad,
        CELL_SIZE - pad * 2,
        CELL_SIZE - pad * 2
      );
    });
  };

  useEffect(() => {
    draw();
  }, [snake, food]);

  useEffect(() => {
    if (statusRef.current !== 'running') return;

    let lastTime = performance.now();
    let accumulator = 0;
    let animationId: number;

    const step = () => {
      if (statusRef.current !== 'running') return;

      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;
      accumulator += delta;

      while (accumulator >= TICK_MS) {
        accumulator -= TICK_MS;

        const currentDir = directionRef.current;
        let nextDir = nextDirectionRef.current;
        if (
          (currentDir === 'UP' && nextDir === 'DOWN') ||
          (currentDir === 'DOWN' && nextDir === 'UP') ||
          (currentDir === 'LEFT' && nextDir === 'RIGHT') ||
          (currentDir === 'RIGHT' && nextDir === 'LEFT')
        ) {
          nextDir = currentDir;
        }
        directionRef.current = nextDir;
        setDirection(nextDir);

        const currentSnake = snakeRef.current;
        const head = currentSnake[0];
        const nextHead: Pos = { ...head };
        if (nextDir === 'UP') nextHead.y -= 1;
        if (nextDir === 'DOWN') nextHead.y += 1;
        if (nextDir === 'LEFT') nextHead.x -= 1;
        if (nextDir === 'RIGHT') nextHead.x += 1;

        if (
          nextHead.x < 0 ||
          nextHead.x >= COLS ||
          nextHead.y < 0 ||
          nextHead.y >= ROWS ||
          currentSnake.some((seg) => equalPos(seg, nextHead))
        ) {
          syncStatus('gameOver');
          const finalScore = scoreRef.current;
          setHighScore((prev) => {
            const updated = Math.max(prev, finalScore);
            localStorage.setItem(HIGH_SCORE_KEY, String(updated));
            return updated;
          });
          return;
        }

        const ate = equalPos(nextHead, foodRef.current);
        const newSnake = [nextHead, ...currentSnake];
        if (!ate) {
          newSnake.pop();
        } else {
          const newScore = scoreRef.current + 1;
          scoreRef.current = newScore;
          setScore(newScore);
          const newFood = randomFood(newSnake);
          foodRef.current = newFood;
          setFood(newFood);
        }
        snakeRef.current = newSnake;
        setSnake(newSnake);
      }

      animationId = requestAnimationFrame(step);
    };

    animationId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(animationId);
  }, [status]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault();
        if (statusRef.current === 'running') {
          syncStatus('paused');
        } else if (statusRef.current === 'paused') {
          syncStatus('running');
        }
        return;
      }

      if (statusRef.current !== 'running') return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          nextDirectionRef.current = 'UP';
          break;
        case 'ArrowDown':
          e.preventDefault();
          nextDirectionRef.current = 'DOWN';
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nextDirectionRef.current = 'LEFT';
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextDirectionRef.current = 'RIGHT';
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const startGame = () => {
    if (statusRef.current === 'running') return;
    syncStatus('running');
  };

  const resetGame = () => {
    const initial = INITIAL_SNAKE;
    snakeRef.current = initial;
    setSnake(initial);
    directionRef.current = INITIAL_DIRECTION;
    nextDirectionRef.current = INITIAL_DIRECTION;
    setDirection(INITIAL_DIRECTION);
    const initialFood = randomFood(initial);
    foodRef.current = initialFood;
    setFood(initialFood);
    scoreRef.current = 0;
    setScore(0);
    syncStatus('notStarted');
  };

  return (
    <main>
      <h1>贪吃蛇</h1>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={{
              display: 'block',
              border: '4px solid #334155',
              borderRadius: 8,
              background: '#1e293b',
            }}
          />
        </div>
        <div style={{ minWidth: 200 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 18, marginBottom: 8 }}>
              当前分数：<strong>{score}</strong>
            </div>
            <div style={{ fontSize: 18, marginBottom: 8 }}>
              最高分：<strong>{highScore}</strong>
            </div>
            <div style={{ fontSize: 14, color: '#64748b' }}>
              状态：
              {status === 'notStarted' && '未开始'}
              {status === 'running' && '进行中'}
              {status === 'paused' && '已暂停'}
              {status === 'gameOver' && '游戏结束'}
            </div>
          </div>

          {status === 'notStarted' && <button onClick={startGame}>开始游戏</button>}
          {status === 'gameOver' && <button onClick={resetGame}>重新开始</button>}

          <div style={{ marginTop: 24, fontSize: 14, lineHeight: 1.8, color: '#334155' }}>
            <h3 style={{ margin: '0 0 8px' }}>操作说明</h3>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              <li>方向键 ↑↓←→ 控制蛇移动</li>
              <li>不能立即反向穿过自己</li>
              <li>空格键 暂停 / 继续</li>
              <li>吃食物得分并变长</li>
              <li>碰墙或撞到自己游戏结束</li>
              <li>点击“开始游戏”启动</li>
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}
