export interface StarterTemplate {
  slug: string;
  title: string;
  titleEn: string;
  category: "business" | "personal" | "content";
  description: string;
  descriptionEn: string;
  prompt: string;
  promptEn: string;
  features: string[];
  featuresEn: string[];
  motif: "event" | "books" | "portfolio" | "booking" | "studio" | "tasks";
}

export const templates: StarterTemplate[] = [
  { slug: "event-signup", title: "活动报名", titleEn: "Event signup", category: "business", motif: "event",
    description: "收集报名、筛选状态，让每一位参与者都有着落。", descriptionEn: "Collect registrations and keep every attendee organized.",
    prompt: "做一个中文活动报名管理网页。包含姓名、邮箱和活动类别表单，支持必填与邮箱校验、报名列表、确认状态、搜索和筛选，并显示总报名数与已确认数。使用浏览器本地存储保存记录，适配手机屏幕。",
    promptEn: "Build an event registration dashboard with name, email and category fields, validation, a searchable and filterable attendee list, confirmation status, summary counts, local persistence and mobile layout.",
    features: ["报名表单", "状态筛选", "人数统计"], featuresEn: ["Signup form", "Status filters", "Attendee totals"] },
  { slug: "reading-list", title: "读书清单", titleEn: "Reading list", category: "content", motif: "books",
    description: "把想读和已读的书放在同一个温暖的书架。", descriptionEn: "A calm shelf for the books you want to read and finish.",
    prompt: "做一个温暖简洁的读书清单网页。可以添加书籍、作者，管理想读/在读/已读状态，支持搜索与筛选、阅读进度统计及浏览器本地保存。",
    promptEn: "Create a warm reading list app with book and author entry, want-to-read/reading/finished states, search, filters, reading progress and local persistence.",
    features: ["书籍管理", "阅读状态", "搜索筛选"], featuresEn: ["Book library", "Reading states", "Search & filters"] },
  { slug: "portfolio", title: "个人作品集", titleEn: "Personal portfolio", category: "personal", motif: "portfolio",
    description: "用项目、经历和联系方式讲好自己的故事。", descriptionEn: "Tell your story through selected work, experience and contact.",
    prompt: "做一个有设计感、可在手机和电脑上浏览的个人作品集。展示简介、精选项目卡片、技能、经历和联系方式，包含清晰的导航与联系按钮。",
    promptEn: "Build a polished responsive portfolio with an introduction, selected project cards, skills, experience, clear navigation and a contact action.",
    features: ["项目画廊", "个人简介", "联系入口"], featuresEn: ["Project gallery", "About section", "Contact action"] },
  { slug: "appointments", title: "预约排期", titleEn: "Appointment planner", category: "business", motif: "booking",
    description: "把开放时段、预约信息与确认状态收在一处。", descriptionEn: "Manage open slots, bookings and confirmations in one place.",
    prompt: "做一个预约排期网页，提供可选日期和时间段、姓名与联系方式表单、预约列表、状态确认和本地保存，布局适配手机。",
    promptEn: "Create an appointment planner with available date and time slots, a contact form, a booking list, confirmation status, local persistence and mobile layout.",
    features: ["时间选择", "预约列表", "确认状态"], featuresEn: ["Time slots", "Booking list", "Confirmation"] },
  { slug: "creative-studio", title: "创意工作室", titleEn: "Creative studio", category: "personal", motif: "studio",
    description: "用大胆的版式展示服务、案例和团队气质。", descriptionEn: "A bold showcase for services, case studies and your team.",
    prompt: "做一个现代创意工作室网站，包含鲜明的首页主视觉、服务介绍、精选案例、团队简介和联系入口，带响应式布局。",
    promptEn: "Build a modern creative studio site with a striking hero, services, selected work, team introduction, contact action and responsive layout.",
    features: ["品牌首页", "服务介绍", "案例展示"], featuresEn: ["Brand hero", "Services", "Case studies"] },
  { slug: "task-board", title: "任务看板", titleEn: "Task board", category: "business", motif: "tasks",
    description: "从待办到完成，把日常计划看得一清二楚。", descriptionEn: "Move everyday plans from to-do to done with clarity.",
    prompt: "做一个轻量任务看板，支持新增任务、待办/进行中/已完成分组、优先级、搜索筛选和本地保存，桌面与手机都易用。",
    promptEn: "Create a lightweight task board with task creation, to-do/in-progress/done groups, priorities, search, filters, local persistence and responsive layout.",
    features: ["任务分组", "优先级", "进度概览"], featuresEn: ["Task groups", "Priorities", "Progress overview"] },
];

export const featuredTemplates = templates.slice(0, 3);
export function findTemplate(slug: string) { return templates.find((template) => template.slug === slug); }
