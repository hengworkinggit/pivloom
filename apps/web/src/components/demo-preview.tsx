"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Leaf,
  Plus,
  Search,
  Sprout,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import "./demo-preview.css";

export type DemoKind = "events" | "books" | "portfolio";

type Attendee = {
  id: string;
  name: string;
  email: string;
  track: "设计" | "开发";
  confirmed: boolean;
};

const initialAttendees: Attendee[] = [
  {
    id: "linzhou",
    name: "林舟",
    email: "linzhou@example.test",
    track: "设计",
    confirmed: false,
  },
  {
    id: "tianhe",
    name: "田禾",
    email: "tianhe@example.test",
    track: "开发",
    confirmed: true,
  },
  {
    id: "songning",
    name: "宋宁",
    email: "songning@example.test",
    track: "设计",
    confirmed: false,
  },
];

type BookStatus = "想读" | "在读" | "读完";
type Book = {
  id: string;
  title: string;
  author: string;
  status: BookStatus;
  color: string;
  subtitle: string;
};

const initialBooks: Book[] = [
  {
    id: "design",
    title: "设计中的设计",
    author: "原研哉",
    status: "在读",
    color: "sand",
    subtitle: "DESIGNING DESIGN",
  },
  {
    id: "moon",
    title: "月亮与六便士",
    author: "威廉·萨默塞特·毛姆",
    status: "想读",
    color: "clay",
    subtitle: "THE MOON AND SIXPENCE",
  },
  {
    id: "life",
    title: "生活，是很好玩的",
    author: "汪曾祺",
    status: "读完",
    color: "sage",
    subtitle: "THE LITTLE THINGS",
  },
];

/** Rendered inside the preview iframe; every state is local demo data. */
export function DemoPreview({
  kind,
  revision = 3,
  compact = false,
  features,
}: {
  kind: DemoKind;
  revision?: number;
  compact?: boolean;
  features?: string[];
}) {
  if (compact) return <ProjectThumbnail kind={kind} />;
  if (kind === "books") return <BooksDemo />;
  if (kind === "portfolio") return <PortfolioDemo />;
  return <EventsDemo revision={revision} features={features} />;
}

function EventsDemo({
  revision,
  features,
}: {
  revision: number;
  features?: string[];
}) {
  const [attendees, setAttendees] = useState(initialAttendees);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const formId = useId();
  const hasStats = features ? features.includes("stats") : revision >= 3;
  const hasStatusFilters = features
    ? features.includes("status-filter")
    : revision >= 2;
  const confirmed = attendees.filter((person) => person.confirmed).length;
  const visible = useMemo(
    () =>
      attendees.filter((person) => {
        const matchText = `${person.name} ${person.email}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());
        const matchStatus =
          !hasStatusFilters ||
          filter === "全部" ||
          (filter === "已确认" ? person.confirmed : !person.confirmed);
        return matchText && matchStatus;
      }),
    [attendees, filter, query, hasStatusFilters],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const track = data.get("track") === "开发" ? "开发" : "设计";
    if (!name) {
      setError("请填写报名者的姓名。");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("请填写有效的邮箱地址。");
      return;
    }
    if (
      attendees.some(
        (person) => person.email.toLowerCase() === email.toLowerCase(),
      )
    ) {
      setError("这个邮箱已经报名了，请换一个邮箱。");
      return;
    }
    setAttendees((previous) => [
      ...previous,
      { id: `attendee-${Date.now()}`, name, email, track, confirmed: false },
    ]);
    setQuery("");
    setFilter("全部");
    setOpen(false);
    setNotice(`已添加 ${name} 的报名。`);
  }

  return (
    <main className="demo-root demo-events">
      <div className="demo-events-inner">
        <header className="demo-event-header">
          <div className="demo-event-brand">
            <span className="demo-sprout">
              <Sprout aria-hidden="true" size={31} strokeWidth={1.55} />
            </span>
            <div>
              <p className="demo-eyebrow">GATHER, GROW, CONNECT</p>
              <h1>活动报名管理</h1>
              <p className="demo-event-subtitle">让每一次相聚，都井然有序。</p>
            </div>
          </div>
          <Dialog.Root
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              setError("");
            }}
          >
            <Dialog.Trigger asChild>
              <button className="demo-button demo-event-primary">
                <Plus size={17} aria-hidden="true" />
                新增报名
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="demo-dialog-overlay" />
              <Dialog.Content
                className="demo-dialog demo-dialog-green"
                aria-describedby={`${formId}-description`}
              >
                <Dialog.Close asChild>
                  <button
                    className="demo-dialog-close"
                    aria-label="关闭新增报名"
                  >
                    <X size={19} />
                  </button>
                </Dialog.Close>
                <span className="demo-dialog-icon">
                  <Sprout size={23} />
                </span>
                <Dialog.Title className="demo-dialog-title">
                  欢迎一位新伙伴
                </Dialog.Title>
                <Dialog.Description
                  id={`${formId}-description`}
                  className="demo-dialog-description"
                >
                  填写报名信息，一起期待下一次相聚。
                </Dialog.Description>
                <form onSubmit={submit} noValidate className="demo-form">
                  <label htmlFor={`${formId}-name`}>
                    姓名 <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={`${formId}-name`}
                    name="name"
                    autoComplete="name"
                    placeholder="报名者的姓名"
                    maxLength={40}
                    required
                    aria-describedby={error ? `${formId}-error` : undefined}
                  />
                  <label htmlFor={`${formId}-email`}>
                    邮箱 <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id={`${formId}-email`}
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="name@example.com"
                    maxLength={120}
                    required
                    aria-describedby={error ? `${formId}-error` : undefined}
                  />
                  <label htmlFor={`${formId}-track`}>兴趣方向</label>
                  <div className="demo-select-wrap">
                    <select
                      id={`${formId}-track`}
                      name="track"
                      defaultValue="设计"
                    >
                      <option>设计</option>
                      <option>开发</option>
                    </select>
                    <ChevronDown size={16} aria-hidden="true" />
                  </div>
                  {error && (
                    <p
                      id={`${formId}-error`}
                      className="demo-form-error"
                      role="alert"
                    >
                      {error}
                    </p>
                  )}
                  <div className="demo-dialog-actions">
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="demo-button demo-button-outline"
                      >
                        取消
                      </button>
                    </Dialog.Close>
                    <button
                      className="demo-button demo-event-primary"
                      type="submit"
                    >
                      添加报名
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                </form>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </header>

        {hasStats && (
          <section className="demo-stats" aria-label="报名统计">
            <div className="demo-stat">
              <span className="demo-stat-icon">
                <Users size={23} strokeWidth={1.6} />
              </span>
              <div>
                <p>总报名人数</p>
                <strong>
                  {attendees.length}
                  <span>位伙伴</span>
                </strong>
              </div>
              <span className="demo-stat-decoration" aria-hidden="true">
                <Leaf size={66} strokeWidth={0.7} />
              </span>
            </div>
            <div className="demo-stat">
              <span className="demo-stat-icon">
                <UserCheck size={23} strokeWidth={1.6} />
              </span>
              <div>
                <p>已确认人数</p>
                <strong>
                  {confirmed}
                  <span>期待相见</span>
                </strong>
              </div>
              <span className="demo-stat-decoration" aria-hidden="true">
                <Sprout size={66} strokeWidth={0.7} />
              </span>
            </div>
          </section>
        )}

        <section
          className="demo-registration"
          aria-labelledby="demo-registration-title"
        >
          <div className="demo-section-heading">
            <h2 id="demo-registration-title">报名列表</h2>
            <span>
              {attendees.length} 位伙伴，{attendees.length - confirmed} 位待确认
            </span>
          </div>
          <div className="demo-event-toolbar">
            <div className="demo-search">
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="搜索姓名或邮箱"
                placeholder="搜索姓名或邮箱…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="清空搜索">
                  <X size={15} />
                </button>
              )}
            </div>
            {hasStatusFilters && (
              <div className="demo-filter" aria-label="报名状态筛选">
                {["全部", "待确认", "已确认"].map((status) => (
                  <button
                    key={status}
                    aria-pressed={filter === status}
                    className={filter === status ? "demo-filter-active" : ""}
                    onClick={() => setFilter(status)}
                  >
                    {status}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="demo-table-wrap">
            <table className="demo-attendee-table">
              <caption className="demo-sr-only">
                活动报名者信息与确认操作
              </caption>
              <thead>
                <tr>
                  <th scope="col">姓名</th>
                  <th scope="col">邮箱</th>
                  <th scope="col">方向</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="demo-action-heading">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((person, index) => (
                  <tr key={person.id}>
                    <td data-label="姓名">
                      <div className="demo-person">
                        <span
                          className={`demo-avatar demo-avatar-${index % 3}`}
                        >
                          {person.name.slice(0, 1)}
                        </span>
                        <strong>{person.name}</strong>
                      </div>
                    </td>
                    <td data-label="邮箱" className="demo-email">
                      {person.email}
                    </td>
                    <td data-label="方向">
                      <span className="demo-track">{person.track}</span>
                    </td>
                    <td data-label="状态">
                      <span
                        className={`demo-badge ${person.confirmed ? "demo-confirmed" : "demo-pending"}`}
                      >
                        <i />
                        {person.confirmed ? "已确认" : "待确认"}
                      </span>
                    </td>
                    <td data-label="操作" className="demo-action-cell">
                      {person.confirmed ? (
                        <span
                          className="demo-row-done"
                          aria-label={`${person.name} 已确认`}
                        >
                          <Check size={16} />
                        </span>
                      ) : (
                        <button
                          className="demo-confirm-button"
                          aria-label={`确认 ${person.name} 的报名`}
                          onClick={() => {
                            setAttendees((previous) =>
                              previous.map((entry) =>
                                entry.id === person.id
                                  ? { ...entry, confirmed: true }
                                  : entry,
                              ),
                            );
                            setNotice(`已确认 ${person.name} 的报名。`);
                          }}
                        >
                          确认
                          <Check size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className="demo-empty">
                <Search size={25} />
                <h3>没有找到匹配的报名</h3>
                <p>换一个关键词，或试试其他状态。</p>
                <button
                  className="demo-button demo-button-outline"
                  onClick={() => {
                    setQuery("");
                    setFilter("全部");
                  }}
                >
                  查看全部报名
                </button>
              </div>
            )}
          </div>
          <div className="demo-table-footer">
            <span>
              共 {visible.length} 条报名
              {visible.length !== attendees.length
                ? `，总计 ${attendees.length} 条`
                : ""}
            </span>
            <span className="demo-event-footnote">
              <span className="demo-tiny-dot" />
              每一次相聚，都值得期待
            </span>
          </div>
          <p className="demo-live-notice" role="status" aria-live="polite">
            {notice}
          </p>
        </section>
        <footer className="demo-event-footer">
          <Sprout size={14} />
          把美好的人，聚在一起。
        </footer>
      </div>
    </main>
  );
}

function BooksDemo() {
  const [books, setBooks] = useState(initialBooks);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("全部");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const formId = useId();
  const filtered = books.filter(
    (book) =>
      (filter === "全部" || book.status === filter) &&
      `${book.title} ${book.author}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  function addBook(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    const author = String(data.get("author") ?? "").trim();
    if (!title || !author) {
      setError("请填写书名和作者。");
      return;
    }
    setBooks((previous) => [
      ...previous,
      {
        id: `book-${Date.now()}`,
        title,
        author,
        status: "想读",
        color: ["sand", "clay", "sage"][previous.length % 3],
        subtitle: "A NEW CHAPTER",
      },
    ]);
    setOpen(false);
    setFilter("全部");
    setQuery("");
    setNotice(`《${title}》已加入书架。`);
  }
  return (
    <main className="demo-root demo-books">
      <div className="demo-books-inner">
        <nav className="demo-books-nav">
          <span className="demo-books-logo">
            <BookOpen size={23} strokeWidth={1.5} />
            一页之间<span>THE READING ROOM</span>
          </span>
          <span className="demo-books-nav-note">留一点时间，给自己。</span>
        </nav>
        <header className="demo-books-header">
          <div>
            <p className="demo-eyebrow">YOUR NEXT CHAPTER</p>
            <h1>
              在书页里，
              <br />
              <em>遇见更大的世界。</em>
            </h1>
            <p>把想读的故事留下，让喜欢的文字慢慢发生。</p>
          </div>
          <div className="demo-book-illustration" aria-hidden="true">
            <div className="demo-illustration-book demo-illustration-book-back" />
            <div className="demo-illustration-book demo-illustration-book-front">
              <span>
                READ
                <br />A LITTLE.
                <br />
                <em>Live a lot.</em>
              </span>
              <Sprout size={26} strokeWidth={1} />
            </div>
            <span className="demo-illustration-spark">✳</span>
          </div>
        </header>
        <section aria-labelledby="demo-books-title">
          <div className="demo-books-section-title">
            <h2 id="demo-books-title">
              我的书架 <span>{books.length}</span>
            </h2>
            <Dialog.Root
              open={open}
              onOpenChange={(next) => {
                setOpen(next);
                setError("");
              }}
            >
              <Dialog.Trigger asChild>
                <button className="demo-button demo-book-primary">
                  <Plus size={16} />
                  添加一本书
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="demo-dialog-overlay" />
                <Dialog.Content className="demo-dialog demo-dialog-clay">
                  <Dialog.Close asChild>
                    <button
                      className="demo-dialog-close"
                      aria-label="关闭添加书籍"
                    >
                      <X size={19} />
                    </button>
                  </Dialog.Close>
                  <span className="demo-dialog-icon">
                    <BookOpen size={23} />
                  </span>
                  <Dialog.Title className="demo-dialog-title">
                    下一本，读什么？
                  </Dialog.Title>
                  <Dialog.Description className="demo-dialog-description">
                    记下心动的书，让故事从这里开始。
                  </Dialog.Description>
                  <form className="demo-form" noValidate onSubmit={addBook}>
                    <label htmlFor={`${formId}-title`}>书名</label>
                    <input
                      id={`${formId}-title`}
                      name="title"
                      placeholder="输入书名"
                      maxLength={80}
                      required
                    />
                    <label htmlFor={`${formId}-author`}>作者</label>
                    <input
                      id={`${formId}-author`}
                      name="author"
                      placeholder="输入作者"
                      maxLength={60}
                      required
                    />
                    {error && (
                      <p className="demo-form-error" role="alert">
                        {error}
                      </p>
                    )}
                    <div className="demo-dialog-actions">
                      <Dialog.Close asChild>
                        <button
                          type="button"
                          className="demo-button demo-button-outline"
                        >
                          取消
                        </button>
                      </Dialog.Close>
                      <button
                        type="submit"
                        className="demo-button demo-book-primary"
                      >
                        加入书架
                        <ArrowRight size={15} />
                      </button>
                    </div>
                  </form>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </div>
          <div className="demo-books-toolbar">
            <div className="demo-book-filters" aria-label="阅读状态筛选">
              {["全部", "想读", "在读", "读完"].map((status) => (
                <button
                  className={filter === status ? "demo-book-filter-active" : ""}
                  key={status}
                  aria-pressed={filter === status}
                  onClick={() => setFilter(status)}
                >
                  {status}
                  <span>
                    {status === "全部"
                      ? books.length
                      : books.filter((book) => book.status === status).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="demo-search demo-book-search">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="搜索书名或作者"
                placeholder="搜索书名、作者"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button aria-label="清空书籍搜索" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          <div className="demo-book-grid">
            {filtered.map((book) => (
              <article className="demo-book-card" key={book.id}>
                <div
                  className={`demo-book-cover-area demo-cover-area-${book.color}`}
                >
                  <div className={`demo-book-cover demo-cover-${book.color}`}>
                    <span className="demo-cover-topline">THE READING ROOM</span>
                    <h3>{book.title}</h3>
                    <div className="demo-cover-art" aria-hidden="true">
                      {book.color === "sage" ? (
                        <Sprout size={60} strokeWidth={0.9} />
                      ) : book.color === "clay" ? (
                        <span className="demo-cover-moon" />
                      ) : (
                        <span className="demo-cover-circle" />
                      )}
                    </div>
                    <p>{book.subtitle}</p>
                    <span>{book.author}</span>
                  </div>
                </div>
                <div className="demo-book-card-info">
                  <h3>{book.title}</h3>
                  <p>{book.author}</p>
                  <label
                    className={`demo-book-status demo-book-status-${book.status === "读完" ? "done" : book.status === "在读" ? "reading" : "want"}`}
                  >
                    <span className="demo-sr-only">
                      《{book.title}》阅读状态
                    </span>
                    {book.status === "读完" ? (
                      <CheckCheck size={14} />
                    ) : (
                      <span className="demo-tiny-dot" />
                    )}
                    <select
                      value={book.status}
                      onChange={(event) => {
                        const status = event.target.value as BookStatus;
                        setBooks((previous) =>
                          previous.map((item) =>
                            item.id === book.id ? { ...item, status } : item,
                          ),
                        );
                        setNotice(`《${book.title}》已标记为${status}。`);
                      }}
                    >
                      <option>想读</option>
                      <option>在读</option>
                      <option>读完</option>
                    </select>
                    <ChevronDown size={12} />
                  </label>
                </div>
              </article>
            ))}
          </div>
          {filtered.length === 0 && (
            <div className="demo-empty">
              <BookOpen size={28} />
              <h3>这里还没有书</h3>
              <p>换个关键词，或者添加一本期待已久的书。</p>
              <button
                className="demo-button demo-button-outline"
                onClick={() => {
                  setFilter("全部");
                  setQuery("");
                }}
              >
                查看全部书籍
              </button>
            </div>
          )}
          <p className="demo-live-notice" role="status" aria-live="polite">
            {notice}
          </p>
        </section>
        <footer className="demo-books-footer">
          “生活里没有书籍，就好像没有阳光。”<span>ONE PAGE AT A TIME.</span>
        </footer>
      </div>
    </main>
  );
}

const portfolioWorks = [
  {
    name: "Forms of nature",
    category: "品牌视觉 / 艺术指导",
    year: "2025",
    className: "nature",
    detail:
      "从自然的有机形态出发，为一家植物生活方式品牌构建视觉系统。圆润的线条、留白与植物绿，一起表达更松弛的日常。",
  },
  {
    name: "Less, but better",
    category: "产品设计 / 数字体验",
    year: "2025",
    className: "less",
    detail:
      "一次关于减法的产品设计探索。重新梳理信息层级和关键流程，让复杂任务拥有简单、清晰的入口。",
  },
  {
    name: "A quiet moment",
    category: "编辑设计 / 视觉实验",
    year: "2024",
    className: "quiet",
    detail:
      "用文字、几何与光影收集日常中的片刻安静。这是一个持续进行的个人视觉实验，也是给忙碌生活的一次留白。",
  },
];

function PortfolioDemo() {
  const [selectedWork, setSelectedWork] = useState<number | null>(null);
  const [sent, setSent] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [error, setError] = useState("");
  const formId = useId();
  function sendNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!String(data.get("message") ?? "").trim()) {
      setError("写一点你想一起做的事吧。");
      return;
    }
    const email = String(data.get("email") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("请填写有效的联系邮箱。");
      return;
    }
    setSent(true);
    setError("");
  }
  return (
    <main className="demo-root demo-portfolio">
      <div className="demo-portfolio-inner">
        <header className="demo-portfolio-nav">
          <a href="#demo-portfolio-top" className="demo-portfolio-mark">
            Y.<span>YI CHEN</span>
          </a>
          <nav aria-label="作品集导航">
            <a href="#demo-portfolio-work">作品</a>
            <a href="#demo-portfolio-about">关于</a>
            <a href="#demo-portfolio-contact">
              联系
              <ArrowUpRight size={13} />
            </a>
          </nav>
        </header>
        <section id="demo-portfolio-top" className="demo-portfolio-hero">
          <div className="demo-availability">
            <span />
            OPEN TO GOOD IDEAS
          </div>
          <h1>
            让设计，
            <br />
            <span>恰如其分。</span>
            <i aria-hidden="true">✳</i>
          </h1>
          <div className="demo-portfolio-intro">
            <p>
              你好，我是陈一。
              <br />
              一名关注细节、热爱留白的独立设计师。
              <br />
              在视觉与体验之间，寻找刚刚好的平衡。
            </p>
            <a href="#demo-portfolio-work">
              向下探索
              <ArrowDown size={15} />
            </a>
          </div>
        </section>
        <section id="demo-portfolio-work" className="demo-portfolio-work">
          <div className="demo-portfolio-section-heading">
            <h2>
              精选作品<span>SELECTED WORK</span>
            </h2>
            <span>2024 — 2025</span>
          </div>
          <div className="demo-portfolio-projects">
            {portfolioWorks.map((work, index) => (
              <button
                className="demo-portfolio-project"
                key={work.name}
                onClick={() => setSelectedWork(index)}
                aria-label={`查看 ${work.name} 项目详情`}
              >
                <div
                  className={`demo-project-art demo-project-art-${work.className}`}
                >
                  <span className="demo-project-number">0{index + 1}</span>
                  {work.className === "nature" ? (
                    <>
                      <span className="demo-nature-art-title">
                        forms
                        <br />
                        <em>of nature.</em>
                      </span>
                      <div className="demo-nature-sculpture">
                        <i />
                        <i />
                        <i />
                      </div>
                    </>
                  ) : work.className === "less" ? (
                    <>
                      <div className="demo-less-window">
                        <span />
                        <span />
                        <span />
                        <div>
                          Make room
                          <br />
                          <em>for what matters.</em>
                          <div className="demo-less-lines">
                            <i />
                            <i />
                          </div>
                        </div>
                      </div>
                      <span className="demo-art-caption">
                        LESS, BUT BETTER.
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="demo-quiet-word">
                        A<br />
                        <em>quiet</em>
                        <br />
                        moment.
                      </span>
                      <div className="demo-quiet-sun" />
                    </>
                  )}
                  <span className="demo-project-open">
                    <ArrowUpRight size={20} />
                  </span>
                </div>
                <div className="demo-project-caption">
                  <div>
                    <h3>{work.name}</h3>
                    <p>{work.category}</p>
                  </div>
                  <span>{work.year}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
        <section id="demo-portfolio-about" className="demo-portfolio-about">
          <span className="demo-portfolio-label">A LITTLE ABOUT ME</span>
          <div>
            <h2>
              好设计，是一种
              <br />
              温柔而明确的表达。
            </h2>
            <p>
              我喜欢从真实的问题开始，创造经得起使用的设计。从品牌识别到数字产品，我在意的不只是它看起来怎样，更是它如何与人相处。
            </p>
            <div className="demo-portfolio-skills">
              <span>品牌设计</span>
              <span>数字产品</span>
              <span>艺术指导</span>
            </div>
          </div>
        </section>
        <section id="demo-portfolio-contact" className="demo-portfolio-contact">
          <span className="demo-portfolio-label">
            LET’S MAKE SOMETHING GOOD.
          </span>
          <h2>
            下一个好想法，
            <br />
            我们一起完成。
          </h2>
          <Dialog.Root
            open={contactOpen}
            onOpenChange={(next) => {
              setContactOpen(next);
              if (next) {
                setSent(false);
                setError("");
              }
            }}
          >
            <Dialog.Trigger asChild>
              <button className="demo-portfolio-contact-button">
                聊聊你的想法
                <ArrowUpRight size={20} />
              </button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="demo-dialog-overlay" />
              <Dialog.Content className="demo-dialog demo-dialog-ink">
                <Dialog.Close asChild>
                  <button
                    className="demo-dialog-close"
                    aria-label="关闭联系窗口"
                  >
                    <X size={19} />
                  </button>
                </Dialog.Close>
                <Dialog.Title className="demo-dialog-title">
                  聊聊你的好想法
                </Dialog.Title>
                <Dialog.Description className="demo-dialog-description">
                  这是作品集演示，留言仅保留在当前预览中。
                </Dialog.Description>
                {sent ? (
                  <div className="demo-contact-success" role="status">
                    <CheckCircle2 size={34} />
                    <h3>想法已经记下了。</h3>
                    <p>谢谢你的分享！这条演示留言不会发送到外部。</p>
                    <Dialog.Close asChild>
                      <button className="demo-button demo-ink-primary">
                        完成
                      </button>
                    </Dialog.Close>
                  </div>
                ) : (
                  <form className="demo-form" noValidate onSubmit={sendNote}>
                    <label htmlFor={`${formId}-email`}>联系邮箱</label>
                    <input
                      id={`${formId}-email`}
                      type="email"
                      name="email"
                      placeholder="you@example.com"
                      required
                    />
                    <label htmlFor={`${formId}-message`}>
                      你想一起做什么？
                    </label>
                    <textarea
                      id={`${formId}-message`}
                      name="message"
                      placeholder="聊聊你的项目或想法…"
                      rows={4}
                      required
                    />
                    {error && (
                      <p className="demo-form-error" role="alert">
                        {error}
                      </p>
                    )}
                    <button
                      type="submit"
                      className="demo-button demo-ink-primary"
                    >
                      记录想法
                      <ArrowUpRight size={15} />
                    </button>
                  </form>
                )}
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </section>
        <footer className="demo-portfolio-footer">
          <span>© 2025 YI CHEN</span>
          <span>DESIGNED WITH INTENTION.</span>
          <a href="#demo-portfolio-top" aria-label="返回作品集顶部">
            回到顶部
            <ArrowUpRight size={13} />
          </a>
        </footer>
        <Dialog.Root
          open={selectedWork !== null}
          onOpenChange={(next) => {
            if (!next) setSelectedWork(null);
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="demo-dialog-overlay" />
            <Dialog.Content className="demo-dialog demo-dialog-ink">
              <Dialog.Close asChild>
                <button className="demo-dialog-close" aria-label="关闭项目详情">
                  <X size={19} />
                </button>
              </Dialog.Close>
              <span className="demo-portfolio-label">
                SELECTED WORK / 0{(selectedWork ?? 0) + 1}
              </span>
              <Dialog.Title className="demo-dialog-title demo-project-dialog-title">
                {portfolioWorks[selectedWork ?? 0].name}
              </Dialog.Title>
              <Dialog.Description className="demo-project-description">
                {portfolioWorks[selectedWork ?? 0].detail}
              </Dialog.Description>
              <div className="demo-project-dialog-meta">
                <span>{portfolioWorks[selectedWork ?? 0].category}</span>
                <span>{portfolioWorks[selectedWork ?? 0].year}</span>
              </div>
              <Dialog.Close asChild>
                <button className="demo-button demo-ink-primary">
                  继续浏览
                  <ArrowRight size={15} />
                </button>
              </Dialog.Close>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </main>
  );
}

/** CSS-rendered project covers: no nested focusable controls inside project links. */
export function ProjectThumbnail({ kind }: { kind: DemoKind }) {
  if (kind === "books")
    return (
      <div className="demo-thumbnail demo-thumbnail-books" aria-hidden="true">
        <div className="demo-thumb-books-top">
          <span>
            <BookOpen size={11} />
            一页之间
          </span>
          <i>THE READING ROOM</i>
        </div>
        <div className="demo-thumb-books-title">
          在书页里，
          <br />
          <em>遇见更大的世界。</em>
        </div>
        <div className="demo-thumb-book-row">
          {initialBooks.map((book) => (
            <div
              key={book.id}
              className={`demo-thumb-book demo-cover-${book.color}`}
            >
              <span>{book.title}</span>
              <i>
                {book.color === "sage" ? (
                  <Sprout size={22} strokeWidth={1} />
                ) : book.color === "clay" ? (
                  "◒"
                ) : (
                  "○"
                )}
              </i>
              <small>{book.author}</small>
            </div>
          ))}
        </div>
        <div className="demo-thumb-books-line" />
      </div>
    );
  if (kind === "portfolio")
    return (
      <div
        className="demo-thumbnail demo-thumbnail-portfolio"
        aria-hidden="true"
      >
        <div className="demo-thumb-portfolio-nav">
          <strong>Y.</strong>
          <span>作品　 关于　 联系 ↗</span>
        </div>
        <div className="demo-thumb-portfolio-title">
          让设计，
          <br />
          <span>恰如其分。</span>
          <i>✳</i>
        </div>
        <div className="demo-thumb-portfolio-sub">
          在视觉与体验之间，寻找刚刚好的平衡。
        </div>
        <div className="demo-thumb-portfolio-projects">
          <div>
            <span>
              forms
              <br />
              <em>of nature.</em>
            </span>
            <i />
          </div>
          <div>
            <span>
              Less,
              <br />
              <em>but better.</em>
            </span>
          </div>
          <div>
            <span>
              A quiet
              <br />
              <em>moment.</em>
            </span>
            <i />
          </div>
        </div>
      </div>
    );
  return (
    <div className="demo-thumbnail demo-thumbnail-events" aria-hidden="true">
      <div className="demo-thumb-event-title">
        <span>
          <Sprout size={17} strokeWidth={1.5} />
        </span>
        <div>
          <strong>活动报名管理</strong>
          <p>让每一次相聚，都井然有序。</p>
        </div>
        <i>＋ 新增报名</i>
      </div>
      <div className="demo-thumb-event-stats">
        <div>
          <Users size={13} />
          <span>
            总报名人数<strong>3</strong>
          </span>
        </div>
        <div>
          <UserCheck size={13} />
          <span>
            已确认人数<strong>1</strong>
          </span>
        </div>
      </div>
      <div className="demo-thumb-event-heading">
        <strong>报名列表</strong>
        <span>全部　 待确认　 已确认</span>
      </div>
      <div className="demo-thumb-event-search">
        <Search size={8} />
        搜索姓名或邮箱
      </div>
      <div className="demo-thumb-event-table">
        <div className="demo-thumb-table-heading">
          <span>姓名</span>
          <span>邮箱</span>
          <span>状态</span>
        </div>
        {initialAttendees.map((person) => (
          <div key={person.id}>
            <span>
              <i>{person.name[0]}</i>
              {person.name}
            </span>
            <span>{person.email}</span>
            <span
              className={
                person.confirmed ? "demo-thumb-confirmed" : "demo-thumb-pending"
              }
            >
              {person.confirmed ? "已确认" : "待确认"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
