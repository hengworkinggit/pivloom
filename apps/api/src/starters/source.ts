import type { StarterSlug } from "./catalog.js";

const common = String.raw`
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211e;background:#f6f7f2}button,input,select{font:inherit}button{cursor:pointer}a{color:inherit}.shell{--accent:#3b7567;--wash:#e5eee9;min-height:100vh;padding:28px max(24px,calc((100vw - 1180px)/2));}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:8px 0 30px;border-bottom:1px solid #d8ded8}.brand{font-weight:800;letter-spacing:-.05em;font-size:20px}.top nav{display:flex;gap:24px;color:#60726b;font-size:14px}.top nav a{text-decoration:none}.top nav a:hover{color:var(--accent)}.eyebrow{display:block;text-transform:uppercase;letter-spacing:.18em;font-size:11px;font-weight:800;color:var(--accent)}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(42px,6vw,82px);line-height:1.02;letter-spacing:-.07em;margin:16px 0 22px;max-width:820px}h2{font-size:28px;letter-spacing:-.04em}h3{font-size:17px;letter-spacing:-.03em}.hero{padding:68px 0 46px}.hero p{max-width:660px;font-size:18px;line-height:1.65;color:#5f6d65}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.button,.primary{border:0;border-radius:13px;padding:12px 18px;font-weight:700;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:white}.button:hover,.primary:hover{filter:brightness(.92)}.button.secondary{background:var(--wash);color:var(--accent)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card,.panel{background:white;border:1px solid #e1e6df;border-radius:20px;padding:24px;box-shadow:0 10px 35px rgba(30,58,45,.035)}.card p,.muted{color:#68786e;line-height:1.6}.panel{margin:20px 0}.section-head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:38px 0 18px}.section-head h2{margin:0}.stat-row{display:flex;gap:12px;flex-wrap:wrap}.stat{border:1px solid #e1e6df;background:white;border-radius:16px;padding:16px 20px;min-width:130px}.stat strong{display:block;font-size:28px;letter-spacing:-.06em}.stat small{color:#78877d}.form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.field{display:grid;gap:7px;font-size:13px;font-weight:700;color:#526359}.field input,.field select,.search{width:100%;border:1px solid #d8e0d9;border-radius:11px;background:#fff;padding:12px;color:#17211e;outline:none}.field input:focus,.field select:focus,.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--wash)}.form-actions{display:flex;align-items:center;gap:12px;margin-top:16px}.error{color:#aa3131;font-size:13px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}.toolbar .search{flex:1;min-width:190px}.toolbar select{border:1px solid #d8e0d9;border-radius:11px;padding:11px;background:white}.list{display:grid;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #e2e7e0;background:white;border-radius:15px;padding:16px 18px}.row strong{display:block}.row small{display:block;color:#718177;margin-top:4px}.row-actions{display:flex;gap:8px;align-items:center}.mini{border:0;border-radius:9px;padding:8px 11px;background:var(--wash);color:var(--accent);font-size:12px;font-weight:700}.mini.danger{background:#fff0ed;color:#a64436}.badge{font-size:12px;font-weight:700;border-radius:999px;padding:6px 10px;background:var(--wash);color:var(--accent)}.empty{padding:36px;text-align:center;color:#7b8a80;border:1px dashed #cfd9d0;border-radius:17px}.footer{border-top:1px solid #d8ded8;margin-top:70px;padding:26px 0;color:#7a8a7f;font-size:13px}.event{--accent:#a95b3c;--wash:#faeae1;background:#fbf7f0}.reading{--accent:#697447;--wash:#eef0e1;background:#faf9f2}.portfolio{--accent:#344e7c;--wash:#e8edf8;background:#f8f9fc}.booking{--accent:#397790;--wash:#e5f0f4;background:#f7fafb}.studio{--accent:#d74f3c;--wash:#f9e8e3;background:#f8f5f1}.tasks{--accent:#6761ae;--wash:#ecebfa;background:#f8f8fd}.cover{height:160px;border-radius:13px;margin-bottom:18px;background:linear-gradient(135deg,var(--wash),#fff 62%,var(--accent));opacity:.8}.project-no{font-size:12px;letter-spacing:.15em;color:var(--accent);font-weight:800}.portfolio .card,.studio .card{min-height:230px}.studio h1{font-weight:900;text-transform:uppercase}.studio .hero{padding:92px 0}.studio .hero p{font-size:20px}.columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.column{background:var(--wash);border-radius:18px;padding:16px;min-height:220px}.column .row{display:block;margin-top:10px}.column .row-actions{margin-top:14px}.progress{height:9px;border-radius:999px;background:#e2e7df;overflow:hidden}.progress span{display:block;height:100%;background:var(--accent)}@media(max-width:700px){.shell{padding:16px}.top{padding-bottom:20px}.top nav{gap:12px;font-size:12px}.hero{padding:45px 0 28px}.grid,.columns,.form-grid{grid-template-columns:1fr}.row{align-items:start;flex-direction:column}.row-actions{width:100%;justify-content:flex-start}.section-head{margin-top:28px}.studio .hero{padding:56px 0}}
`;

const managedData = String.raw`
export type DataMode = 'preview' | 'published' | 'unavailable';
export async function detectDataMode(kind: 'event-signup' | 'appointments'): Promise<DataMode> {
  if (!document.querySelector('meta[name="pivloom-published"]')) return 'preview';
  try {
    const response = await fetch('/__pivloom/runtime', { cache: 'no-store' });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return 'unavailable';
    const value: unknown = await response.json();
    if (value && typeof value === 'object' && 'mode' in value && 'kind' in value
      && value.mode === 'published' && value.kind === kind) return 'published';
  } catch { /* A broken production API must never fall back to local-only writes. */ }
  return 'unavailable';
}
export async function submitRecord(collection: 'registrations' | 'bookings', data: unknown, idempotencyKey: string) {
  const response = await fetch('/__pivloom/data/' + collection, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(data),
  });
  let result: { error?: { message?: string } } | null = null;
  try { result = await response.json(); } catch { /* Preserve the generic error. */ }
  if (!response.ok) throw new Error(result?.error?.message || '提交未完成，请稍后重试。');
}
export async function occupiedSlots(date: string): Promise<string[]> {
  const response = await fetch('/__pivloom/data/slots?date=' + encodeURIComponent(date), { cache: 'no-store' });
  if (!response.ok) throw new Error('暂时无法读取可用时段，请稍后重试。');
  const value: { occupied?: unknown } = await response.json();
  if (!Array.isArray(value.occupied) || !value.occupied.every(item => typeof item === 'string'))
    throw new Error('可用时段响应无效。');
  return value.occupied;
}
`;

const eventSignup = String.raw`
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectDataMode, submitRecord, type DataMode } from './pivloom-data';
type Entry = { id: string; name: string; email: string; category: string; confirmed: boolean };
const key = 'pivloom-event-signup-v1';
function load(): Entry[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
export default function App() {
  const [items, setItems] = useState<Entry[]>(load); const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [category, setCategory] = useState('创意沙龙'); const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [error, setError] = useState('');
  const [mode, setMode] = useState<DataMode | null>(null); const [busy, setBusy] = useState(false); const [success, setSuccess] = useState('');
  const pending = useRef<{ key: string; payload: string } | null>(null);
  useEffect(() => { let active = true; void detectDataMode('event-signup').then(value => { if (active) setMode(value); }); return () => { active = false; }; }, []);
  useEffect(() => { if (mode === 'preview') localStorage.setItem(key, JSON.stringify(items)); }, [items, mode]);
  const shown = useMemo(() => items.filter(item => (filter === 'all' || (filter === 'confirmed') === item.confirmed) && (item.name + item.email + item.category).toLowerCase().includes(search.toLowerCase())), [items, filter, search]);
  async function add(event: React.FormEvent) { event.preventDefault(); if (busy || !name.trim() || !email.trim()) { setError('请填写姓名和邮箱'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('请输入有效的邮箱地址'); return; }
    const payload = { name: name.trim(), email: email.trim(), category }; setBusy(true); setError(''); setSuccess('');
    try {
      if (mode === 'published') {
        const value = JSON.stringify(payload);
        if (!pending.current || pending.current.payload !== value) pending.current = { key: crypto.randomUUID(), payload: value };
        await submitRecord('registrations', payload, pending.current.key); pending.current = null;
        setSuccess('报名已提交，感谢参与。');
      } else if (mode === 'preview') setItems(list => [{ id: crypto.randomUUID(), ...payload, confirmed: false }, ...list]);
      setName(''); setEmail('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '提交未完成，请稍后重试。'); }
    finally { setBusy(false); }
  }
  if (mode === null) return <main className="shell event"><p role="status">正在准备应用…</p></main>;
  if (mode === 'unavailable') return <main className="shell event"><h1>数据服务暂时不可用</h1><p>请稍后刷新页面，当前输入不会被当作已提交的报名。</p></main>;
  return <main className="shell event"><header className="top"><span className="brand">gather<span style={{color:'var(--accent)'}}>.</span></span><nav><a href="#signup">报名</a>{mode === 'preview' && <a href="#attendees">参与者</a>}</nav></header>
    <section className="hero"><span className="eyebrow">EVENTS / COMMUNITY</span><h1>让每次相遇，<br/>都值得期待。</h1><p>{mode === 'published' ? '填写信息完成报名。报名记录会安全地交给活动组织者处理。' : '一处轻巧的活动报名工作台。收集参与者信息，确认席位，随时掌握现场人数。'}</p>{mode === 'preview' && <div className="stat-row"><div className="stat"><strong>{items.length}</strong><small>总报名</small></div><div className="stat"><strong>{items.filter(item => item.confirmed).length}</strong><small>已确认</small></div></div>}</section>
    <section id="signup" className="panel"><h2>{mode === 'published' ? '活动报名' : '新增报名'}</h2><form onSubmit={add}><div className="form-grid"><label className="field">姓名<input value={name} onChange={event => setName(event.target.value)} placeholder="参与者姓名" required /></label><label className="field">邮箱<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" required /></label><label className="field">活动类别<select value={category} onChange={event => setCategory(event.target.value)}><option>创意沙龙</option><option>产品分享</option><option>周末工作坊</option></select></label></div><div className="form-actions"><button className="primary" type="submit" disabled={busy}>{busy ? '提交中…' : '提交报名 →'}</button>{error && <span className="error" role="alert">{error}</span>}{success && <span role="status">{success}</span>}</div></form></section>
    {mode === 'preview' && <section id="attendees"><div className="section-head"><div><span className="eyebrow">ATTENDEES</span><h2>报名名单</h2></div><span className="muted">{shown.length} 位参与者</span></div><div className="toolbar"><input className="search" aria-label="搜索报名" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索姓名、邮箱或类别"/><select aria-label="筛选状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部状态</option><option value="confirmed">已确认</option><option value="pending">待确认</option></select></div><div className="list">{shown.map(item => <article className="row" key={item.id}><div><strong>{item.name}</strong><small>{item.email} · {item.category}</small></div><div className="row-actions"><span className="badge">{item.confirmed ? '已确认' : '待确认'}</span><button className="mini" onClick={() => setItems(list => list.map(row => row.id === item.id ? {...row, confirmed: !row.confirmed} : row))}>{item.confirmed ? '撤销确认' : '确认席位'}</button><button className="mini danger" onClick={() => setItems(list => list.filter(row => row.id !== item.id))}>删除</button></div></article>)}{shown.length === 0 && <div className="empty">还没有符合条件的报名，先添加一位参与者吧。</div>}</div></section>}<footer className="footer">{mode === 'published' ? 'gather. · 报名信息仅供活动组织者管理' : 'gather. · Preview 数据仅保存在此浏览器'}</footer></main>;
}
`;

const readingList = String.raw`
import { useEffect, useMemo, useState } from 'react';
type Book = { id: string; title: string; author: string; status: '想读' | '在读' | '已读' };
const key = 'pivloom-reading-list-v1';
function load(): Book[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
export default function App() { const [books, setBooks] = useState<Book[]>(load); const [title, setTitle] = useState(''); const [author, setAuthor] = useState(''); const [status, setStatus] = useState<Book['status']>('想读'); const [search, setSearch] = useState(''); const [filter, setFilter] = useState('全部');
  useEffect(() => { localStorage.setItem(key, JSON.stringify(books)); }, [books]); const finished = books.filter(book => book.status === '已读').length;
  const shown = useMemo(() => books.filter(book => (filter === '全部' || book.status === filter) && (book.title + book.author).toLowerCase().includes(search.toLowerCase())), [books, filter, search]);
  function add(event: React.FormEvent) { event.preventDefault(); if (!title.trim() || !author.trim()) return; setBooks(list => [{ id: crypto.randomUUID(), title: title.trim(), author: author.trim(), status }, ...list]); setTitle(''); setAuthor(''); }
  return <main className="shell reading"><header className="top"><span className="brand">the reading room</span><nav><a href="#shelf">我的书架</a><a href="#add">添加书籍</a></nav></header><section className="hero"><span className="eyebrow">A LITTLE SPACE FOR STORIES</span><h1>在书页之间，<br/>找到下一站。</h1><p>把想读、在读和读完的故事安放在这里。下一本好书，总会在合适的时间出现。</p><div className="stat-row"><div className="stat"><strong>{books.length}</strong><small>书架藏书</small></div><div className="stat"><strong>{finished}</strong><small>已经读完</small></div><div className="stat"><strong>{books.length ? Math.round(finished / books.length * 100) : 0}%</strong><small>阅读进度</small></div></div><div className="progress" style={{maxWidth:450,marginTop:20}}><span style={{width:(books.length ? finished / books.length * 100 : 0) + '%'}}/></div></section>
    <section id="add" className="panel"><h2>把一本书放上书架</h2><form onSubmit={add}><div className="form-grid"><label className="field">书名<input value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：悉达多" required /></label><label className="field">作者<input value={author} onChange={event => setAuthor(event.target.value)} placeholder="作者" required /></label><label className="field">阅读状态<select value={status} onChange={event => setStatus(event.target.value as Book['status'])}><option>想读</option><option>在读</option><option>已读</option></select></label></div><div className="form-actions"><button className="primary" type="submit">添加书籍 →</button></div></form></section>
    <section id="shelf"><div className="section-head"><div><span className="eyebrow">YOUR LIBRARY</span><h2>我的书架</h2></div><span className="muted">{shown.length} 本书</span></div><div className="toolbar"><input className="search" aria-label="搜索书籍" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索书名或作者"/><select aria-label="筛选阅读状态" value={filter} onChange={event => setFilter(event.target.value)}><option>全部</option><option>想读</option><option>在读</option><option>已读</option></select></div><div className="list">{shown.map(book => <article className="row" key={book.id}><div><strong>{book.title}</strong><small>{book.author}</small></div><div className="row-actions"><span className="badge">{book.status}</span><select aria-label={book.title + ' 阅读状态'} value={book.status} onChange={event => setBooks(list => list.map(item => item.id === book.id ? {...item, status: event.target.value as Book['status']} : item))}><option>想读</option><option>在读</option><option>已读</option></select><button className="mini danger" onClick={() => setBooks(list => list.filter(item => item.id !== book.id))}>移除</button></div></article>)}{shown.length === 0 && <div className="empty">书架还是空的，添加一本想读的书吧。</div>}</div></section><footer className="footer">the reading room · 你的书单只保存在此浏览器</footer></main>;
}
`;

const portfolio = String.raw`
const projects = [
  { number: '01', title: 'Atlas 地图计划', type: '产品设计 · 2026', copy: '把复杂的信息重新组织成清晰、可探索的路线。' },
  { number: '02', title: 'Good Days', type: '品牌体验 · 2025', copy: '为更有温度的日常，设计一套轻盈的视觉语言。' },
  { number: '03', title: 'Field Notes', type: '交互设计 · 2024', copy: '帮助创作者整理灵感，并把它们带到下一步。' },
];
export default function App() { return <main className="shell portfolio"><header className="top"><span className="brand">J. LIN / PORTFOLIO</span><nav><a href="#work">作品</a><a href="#about">关于</a><a href="#contact">联系</a></nav></header><section className="hero"><span className="eyebrow">DESIGNER & CREATIVE THINKER</span><h1>创造有温度的<br/>数字体验。</h1><p>你好，我是林简，一名专注产品与品牌体验的设计师。我喜欢让复杂的问题变得简单，让每一次使用都留下好的感受。</p><div className="hero-actions"><a className="button" href="#work">浏览作品 →</a><a className="button secondary" href="mailto:hello@example.com">联系我</a></div></section><section id="work"><div className="section-head"><div><span className="eyebrow">SELECTED WORK / 2026</span><h2>精选项目</h2></div></div><div className="grid">{projects.map(project => <article className="card" key={project.number}><div className="cover"/><span className="project-no">{project.number} / {project.type}</span><h3 style={{marginTop:16}}>{project.title}</h3><p>{project.copy}</p></article>)}</div></section><section id="about" className="panel" style={{marginTop:50}}><span className="eyebrow">ABOUT ME</span><h2>好设计，从理解开始。</h2><p className="muted">过去 6 年，我在产品团队与独立项目中探索研究、策略、视觉和交互。相信细节会累积成信任，也相信好的作品来自持续的好奇心。</p><div className="stat-row"><span className="badge">产品策略</span><span className="badge">交互设计</span><span className="badge">视觉语言</span><span className="badge">原型制作</span></div><p className="muted" style={{marginTop:24}}>2023 — 至今 · 独立设计师<br/>2020 — 2023 · North Studio / 产品设计师</p></section><section id="contact" className="hero"><span className="eyebrow">LET'S TALK</span><h2>一起做点有意思的事。</h2><p>有项目、想法或只是想打个招呼，都欢迎来信。</p><a className="button" href="mailto:hello@example.com">hello@example.com ↗</a></section><footer className="footer">© 2026 J. Lin · 把文字、项目和邮箱改成你自己的信息</footer></main>; }
`;

const appointments = String.raw`
import { useEffect, useMemo, useRef, useState } from 'react';
import { detectDataMode, occupiedSlots, submitRecord, type DataMode } from './pivloom-data';
type Booking = { id: string; date: string; time: string; name: string; contact: string; confirmed: boolean };
const key = 'pivloom-appointments-v1'; const slots = ['09:00', '10:30', '13:00', '14:30', '16:00'];
function load(): Booking[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
export default function App() { const [bookings, setBookings] = useState<Booking[]>(load); const [date, setDate] = useState(''); const [time, setTime] = useState(slots[0]); const [name, setName] = useState(''); const [contact, setContact] = useState(''); const [error, setError] = useState('');
  const [mode, setMode] = useState<DataMode | null>(null); const [busy, setBusy] = useState(false); const [success, setSuccess] = useState(''); const [occupied, setOccupied] = useState<string[]>([]);
  const pending = useRef<{ key: string; payload: string } | null>(null);
  useEffect(() => { let active = true; void detectDataMode('appointments').then(value => { if (active) setMode(value); }); return () => { active = false; }; }, []);
  useEffect(() => { if (mode === 'preview') localStorage.setItem(key, JSON.stringify(bookings)); }, [bookings, mode]);
  useEffect(() => { if (mode !== 'published' || !date) return; let active = true; void occupiedSlots(date).then(value => { if (active) setOccupied(value); }).catch(() => { if (active) setError('暂时无法读取可用时段，请稍后重试。'); }); return () => { active = false; }; }, [mode, date]);
  useEffect(() => { if (mode === 'published' && occupied.includes(time)) setTime(slots.find(slot => !occupied.includes(slot)) || slots[0]); }, [mode, occupied, time]);
  const sorted = useMemo(() => [...bookings].sort((a,b) => (a.date + a.time).localeCompare(b.date + b.time)), [bookings]);
  async function add(event: React.FormEvent) { event.preventDefault();
    if (busy || !date || !name.trim() || !contact.trim()) { setError('请填写完整预约信息'); return; }
    if (mode === 'preview' && bookings.some(item => item.date === date && item.time === time)) { setError('这个时段已被预约，请选择其他时间'); return; }
    const payload = { date, time, name: name.trim(), contact: contact.trim() }; setBusy(true); setError(''); setSuccess('');
    try {
      if (mode === 'published') {
        const value = JSON.stringify(payload);
        if (!pending.current || pending.current.payload !== value) pending.current = { key: crypto.randomUUID(), payload: value };
        await submitRecord('bookings', payload, pending.current.key); pending.current = null;
        setOccupied(list => [...list, time]); setSuccess('预约已提交，请等待确认。');
      } else if (mode === 'preview') setBookings(list => [...list, { id: crypto.randomUUID(), ...payload, confirmed: false }]);
      setName(''); setContact('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预约未完成，请稍后重试。'); }
    finally { setBusy(false); }
  }
  if (mode === null) return <main className="shell booking"><p role="status">正在准备应用…</p></main>;
  if (mode === 'unavailable') return <main className="shell booking"><h1>数据服务暂时不可用</h1><p>请稍后刷新页面，当前输入不会被当作已提交的预约。</p></main>;
  return <main className="shell booking">
    <header className="top"><span className="brand">time well spent.</span><nav><a href="#book">立即预约</a>{mode === 'preview' && <a href="#schedule">预约列表</a>}</nav></header>
    <section className="hero"><span className="eyebrow">APPOINTMENT STUDIO</span><h1>预约属于你的时间。</h1><p>选择合适的日子与时段，留下一点联系信息。简单安排，更从容地见面。</p>
      {mode === 'preview' && <div className="stat-row"><div className="stat"><strong>{bookings.length}</strong><small>全部预约</small></div><div className="stat"><strong>{bookings.filter(item => item.confirmed).length}</strong><small>已确认</small></div></div>}
    </section>
    <section id="book" className="panel"><h2>预约新时段</h2><form onSubmit={add}><div className="form-grid">
      <label className="field">日期<input type="date" min={new Date().toISOString().slice(0,10)} value={date} onChange={event => setDate(event.target.value)} required /></label>
      <label className="field">时间段<select value={time} onChange={event => setTime(event.target.value)}>{slots.map(slot => <option key={slot} disabled={mode === 'published' && occupied.includes(slot)}>{slot}</option>)}</select></label>
      <label className="field">姓名<input value={name} onChange={event => setName(event.target.value)} placeholder="预约人姓名" required /></label>
      <label className="field">联系方式<input value={contact} onChange={event => setContact(event.target.value)} placeholder="邮箱或电话" required /></label>
    </div><div className="form-actions"><button className="primary" type="submit" disabled={busy || mode === 'published' && occupied.length === slots.length}>{busy ? '提交中…' : '确认预约 →'}</button>{error && <span className="error" role="alert">{error}</span>}{success && <span role="status">{success}</span>}</div></form>
      {mode === 'published' && occupied.length === slots.length && <p role="status">这一天的预约时段已满，请选择其他日期。</p>}
    </section>
    {mode === 'preview' && <section id="schedule"><div className="section-head"><div><span className="eyebrow">YOUR SCHEDULE</span><h2>预约列表</h2></div></div><div className="list">{sorted.map(item => <article className="row" key={item.id}><div><strong>{item.date} · {item.time}</strong><small>{item.name} · {item.contact}</small></div><div className="row-actions"><span className="badge">{item.confirmed ? '已确认' : '待确认'}</span><button className="mini" onClick={() => setBookings(list => list.map(row => row.id === item.id ? {...row, confirmed: !row.confirmed} : row))}>{item.confirmed ? '撤销确认' : '确认预约'}</button><button className="mini danger" onClick={() => setBookings(list => list.filter(row => row.id !== item.id))}>取消</button></div></article>)}{sorted.length === 0 && <div className="empty">还没有预约，选择一个时间开始吧。</div>}</div></section>}
    <footer className="footer">{mode === 'published' ? 'time well spent. · 预约信息仅供服务提供者管理' : 'time well spent. · Preview 数据仅保存在此浏览器'}</footer>
  </main>; }
`;

const creativeStudio = String.raw`
const services = [{ n:'01', title:'品牌设计', copy:'从故事到视觉，让品牌拥有自己的声音。' }, { n:'02', title:'数字体验', copy:'把复杂产品变成自然、愉悦的使用体验。' }, { n:'03', title:'创意内容', copy:'用影像与文字，把值得记住的事情讲出来。' }];
const works = [{ title:'ONDA / 潮汐之上', tag:'品牌识别 · 2026' }, { title:'STILL / 留白之间', tag:'数字体验 · 2025' }, { title:'COMMON / 共生', tag:'创意企划 · 2024' }];
export default function App() { return <main className="shell studio"><header className="top"><span className="brand">FORM / FUNCTION</span><nav><a href="#services">服务</a><a href="#work">作品</a><a href="#team">我们</a><a href="#contact">联系</a></nav></header><section className="hero"><span className="eyebrow">INDEPENDENT CREATIVE STUDIO</span><h1>Make things<br/>matter<span style={{color:'var(--accent)'}}>.</span></h1><p>我们用设计、技术与一点不安分的想象力，创造值得被看见、被使用、被记住的作品。</p><div className="hero-actions"><a className="button" href="#work">看看我们的作品 →</a><a className="button secondary" href="mailto:hello@example.com">一起聊聊</a></div></section><section id="services"><div className="section-head"><div><span className="eyebrow">WHAT WE DO</span><h2>我们擅长的事</h2></div></div><div className="grid">{services.map(item => <article className="card" key={item.n}><span className="project-no">{item.n} / SERVICE</span><h3 style={{marginTop:35}}>{item.title}</h3><p>{item.copy}</p></article>)}</div></section><section id="work"><div className="section-head"><div><span className="eyebrow">SELECTED WORK</span><h2>精选案例</h2></div></div><div className="grid">{works.map(item => <article className="card" key={item.title}><div className="cover"/><span className="project-no">{item.tag}</span><h3 style={{marginTop:16}}>{item.title}</h3></article>)}</div></section><section id="team" className="panel" style={{marginTop:50}}><span className="eyebrow">WHO WE ARE</span><h2>一个认真玩创意的小团队。</h2><p className="muted">我们由设计师、策略师和开发者组成。不同背景，同一种好奇心：把模糊的问题变成鲜明的答案。</p><div className="stat-row"><span className="badge">开放协作</span><span className="badge">重视细节</span><span className="badge">保持好奇</span></div></section><section id="contact" className="hero"><span className="eyebrow">START A CONVERSATION</span><h2>下个好项目，从一句你好开始。</h2><a className="button" href="mailto:hello@example.com">hello@example.com ↗</a></section><footer className="footer">© 2026 FORM / FUNCTION · 请将案例和联系方式换成你的内容</footer></main>; }
`;

const taskBoard = String.raw`
import { useEffect, useMemo, useState } from 'react';
type Stage = '待办' | '进行中' | '已完成'; type Priority = '普通' | '重要' | '紧急'; type Task = { id: string; title: string; stage: Stage; priority: Priority };
const key = 'pivloom-task-board-v1'; const stages: Stage[] = ['待办', '进行中', '已完成'];
function load(): Task[] { try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
export default function App() { const [tasks, setTasks] = useState<Task[]>(load); const [title, setTitle] = useState(''); const [priority, setPriority] = useState<Priority>('普通'); const [search, setSearch] = useState(''); const [filter, setFilter] = useState('全部');
  useEffect(() => { localStorage.setItem(key, JSON.stringify(tasks)); }, [tasks]); const shown = useMemo(() => tasks.filter(task => task.title.toLowerCase().includes(search.toLowerCase()) && (filter === '全部' || task.priority === filter)), [tasks, search, filter]);
  function add(event: React.FormEvent) { event.preventDefault(); if (!title.trim()) return; setTasks(list => [{ id: crypto.randomUUID(), title: title.trim(), priority, stage: '待办' }, ...list]); setTitle(''); }
  return <main className="shell tasks"><header className="top"><span className="brand">flowboard / 01</span><nav><a href="#board">看板</a><a href="#new">新任务</a></nav></header><section className="hero"><span className="eyebrow">PLAN · FOCUS · FINISH</span><h1>专注眼前，<br/>完成更多。</h1><p>把待办、进行中和完成的事放在同一张清晰的看板上，让每一步进展都看得见。</p><div className="stat-row">{stages.map(stage => <div className="stat" key={stage}><strong>{tasks.filter(task => task.stage === stage).length}</strong><small>{stage}</small></div>)}</div></section><section id="new" className="panel"><h2>添加新任务</h2><form onSubmit={add}><div className="form-grid"><label className="field">任务名称<input value={title} onChange={event => setTitle(event.target.value)} placeholder="下一步要完成什么？" required /></label><label className="field">优先级<select value={priority} onChange={event => setPriority(event.target.value as Priority)}><option>普通</option><option>重要</option><option>紧急</option></select></label></div><div className="form-actions"><button className="primary" type="submit">加入看板 →</button></div></form></section><section id="board"><div className="section-head"><div><span className="eyebrow">YOUR WORKFLOW</span><h2>任务看板</h2></div></div><div className="toolbar"><input className="search" aria-label="搜索任务" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务"/><select aria-label="筛选优先级" value={filter} onChange={event => setFilter(event.target.value)}><option>全部</option><option>普通</option><option>重要</option><option>紧急</option></select></div><div className="columns">{stages.map(stage => <div className="column" key={stage}><span className="eyebrow">{stage} / {shown.filter(task => task.stage === stage).length}</span>{shown.filter(task => task.stage === stage).map(task => <article className="row" key={task.id}><strong>{task.title}</strong><div className="row-actions"><span className="badge">{task.priority}</span><select aria-label={task.title + ' 状态'} value={task.stage} onChange={event => setTasks(list => list.map(item => item.id === task.id ? {...item, stage: event.target.value as Stage} : item))}>{stages.map(value => <option key={value}>{value}</option>)}</select><button className="mini danger" onClick={() => setTasks(list => list.filter(item => item.id !== task.id))}>删除</button></div></article>)}</div>)}</div></section><footer className="footer">flowboard · 你的任务只保存在此浏览器</footer></main>; }
`;

const applications: Record<StarterSlug, string> = {
  "event-signup": eventSignup, "reading-list": readingList, portfolio,
  appointments, "creative-studio": creativeStudio, "task-board": taskBoard,
};

export function starterSource(slug: StarterSlug, title: string): Record<string, string> {
  const localData = ["event-signup", "reading-list", "appointments", "task-board"].includes(slug);
  const serverData = slug === "event-signup" || slug === "appointments";
  return {
    "index.html": '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>' + title + '</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    "src/App.tsx": applications[slug],
    "src/style.css": common.replaceAll("{", " {\n  ").replaceAll(";", ";\n  ").replaceAll("}", "\n}\n"),
    ...(serverData ? { "src/pivloom-data.ts": managedData,
      "pivloom.data.json": JSON.stringify({ schemaVersion: 1, kind: slug, collection: slug === "event-signup" ? "registrations" : "bookings" }, null, 2) + "\n" } : {}),
    "README.md": `# ${title}\n\n这是可编辑的 React + Vite 模板源码。项目可在 Pivloom 中预览和发布；本地运行可执行 \`npm ci\`、\`npm run build\`、\`npm run preview\`。\n\n${serverData
      ? "Preview 的示例记录保存在当前浏览器。通过 Pivloom 发布后，访客提交写入项目专属的托管数据，项目主人在工作台管理；Preview 记录不会自动导入线上。项目源码版本回滚不会删除线上记录。"
      : localData ? "数据保存在当前访问者的浏览器 localStorage 中，不会跨设备或跨用户共享。需要共享数据时，请继续为项目添加后端。"
      : "页面中的示例文案、案例和联系邮箱请在发布前替换为自己的内容。"}\n`,
  };
}
