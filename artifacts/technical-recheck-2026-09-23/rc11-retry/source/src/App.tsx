import { useEffect, useRef, useState } from 'react';

type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
type GameStatus = 'idle' | 'playing' | 'paused' | 'gameOver';
type Point = { x: number; y: number };

const CANVAS_SIZE = 400;
const GRID_COUNT = 20;
const CELL_SIZE = CANVAS_SIZE / GRID_COUNT;
const MOVE_INTERVAL = 150;
const HIGH_SCORE_KEY = 'snake-high-score';

function getInitialSnake(): Point[] {
  const start = Math.floor(GRID_COUNT / 2);
  return [
    { x: start, y: start },
    { x: start - 1, y: start },
    { x: start - 2, y: start },
  ];
}

function generateFood(snake: Point[]): Point {
  let food: Point;
  do {
    food = {
      x: Math.floor(Math.random() * GRID_COUNT),
      y: Math.floor(Math.random() * GRID_COUNT),
    };
  } while (snake.some((s) => s.x === food.x && s.y === food.y));
  return food;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<GameStatus>('idle');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const saved = window.localStorage.getItem(HIGH_SCORE_KEY);
    const parsed = saved ? parseInt(saved, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  });

  const snakeRef = useRef<Point[]>(getInitialSnake());
  const directionRef = useRef<Direction>('RIGHT');
  const nextDirectionRef = useRef<Direction>('RIGHT');
  const foodRef = useRef<Point>(generateFood(snakeRef.current));
  const lastMoveTimeRef = useRef(0);
  const statusRef = useRef<GameStatus>(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (score > highScore) {
      setHighScore(score);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(HIGH_SCORE_KEY, String(score));
      }
    }
  }, [score, highScore]);

  const resetGame = () => {
    const initialSnake = getInitialSnake();
    snakeRef.current = initialSnake;
    directionRef.current = 'RIGHT';
    nextDirectionRef.current = 'RIGHT';
    foodRef.current = generateFood(initialSnake);
    setScore(0);
    lastMoveTimeRef.current = 0;
  };

  const startGame = () => {
    resetGame();
    setStatus('playing');
  };

  const restartGame = () => {
    resetGame();
    setStatus('playing');
  };

  const togglePause = () => {
    setStatus((prev) => (prev === 'playing' ? 'paused' : prev === 'paused' ? 'playing' : prev));
  };

  const gameOver = () => {
    setStatus('gameOver');
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // background
    ctx.fillStyle = '#e8eaf6';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // grid
    ctx.strokeStyle = '#c5cae9';
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID_COUNT; i++) {
      ctx.beginPath();
      ctx.moveTo(i * CELL_SIZE, 0);
      ctx.lineTo(i * CELL_SIZE, CANVAS_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * CELL_SIZE);
      ctx.lineTo(CANVAS_SIZE, i * CELL_SIZE);
      ctx.stroke();
    }

    if (statusRef.current === 'idle') return;

    // food
    const food = foodRef.current;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(
      food.x * CELL_SIZE + CELL_SIZE / 2,
      food.y * CELL_SIZE + CELL_SIZE / 2,
      CELL_SIZE / 2 - 2,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // snake
    const snake = snakeRef.current;
    snake.forEach((seg, index) => {
      ctx.fillStyle = index === 0 ? '#16a34a' : '#22c55e';
      ctx.fillRect(seg.x * CELL_SIZE + 1, seg.y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      if (index === 0) {
        ctx.strokeStyle = '#14532d';
        ctx.lineWidth = 2;
        ctx.strokeRect(seg.x * CELL_SIZE + 1, seg.y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      }
    });
  };

  const moveSnake = () => {
    const snake = snakeRef.current;
    directionRef.current = nextDirectionRef.current;
    const head = snake[0];
    let newHead: Point;
    switch (directionRef.current) {
      case 'UP':
        newHead = { x: head.x, y: head.y - 1 };
        break;
      case 'DOWN':
        newHead = { x: head.x, y: head.y + 1 };
        break;
      case 'LEFT':
        newHead = { x: head.x - 1, y: head.y };
        break;
      case 'RIGHT':
        newHead = { x: head.x + 1, y: head.y };
        break;
    }

    // wall collision
    if (
      newHead.x < 0 ||
      newHead.x >= GRID_COUNT ||
      newHead.y < 0 ||
      newHead.y >= GRID_COUNT
    ) {
      gameOver();
      return;
    }

    // self collision
    if (snake.some((seg) => seg.x === newHead.x && seg.y === newHead.y)) {
      gameOver();
      return;
    }

    const newSnake = [newHead, ...snake];
    const food = foodRef.current;
    if (newHead.x === food.x && newHead.y === food.y) {
      setScore((s) => s + 10);
      foodRef.current = generateFood(newSnake);
    } else {
      newSnake.pop();
    }
    snakeRef.current = newSnake;
  };

  useEffect(() => {
    let rafId: number;
    const loop = (timestamp: number) => {
      draw();
      if (statusRef.current === 'playing') {
        if (timestamp - lastMoveTimeRef.current >= MOVE_INTERVAL) {
          moveSnake();
          lastMoveTimeRef.current = timestamp;
        }
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }

      if (e.key === ' ') {
        if (statusRef.current === 'playing' || statusRef.current === 'paused') {
          togglePause();
        } else if (statusRef.current === 'idle' || statusRef.current === 'gameOver') {
          if (statusRef.current === 'gameOver') {
            restartGame();
          } else {
            startGame();
          }
        }
        return;
      }

      if (statusRef.current !== 'playing') return;

      const current = directionRef.current;
      switch (e.key) {
        case 'ArrowUp':
          if (current !== 'DOWN') nextDirectionRef.current = 'UP';
          break;
        case 'ArrowDown':
          if (current !== 'UP') nextDirectionRef.current = 'DOWN';
          break;
        case 'ArrowLeft':
          if (current !== 'RIGHT') nextDirectionRef.current = 'LEFT';
          break;
        case 'ArrowRight':
          if (current !== 'LEFT') nextDirectionRef.current = 'RIGHT';
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const statusText = {
    idle: '准备开始',
    playing: '游戏进行中',
    paused: '已暂停',
    gameOver: '游戏结束',
  }[status];

  return (
    <main>
      <h1>贪吃蛇</h1>
      <section className="info-panel">
        <div className="score-board">
          <div>
            <span className="label">当前分数</span>
            <span className="value">{score}</span>
          </div>
          <div>
            <span className="label">最高分</span>
            <span className="value">{highScore}</span>
          </div>
        </div>
        <div className="status">状态：{statusText}</div>
      </section>

      <div className="canvas-wrapper">
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          aria-label="贪吃蛇游戏画布"
        />
        {status === 'gameOver' && (
          <div className="overlay">
            <div className="overlay-content">
              <h2>游戏结束</h2>
              <p>最终得分：{score}</p>
              <button onClick={restartGame}>重新开始</button>
            </div>
          </div>
        )}
        {status === 'paused' && (
          <div className="overlay">
            <div className="overlay-content">
              <h2>已暂停</h2>
              <p>按空格键继续</p>
            </div>
          </div>
        )}
      </div>

      <div className="controls">
        {status === 'idle' && <button onClick={startGame}>开始游戏</button>}
        {status === 'playing' && <button onClick={togglePause}>暂停</button>}
        {status === 'paused' && <button onClick={togglePause}>继续</button>}
        {status === 'gameOver' && <button onClick={restartGame}>重新开始</button>}
      </div>

      <section className="instructions">
        <h2>操作说明</h2>
        <ul>
          <li>使用键盘方向键 ↑ ↓ ← → 控制蛇的移动方向</li>
          <li>按空格键可以暂停或继续游戏</li>
          <li>吃到红色食物，蛇会变长并且分数增加</li>
          <li>撞到墙壁或自己的身体，游戏结束</li>
          <li>游戏结束后点击“重新开始”按钮即可再来一局</li>
        </ul>
      </section>
    </main>
  );
}
