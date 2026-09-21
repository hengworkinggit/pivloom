import type {
  Activity,
  ChatMessage,
  Project,
  ProjectKind,
  RunPhase,
  Session,
  SourceFile,
} from "./types";

/** Local frontend demo only. No requests, generated code execution, or model calls. */
const STORAGE_KEY = "pivloom.demo.v1";
const STORAGE_VERSION = 1;
const ACTIVE_PHASES: RunPhase[] = [
  "planning",
  "building",
  "checking",
  "stopping",
];
const DEMO_SESSION: Session = { name: "Heng", email: "demo@pivloom.app" };

interface Store {
  version: typeof STORAGE_VERSION;
  session: Session | null;
  projects: Project[];
}

let memory: Store | undefined;
const listeners = new Set<() => void>();
const scheduled = new Map<string, Set<ReturnType<typeof setTimeout>>>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now() {
  return new Date().toISOString();
}

function uid(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function storage() {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    throw new Error("浏览器阻止了本地存储。请允许此网站存储数据后重试。");
  }
}

function persist(next: Store) {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    throw new Error(
      "无法保存演示数据：本地存储不可用或空间已满。请检查浏览器设置后重试。",
    );
  }
}

function notify() {
  listeners.forEach((listener) => listener());
}

function commit(next: Store) {
  // Persist before publishing: a rejected write cannot look like a successful save.
  persist(next);
  memory = next;
  notify();
}

function completedActivities(
  detail = "表单、筛选与窄屏布局已完成演示检查。",
): Activity[] {
  return [
    {
      role: "coordinator",
      status: "completed",
      detail: "已明确页面结构和本轮需求。",
    },
    {
      role: "builder",
      status: "completed",
      detail: "界面和交互已更新，预览已就绪。",
    },
    { role: "reviewer", status: "completed", detail },
  ];
}

function activitiesFor(
  phase: "planning" | "building" | "checking",
): Activity[] {
  return [
    {
      role: "coordinator",
      status: phase === "planning" ? "running" : "completed",
      detail:
        phase === "planning"
          ? "正在梳理你的需求，确定页面结构…"
          : "已整理本轮需求与实现步骤。",
    },
    {
      role: "builder",
      status:
        phase === "planning"
          ? "pending"
          : phase === "building"
            ? "running"
            : "completed",
      detail:
        phase === "planning"
          ? "等待需求交接"
          : phase === "building"
            ? "正在更新组件和交互，准备预览…"
            : "组件和样式更新完成。",
    },
    {
      role: "reviewer",
      status: phase === "checking" ? "running" : "pending",
      detail:
        phase === "checking"
          ? "正在演示表单、筛选与页面布局检查…"
          : "等待可检查的预览",
    },
  ];
}

function sources(
  kind: ProjectKind,
  revision: number,
  features: string[],
): SourceFile[] {
  // Only controlled template values are interpolated. User prompts remain data.
  const hasStats = features.includes("stats");
  const hasFilter = features.includes("status-filter");
  const app =
    kind === "events"
      ? `import { useState } from 'react';
import './styles.css';

type Registration = { id: string; name: string; email: string; category: string; confirmed: boolean };

export default function App() {
  const [people, setPeople] = useState<Registration[]>([
    { id: '1', name: '林舟', email: 'linzhou@example.test', category: '设计', confirmed: false },
    { id: '2', name: '田禾', email: 'tianhe@example.test', category: '开发', confirmed: true },
    { id: '3', name: '宋宁', email: 'songning@example.test', category: '设计', confirmed: false },
  ]);
  const [search, setSearch] = useState('');
  ${hasFilter ? "const [status, setStatus] = useState('all');" : ""}
  const visible = people.filter((person) =>
    (person.name.includes(search) || person.email.includes(search))${hasFilter ? " &&\n    (status === 'all' || person.confirmed === (status === 'confirmed'))" : ""}
  );

  function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPeople((previous) => [...previous, {
      id: crypto.randomUUID(), name: String(data.get('name')).trim(),
      email: String(data.get('email')).trim(), category: String(data.get('category')), confirmed: false,
    }]);
    form.reset();
  }

  return <main>
    <header><p>DESIGN TOGETHER · 2026</p><h1>让好奇的人，在这里相遇。</h1><p>创意者交流日 · 活动报名管理</p></header>
    ${hasStats ? '<section className="stats"><article>报名总数<strong>{people.length}</strong></article><article>已确认<strong>{people.filter((p) => p.confirmed).length}</strong></article></section>' : ""}
    <form onSubmit={register}>
      <h2>添加报名</h2>
      <label>姓名<input name="name" required placeholder="你的名字" /></label>
      <label>邮箱<input name="email" required type="email" placeholder="you@example.com" /></label>
      <label>参与方向<select name="category"><option>设计</option><option>开发</option></select></label>
      <button>添加报名</button>
    </form>
    <section>
      <h2>报名名单</h2>
      <input aria-label="搜索报名" placeholder="搜索姓名或邮箱" value={search} onChange={(e) => setSearch(e.target.value)} />
      ${hasFilter ? '<select aria-label="筛选状态" value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">全部状态</option><option value="pending">待确认</option><option value="confirmed">已确认</option></select>' : ""}
      <ul>{visible.map((person) => <li key={person.id}>
        <span>{person.name}</span><span>{person.email}</span><span>{person.category}</span>
        <button onClick={() => setPeople((all) => all.map((p) => p.id === person.id ? { ...p, confirmed: !p.confirmed } : p))}>{person.confirmed ? '已确认' : '确认报名'}</button>
      </li>)}</ul>
      {visible.length === 0 && <p>没有符合条件的报名</p>}
    </section>
  </main>;
}
`
      : kind === "books"
        ? `import { useState } from 'react';
import './styles.css';

const initialBooks = [
  { id: '1', title: '设计中的设计', author: '原研哉', category: '设计', done: false },
  { id: '2', title: '悉达多', author: '赫尔曼·黑塞', category: '文学', done: true },
  { id: '3', title: '认知觉醒', author: '周岭', category: '成长', done: false },
];

export default function App() {
  const [books, setBooks] = useState(initialBooks);
  const [search, setSearch] = useState('');
  return <main>
    <header><p>THE READING ROOM</p><h1>翻开一本书，走进另一个世界。</h1><p>把想读的故事，留在这里。</p></header>
    ${hasStats ? '<section className="stats"><article>书架藏书<strong>{books.length}</strong></article><article>已读完<strong>{books.filter((book) => book.done).length}</strong></article></section>' : ""}
    <form onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      setBooks((all) => [...all, { id: crypto.randomUUID(), title: String(data.get('title')), author: String(data.get('author')), category: '其他', done: false }]);
      event.currentTarget.reset();
    }}><input name="title" placeholder="书名" required /><input name="author" placeholder="作者" required /><button>加入书架</button></form>
    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索书名或作者" aria-label="搜索书籍" />
    <section className="books">{books.filter((book) => (book.title + book.author).includes(search)).map((book) => <article key={book.id}>
      <p>{book.category}</p><h2>{book.title}</h2><p>{book.author}</p>
      <button onClick={() => setBooks((all) => all.map((b) => b.id === book.id ? { ...b, done: !b.done } : b))}>{book.done ? '已读完' : '标记读完'}</button>
    </article>)}</section>
  </main>;
}
`
        : `import { useState } from 'react';
import './styles.css';

const projects = [
  { title: 'Quiet Objects', category: '品牌设计', year: '2026' },
  { title: 'Form & Function', category: '数字产品', year: '2025' },
  { title: 'Everyday Archive', category: '视觉探索', year: '2025' },
];

export default function App() {
  const [category, setCategory] = useState('全部');
  return <main>
    <nav><strong>Alex Chen.</strong><a href="#work">作品</a><a href="#about">关于</a><a href="mailto:hello@example.test">联系</a></nav>
    <header><p>INDEPENDENT DESIGNER · SHANGHAI</p><h1>让好的想法，<br />拥有自己的形状。</h1><p>我通过设计，连接人、想法与日常生活。</p><a href="#work">看看我的作品 ↗</a></header>
    <section id="work"><h2>精选作品</h2>
      {['全部', '品牌设计', '数字产品', '视觉探索'].map((name) => <button key={name} onClick={() => setCategory(name)} aria-pressed={category === name}>{name}</button>)}
      <div className="projects">{projects.filter((project) => category === '全部' || project.category === category).map((project) => <article key={project.title}><p>{project.category} / {project.year}</p><h3>{project.title}</h3></article>)}</div>
    </section>
    <section id="about"><h2>设计是把复杂的事，说得简单。</h2><p>我是一名独立设计师，专注于品牌与数字产品。</p><a href="mailto:hello@example.test">聊聊你的想法 ↗</a></section>
  </main>;
}
`;
  return [
    {
      path: "src/App.tsx",
      language: "tsx",
      content: `// Pivloom frontend demo · revision ${revision}\n${app}`,
    },
    {
      path: "src/styles.css",
      language: "css",
      content: `:root { font-family: Inter, "PingFang SC", sans-serif; color: #252b27; background: #f7f8f5; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 1080px; margin: auto; padding: 48px 32px; }
header { padding: 42px 0; }
h1 { max-width: 680px; font-size: clamp(32px, 5vw, 56px); font-weight: 600; letter-spacing: -0.045em; }
h2 { font-size: 20px; }
section, form { margin-top: 24px; }
form, article { padding: 24px; border: 1px solid #e1e7de; border-radius: 12px; background: white; }
label { display: grid; gap: 8px; margin-bottom: 16px; }
input, select, button { font: inherit; padding: 12px 16px; border: 1px solid #d7dfd4; border-radius: 8px; }
button { cursor: pointer; background: #3e604b; color: white; }
li { display: flex; gap: 20px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e1e7de; }
ul { padding: 0; list-style: none; }
strong { display: block; font-size: 30px; }
.stats, .books, .projects { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
nav { display: flex; gap: 24px; align-items: center; }
nav strong { margin-right: auto; font-size: 20px; }
a { color: inherit; }
${features.includes("responsive") ? "@media (max-width: 600px) { main { padding: 24px 16px; } .stats, .books, .projects { grid-template-columns: 1fr; } li { flex-wrap: wrap; } }" : ""}
`,
    },
    {
      path: "src/main.tsx",
      language: "tsx",
      content:
        "import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode><App /></React.StrictMode>\n);\n",
    },
    {
      path: "index.html",
      language: "html",
      content:
        '<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Pivloom Demo</title></head>\n<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n',
    },
    {
      path: "package.json",
      language: "json",
      content: JSON.stringify(
        {
          name: `pivloom-${kind}-demo`,
          private: true,
          version: `0.0.${revision}`,
          type: "module",
          scripts: { dev: "vite", build: "vite build" },
          dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
          devDependencies: {
            vite: "^6.0.0",
            typescript: "^5.7.0",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
          },
        },
        null,
        2,
      ),
    },
  ];
}

function seedProjects(): Project[] {
  const date = now();
  const eventFeatures = [
    "registration",
    "search",
    "status-filter",
    "stats",
    "responsive",
  ];
  const bookFeatures = [
    "book-list",
    "search",
    "reading-status",
    "stats",
    "responsive",
  ];
  const portfolioFeatures = ["projects", "about", "contact", "responsive"];
  const message = (
    role: ChatMessage["role"],
    content: string,
    revision?: number,
  ): ChatMessage => ({
    id: uid("message"),
    role,
    content,
    createdAt: date,
    ...(revision ? { revision, activities: completedActivities() } : {}),
  });
  return [
    {
      id: "event-demo",
      title: "活动报名管理",
      description: "让每一场相聚，从容开始。",
      kind: "events",
      updatedAt: date,
      revision: 3,
      status: "ready",
      features: eventFeatures,
      files: sources("events", 3, eventFeatures),
      messages: [
        message(
          "user",
          "帮我做一个活动报名管理页面，包含姓名、邮箱和参与方向，可以搜索报名并确认参加。",
        ),
        message(
          "assistant",
          "报名页面已经准备好了。可以添加报名、搜索参与者，并一键确认。",
          1,
        ),
        message("user", "增加一个状态筛选，方便查看待确认和已确认的报名。"),
        message(
          "assistant",
          "已加入状态筛选。原有的报名和搜索功能保持可用。",
          2,
        ),
        message(
          "user",
          "再加上报名总数和已确认人数统计，也照顾一下手机上的布局。",
        ),
        message(
          "assistant",
          "已加入报名统计，并调整了手机布局。你可以在右侧试试新增报名、状态筛选和确认操作。",
          3,
        ),
      ],
    },
    {
      id: "books-demo",
      title: "我的读书清单",
      description: "在书页之间，收藏新的世界。",
      kind: "books",
      updatedAt: new Date(Date.now() - 3600_000 * 4).toISOString(),
      revision: 2,
      status: "ready",
      features: bookFeatures,
      files: sources("books", 2, bookFeatures),
      messages: [
        message(
          "user",
          "做一个简洁的个人书架，可以添加书籍、搜索，并标记读完。",
        ),
        message(
          "assistant",
          "书架已经准备好了。可以添加新书、按书名和作者搜索，并标记阅读状态。",
          1,
        ),
        message("user", "再加上阅读统计。"),
        message("assistant", "已加入藏书和已读统计，阅读进度一目了然。", 2),
      ],
    },
    {
      id: "portfolio-demo",
      title: "设计师作品集",
      description: "用作品，让想法被看见。",
      kind: "portfolio",
      updatedAt: new Date(Date.now() - 3600_000 * 24).toISOString(),
      revision: 1,
      status: "ready",
      features: portfolioFeatures,
      files: sources("portfolio", 1, portfolioFeatures),
      messages: [
        message(
          "user",
          "做一个独立设计师的个人作品集，包含精选项目、关于我和联系方式，风格简洁。",
        ),
        message(
          "assistant",
          "作品集已准备就绪。项目支持分类筛选，页面也能适配手机。",
          1,
        ),
      ],
    },
  ];
}

function newStore(): Store {
  return {
    version: STORAGE_VERSION,
    session: clone(DEMO_SESSION),
    projects: seedProjects(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validActivities(value: unknown): value is Activity[] {
  return (
    Array.isArray(value) &&
    value.every(
      (activity) =>
        isRecord(activity) &&
        ["coordinator", "builder", "reviewer"].includes(
          String(activity.role),
        ) &&
        ["pending", "running", "completed", "failed"].includes(
          String(activity.status),
        ) &&
        typeof activity.detail === "string",
    )
  );
}

function validProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    ["events", "books", "portfolio"].includes(String(value.kind)) &&
    typeof value.updatedAt === "string" &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    ["ready", "running", "failed", "stopped", "expired"].includes(
      String(value.status),
    ) &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (m) =>
        isRecord(m) &&
        typeof m.id === "string" &&
        ["user", "assistant"].includes(String(m.role)) &&
        typeof m.content === "string" &&
        typeof m.createdAt === "string" &&
        (m.activities === undefined || validActivities(m.activities)),
    ) &&
    Array.isArray(value.files) &&
    value.files.every(
      (f) =>
        isRecord(f) &&
        typeof f.path === "string" &&
        typeof f.language === "string" &&
        typeof f.content === "string",
    ) &&
    Array.isArray(value.features) &&
    value.features.every((f) => typeof f === "string") &&
    (value.activeRun === undefined ||
      (isRecord(value.activeRun) &&
        typeof value.activeRun.id === "string" &&
        typeof value.activeRun.prompt === "string" &&
        typeof value.activeRun.startedAt === "string" &&
        [...ACTIVE_PHASES, "completed", "failed", "stopped"].includes(
          value.activeRun.phase as RunPhase,
        ) &&
        validActivities(value.activeRun.activities)))
  );
}

function interrupted(project: Project): Project {
  if (
    project.status !== "running" &&
    !ACTIVE_PHASES.includes(project.activeRun?.phase as RunPhase)
  )
    return project;
  const result = clone(project);
  result.status = "stopped";
  result.updatedAt = now();
  if (result.activeRun) {
    result.activeRun.phase = "stopped";
    result.activeRun.activities = result.activeRun.activities.map((activity) =>
      activity.status === "running"
        ? {
            ...activity,
            status: "pending",
            detail: "页面刷新，演示运行已中断。",
          }
        : activity,
    );
  }
  result.messages.push({
    id: uid("message"),
    role: "assistant",
    content:
      "页面刷新中断了这次演示运行。之前的版本已经保留，你可以重新发送需求。",
    createdAt: now(),
  });
  return result;
}

function state(): Store {
  if (memory) return memory;
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    throw new Error("无法读取本地演示数据。请允许此网站存储数据后重试。");
  }
  if (!raw) {
    const initial = newStore();
    persist(initial);
    memory = initial;
    return initial;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw new Error("本地演示数据无法读取。请清除此网站的演示数据后重新打开。");
  }
  if (
    !isRecord(stored) ||
    stored.version !== STORAGE_VERSION ||
    !Array.isArray(stored.projects) ||
    !stored.projects.every(validProject) ||
    !(
      stored.session === null ||
      (isRecord(stored.session) &&
        typeof stored.session.name === "string" &&
        typeof stored.session.email === "string")
    )
  ) {
    throw new Error(
      "本地演示数据版本或格式不兼容。请清除此网站的演示数据后重新打开。",
    );
  }
  const restored = stored as unknown as Store;
  restored.projects = restored.projects.map(interrupted);
  persist(restored);
  memory = restored;
  return restored;
}

function requireSession() {
  if (!state().session) throw new Error("演示会话已退出，请先登录。");
}

function findProject(id: string, store = state()) {
  const project = store.projects.find((item) => item.id === id);
  if (!project) throw new Error("没有找到这个项目。请返回项目列表重试。");
  return project;
}

function updateProject(id: string, change: (project: Project) => void) {
  const next = clone(state());
  const project = findProject(id, next);
  change(project);
  project.updatedAt = now();
  commit(next);
  return clone(project);
}

function clearScheduled(id: string) {
  scheduled.get(id)?.forEach(clearTimeout);
  scheduled.delete(id);
}

function schedule(
  id: string,
  runId: string,
  delay: number,
  change: (project: Project) => void,
  allowStopping = false,
) {
  const handles = scheduled.get(id) ?? new Set<ReturnType<typeof setTimeout>>();
  scheduled.set(id, handles);
  const handle = setTimeout(() => {
    handles.delete(handle);
    if (handles.size === 0 && scheduled.get(id) === handles)
      scheduled.delete(id);
    const project = findProject(id);
    if (
      project.activeRun?.id !== runId ||
      !ACTIVE_PHASES.includes(project.activeRun.phase) ||
      (!allowStopping && project.activeRun.phase === "stopping")
    )
      return;
    try {
      updateProject(id, change);
    } catch (error) {
      // Timer errors have no caller to reject to. Publish an explicit failed result
      // in memory, so the UI never spins forever or claims persistence succeeded.
      clearScheduled(id);
      const fallback = clone(state());
      const affected = findProject(id, fallback);
      affected.status = "failed";
      const message =
        error instanceof Error ? error.message : "演示数据保存失败。";
      if (affected.activeRun) {
        affected.activeRun.phase = "failed";
        affected.activeRun.error = `${message} 本次状态仅暂存在内存中，刷新后不会保留。`;
      }
      affected.messages.push({
        id: uid("message"),
        role: "assistant",
        content: `${message} 本次结果未保存，请排除存储问题后重试。`,
        createdAt: now(),
      });
      memory = fallback;
      notify();
    }
  }, delay);
  handles.add(handle);
}

function normalizePrompt(prompt: string) {
  const value = prompt.trim();
  if (!value) throw new Error("先写下你想创建或修改的内容。");
  if (value.length > 8_000)
    throw new Error("需求最多支持 8,000 个字符，请精简后重试。");
  return value;
}

function featuresFor(project: Project, prompt: string) {
  const features = new Set(project.features);
  const base =
    project.kind === "events"
      ? ["registration", "search"]
      : project.kind === "books"
        ? ["book-list", "search", "reading-status"]
        : ["projects", "about", "contact", "responsive"];
  base.forEach((feature) => features.add(feature));
  if (/统计|总数|计数|人数|数据卡|stats|count/i.test(prompt))
    features.add("stats");
  if (project.kind === "events" && /状态|筛选|确认|filter/i.test(prompt))
    features.add("status-filter");
  if (/手机|移动|响应式|窄屏|适配|responsive|mobile/i.test(prompt))
    features.add("responsive");
  return [...features];
}

export const demoApi = {
  async getSession(): Promise<Session | null> {
    return clone(state().session);
  },

  async login(email: string, password: string): Promise<Session> {
    if (
      email.trim().toLowerCase() !== DEMO_SESSION.email ||
      password !== "demo1234"
    )
      throw new Error("账号或密码不正确，请使用页面提供的演示账号。");
    const next = clone(state());
    next.session = clone(DEMO_SESSION);
    commit(next);
    return clone(DEMO_SESSION);
  },

  async logout(): Promise<void> {
    const next = clone(state());
    next.session = null;
    commit(next);
  },

  async listProjects(): Promise<Project[]> {
    requireSession();
    return clone(
      [...state().projects].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    );
  },

  async getProject(id: string): Promise<Project> {
    requireSession();
    return clone(findProject(id));
  },

  async createProject(prompt: string, kind?: ProjectKind): Promise<Project> {
    requireSession();
    const value = normalizePrompt(prompt);
    const selectedKind =
      kind ??
      (/书|阅读|reading|book/i.test(value)
        ? "books"
        : /作品|个人|portfolio/i.test(value)
          ? "portfolio"
          : "events");
    const project: Project = {
      id: uid("project"),
      title:
        selectedKind === "books"
          ? "我的读书清单"
          : selectedKind === "portfolio"
            ? "个人作品集"
            : "活动报名管理",
      description: value.slice(0, 100),
      kind: selectedKind,
      updatedAt: now(),
      revision: 0,
      status: "ready",
      messages: [],
      files: [],
      features: [],
    };
    const next = clone(state());
    next.projects.unshift(project);
    commit(next);
    return clone(project);
  },

  async startRun(
    id: string,
    prompt: string,
    scenario: "success" | "failure" = "success",
  ): Promise<Project> {
    requireSession();
    const value = normalizePrompt(prompt);
    const existing = findProject(id);
    if (existing.activeRun && ACTIVE_PHASES.includes(existing.activeRun.phase))
      throw new Error("这个项目正在处理上一条需求，请等待完成或先停止。");
    const runId = uid("run");
    const result = updateProject(id, (project) => {
      project.status = "running";
      project.activeRun = {
        id: runId,
        phase: "planning",
        prompt: value,
        startedAt: now(),
        activities: activitiesFor("planning"),
      };
      project.messages.push({
        id: uid("message"),
        role: "user",
        content: value,
        createdAt: now(),
      });
    });
    clearScheduled(id);
    schedule(id, runId, 1_200, (project) => {
      project.activeRun!.phase = "building";
      project.activeRun!.activities = activitiesFor("building");
    });
    schedule(id, runId, 3_600, (project) => {
      project.activeRun!.phase = "checking";
      project.activeRun!.activities = activitiesFor("checking");
    });
    schedule(id, runId, 5_200, (project) => {
      const run = project.activeRun!;
      if (scenario === "failure") {
        project.status = "failed";
        run.phase = "failed";
        run.error = "演示检查发现预览未能加载。你可以重试，上一版内容已保留。";
        run.activities = activitiesFor("checking").map((activity) =>
          activity.role === "reviewer"
            ? {
                ...activity,
                status: "failed",
                detail: "模拟检查失败：预览未能加载。",
              }
            : activity,
        );
        project.messages.push({
          id: uid("message"),
          role: "assistant",
          content:
            "这次更新没有完成。模拟检查发现预览未能加载，上一版内容已保留。可以重新尝试。",
          createdAt: now(),
          activities: clone(run.activities),
        });
      } else {
        project.status = "ready";
        project.revision += 1;
        project.features = featuresFor(project, value);
        project.files = sources(
          project.kind,
          project.revision,
          project.features,
        );
        run.phase = "completed";
        run.activities = completedActivities(
          project.kind === "events"
            ? undefined
            : project.kind === "books"
              ? "添加书籍、搜索和阅读状态已完成演示检查。"
              : "作品筛选和页面布局已完成演示检查。",
        );
        project.messages.push({
          id: uid("message"),
          role: "assistant",
          content: `第 ${project.revision} 版演示预览已准备好。${project.kind === "events" ? "可以在右侧试试添加报名、搜索和确认操作。" : project.kind === "books" ? "可以在右侧添加新书、搜索书籍并标记读完。" : "可以在右侧查看作品、切换分类和浏览关于页面。"}代码和对话已保存在当前浏览器。`,
          createdAt: now(),
          revision: project.revision,
          activities: clone(run.activities),
        });
      }
    });
    return result;
  },

  async stopRun(id: string): Promise<Project> {
    requireSession();
    const existing = findProject(id);
    if (
      !existing.activeRun ||
      !ACTIVE_PHASES.includes(existing.activeRun.phase) ||
      existing.activeRun.phase === "stopping"
    )
      return clone(existing);
    const runId = existing.activeRun.id;
    const result = updateProject(id, (project) => {
      project.activeRun!.phase = "stopping";
    });
    clearScheduled(id);
    schedule(
      id,
      runId,
      500,
      (project) => {
        project.status = "stopped";
        project.activeRun!.phase = "stopped";
        project.activeRun!.activities = project.activeRun!.activities.map(
          (activity) =>
            activity.status === "running"
              ? { ...activity, status: "pending", detail: "已停止本轮处理。" }
              : activity,
        );
        project.messages.push({
          id: uid("message"),
          role: "assistant",
          content:
            project.revision > 0
              ? "已停止本次更新，上一版预览和代码已保留。"
              : "已停止本次生成。你可以调整需求后重新开始。",
          createdAt: now(),
        });
      },
      true,
    );
    return result;
  },

  async restorePreview(id: string): Promise<Project> {
    requireSession();
    const project = findProject(id);
    if (project.status === "running")
      throw new Error("请等待当前更新完成后再恢复预览。");
    if (project.revision === 0)
      throw new Error("这个项目还没有可恢复的版本，请先生成应用。");
    return updateProject(id, (current) => {
      current.status = "ready";
    });
  },

  async expirePreview(id: string): Promise<Project> {
    requireSession();
    const project = findProject(id);
    if (project.status === "running")
      throw new Error("请先停止当前更新，再演示预览过期。");
    if (project.revision === 0) throw new Error("这个项目还没有预览。");
    return updateProject(id, (current) => {
      current.status = "expired";
    });
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Reset local demo fixtures; intentionally not connected to destructive UI. */
export function resetDemo(): void {
  scheduled.forEach((handles) => handles.forEach(clearTimeout));
  scheduled.clear();
  commit(newStore());
}
