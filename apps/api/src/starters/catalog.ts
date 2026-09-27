import { GroupedPlanSchema, type GroupedPlan } from "@pivloom/contracts";

export const starterSlugs = ["event-signup", "reading-list", "portfolio", "appointments", "creative-studio", "task-board"] as const;
export type StarterSlug = typeof starterSlugs[number];

type Starter = { title: string; goal: string; behaviors: readonly [string, string, string, string, string] };

const starters: Record<StarterSlug, Starter> = {
  "event-signup": { title: "活动报名", goal: "管理活动报名和确认状态", behaviors: [
    "填写姓名、邮箱和类别后新增报名记录", "拒绝空字段和无效邮箱", "搜索并按确认状态筛选报名记录", "切换报名确认状态并更新统计", "刷新页面后保留报名记录",
  ] },
  "reading-list": { title: "读书清单", goal: "管理阅读清单和阅读进度", behaviors: [
    "填写书名和作者后新增书籍", "在想读、在读和已读之间切换状态", "按书名或作者搜索并筛选状态", "根据已读书籍显示进度统计", "刷新页面后保留书籍与状态",
  ] },
  portfolio: { title: "个人作品集", goal: "展示个人介绍、作品、技能和联系入口", behaviors: [
    "首页展示个人介绍", "作品区域展示精选项目", "展示技能和工作经历", "导航可以定位到对应区域", "联系入口可打开邮件客户端",
  ] },
  appointments: { title: "预约排期", goal: "管理可用时段和预约确认", behaviors: [
    "选择日期、时段并提交预约人信息", "阻止同一日期时段重复预约", "展示按日期排序的预约列表", "切换预约确认状态", "刷新页面后保留预约记录",
  ] },
  "creative-studio": { title: "创意工作室", goal: "展示工作室的服务、作品、团队和联系入口", behaviors: [
    "首页展示品牌主视觉和简介", "服务区域展示服务类型", "案例区域展示精选作品", "团队区域展示成员介绍", "联系入口可打开邮件客户端",
  ] },
  "task-board": { title: "任务看板", goal: "按进度和优先级管理任务", behaviors: [
    "填写任务名称和优先级后新增任务", "任务可在待办、进行中和已完成之间移动", "按关键词和优先级筛选任务", "显示各状态任务数量", "刷新页面后保留任务与状态",
  ] },
};

export function starter(slug: string): Starter | undefined {
  return Object.hasOwn(starters, slug) ? starters[slug as StarterSlug] : undefined;
}

export function starterPlan(slug: StarterSlug): GroupedPlan {
  const item = starters[slug];
  const behaviors = item.behaviors.map((title, index) => ({
    id: `B0${index + 1}`, title, precondition: "打开项目应用", action: title,
    expected: title, required: true,
  }));
  return GroupedPlanSchema.parse({
    schemaVersion: 2, goal: item.goal, changeSummary: `从${item.title}模板创建可编辑项目`,
    assumptions: [], outOfScope: [], replacements: [], behaviors,
    groups: item.behaviors.map((title, index) => ({ id: `G${index + 1}`, title, behaviorIds: [`B0${index + 1}`] })),
  });
}
