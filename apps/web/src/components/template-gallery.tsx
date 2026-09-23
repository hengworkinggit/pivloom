"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Globe2, LayoutGrid, Moon, Search, Sun } from "lucide-react";
import { Brand } from "./brand";
import { Button } from "./ui/button";
import { useWorkspaceAuth } from "@/lib/use-workspace";
import { useUiPreferences } from "@/lib/ui-preferences";
import { findTemplate, templates, type StarterTemplate } from "@/lib/templates";

function TemplateHeader() {
  const ui = useUiPreferences();
  const { status } = useWorkspaceAuth();
  return <header className="template-header"><Brand /><nav aria-label={ui.text("主导航", "Main navigation")}><Link href="/templates" className="active">{ui.text("模板", "Templates")}</Link><Link href="/projects">{ui.text("我的项目", "Projects")}</Link></nav><div className="template-header-actions"><button className="header-control" aria-label={ui.locale === "zh" ? "切换到英文" : "Switch to Chinese"} onClick={() => ui.setLocale(ui.locale === "zh" ? "en" : "zh")}><Globe2 size={15} />{ui.locale === "zh" ? "EN" : "中文"}</button><button className="header-control" aria-label={ui.theme === "light" ? ui.text("切换深色模式", "Switch to dark mode") : ui.text("切换浅色模式", "Switch to light mode")} onClick={() => ui.setTheme(ui.theme === "light" ? "dark" : "light")}>{ui.theme === "light" ? <Moon size={16} /> : <Sun size={16} />}</button>{status === "authenticated" ? <Link className="template-signin" href="/settings/account">{ui.text("账户", "Account")}</Link> : <><Link className="template-signin" href="/login">{ui.text("登录", "Sign in")}</Link><Link className="template-register" href="/register">{ui.text("注册", "Sign up")}</Link></>}</div></header>;
}

/** Original miniature product scenes: a visible example, never a generated screenshot claim. */
export function TemplateArtwork({ template }: { template: StarterTemplate }) {
  const ui = useUiPreferences();
  const title = ui.locale === "en" ? template.titleEn : template.title;
  return <div className={`template-art template-art-${template.motif}`} aria-label={ui.text(`${title} 模板预览`, `${title} template preview`)}>
    <div className="art-browser"><span /><span /><span /><i>{template.motif === "portfolio" || template.motif === "studio" ? "folio.studio" : template.motif === "books" ? "reading.room" : "my.workspace"}</i></div>
    {template.motif === "event" && <div className="art-event"><div className="art-event-head"><small>THE GATHERING</small><b>{ui.text("让每次相遇，都值得期待。", "Gather. Connect. Create.")}</b><em>{ui.text("周末创意沙龙 · 5 月 24 日", "Creative meet-up · May 24")}</em></div><div className="art-event-card"><span>{ui.text("立即报名", "Join the event")}</span><div className="art-fake-input" /><div className="art-fake-input short" /><div className="art-fake-button" /></div></div>}
    {template.motif === "books" && <div className="art-books"><div className="art-books-copy"><small>THE READING ROOM</small><b>{ui.text("在书页之间，找到下一站。", "Your next chapter awaits.")}</b><span>{ui.text("正在读 · 12 本精选", "Currently reading · 12 picks")}</span></div><div className="art-book-spines"><i /><i /><i /><i /><i /></div></div>}
    {template.motif === "portfolio" && <div className="art-portfolio"><div className="art-portfolio-head"><small>J. LIN — DESIGNER</small><b>{ui.text("创造有温度的数字体验。", "Design that feels human.")}</b><span>SELECTED WORK / 2026</span></div><div className="art-portfolio-grid"><i /><i /><i /></div></div>}
    {template.motif === "booking" && <div className="art-booking"><small>APPOINTMENT STUDIO</small><b>{ui.text("预约属于你的时间。", "Make time for what matters.")}</b><div className="art-calendar"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><i>12</i><i>13</i><i className="chosen">14</i><i>15</i><i>16</i></div><div className="art-slot">09:00　11:30　14:00</div></div>}
    {template.motif === "studio" && <div className="art-studio"><small>FORM / FUNCTION</small><b>MAKE<br />THINGS<br /><em>MATTER.</em></b><span>{ui.text("创意从一个好问题开始。", "Good work begins with a question.")}</span><div className="art-studio-circle" /></div>}
    {template.motif === "tasks" && <div className="art-tasks"><small>FLOWBOARD / 01</small><b>{ui.text("专注眼前，完成更多。", "Make progress visible.")}</b><div className="art-task-columns"><div><strong>TO DO</strong><i /><i /></div><div><strong>DOING</strong><i /><i /></div><div><strong>DONE ✓</strong><i /><i /></div></div></div>}
  </div>;
}

const categories = ["all", "business", "personal", "content"] as const;
type Category = typeof categories[number];

export function TemplatesPage() {
  const ui = useUiPreferences();
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const shown = templates.filter((template) => (category === "all" || template.category === category) && `${template.title} ${template.titleEn} ${template.description} ${template.descriptionEn}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const names: Record<Category, [string, string]> = { all: ["全部", "All"], business: ["业务工具", "Business"], personal: ["个人网站", "Personal"], content: ["内容管理", "Content"] };
  return <div className="templates-page"><TemplateHeader /><main className="templates-main"><div className="templates-intro"><div className="section-eyebrow"><LayoutGrid size={13} /> MADE TO INSPIRE</div><h1>{ui.text("从一个好例子开始。", "Start with a good example.")}</h1><p>{ui.text("先看看模板长什么样，再把它变成你的项目。", "Explore a real preview, then make the idea your own.")}</p></div><div className="templates-tools"><nav aria-label={ui.text("模板分类", "Template categories")}>{categories.map((item) => <button key={item} type="button" className={category === item ? "selected" : ""} aria-pressed={category === item} onClick={() => setCategory(item)}>{ui.text(...names[item])}</button>)}</nav><label className="template-search"><Search size={16} /><span className="sr-only">{ui.text("搜索模板", "Search templates")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={ui.text("搜索模板", "Search templates")} /></label></div><div className="template-grid">{shown.map((template) => <Link href={`/templates/${template.slug}`} className="template-tile" key={template.slug}><TemplateArtwork template={template} /><div className="template-tile-footer"><div><span>{ui.text(template.category === "business" ? "业务工具" : template.category === "personal" ? "个人网站" : "内容管理", template.category)}</span><h2>{ui.text(template.title, template.titleEn)}</h2></div><ArrowUpRight size={18} /></div></Link>)}</div>{shown.length === 0 && <div className="template-no-results">{ui.text("没有找到模板，试试别的关键词。", "No templates found. Try another search.")}</div>}</main></div>;
}

export function TemplateDetail({ slug }: { slug: string }) {
  const ui = useUiPreferences();
  const template = findTemplate(slug);
  if (!template) return <div className="templates-page"><TemplateHeader /><main className="templates-main"><h1>{ui.text("模板不存在", "Template not found")}</h1><Link href="/templates">{ui.text("返回模板", "Back to templates")}</Link></main></div>;
  return <div className="templates-page"><TemplateHeader /><main className="template-detail-main"><Link className="settings-back" href="/templates"><ArrowLeft size={15} />{ui.text("全部模板", "All templates")}</Link><div className="template-detail-heading"><div><div className="section-eyebrow">TEMPLATE / {template.category.toUpperCase()}</div><h1>{ui.text(template.title, template.titleEn)}</h1><p>{ui.text(template.description, template.descriptionEn)}</p></div><Button asChild><Link href={`/projects?template=${encodeURIComponent(template.slug)}`}>{ui.text("使用这个模板", "Use this template")}<ArrowRight size={16} /></Link></Button></div><div className="template-detail-preview"><TemplateArtwork template={template} /></div><div className="template-detail-bottom"><div><h2>{ui.text("模板包含", "What's included")}</h2><ul>{(ui.locale === "en" ? template.featuresEn : template.features).map((feature) => <li key={feature}><Check size={15} />{feature}</li>)}</ul></div><div className="template-prompt"><small>{ui.text("开始时会放入你的需求草稿", "Added to your prompt draft")}</small><p>{ui.text(template.prompt, template.promptEn)}</p></div></div></main></div>;
}
