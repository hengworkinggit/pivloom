import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function relativeTime(value: string) {
  const minutes = Math.max(0, (Date.now() - Date.parse(value)) / 60_000);
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${Math.floor(minutes)} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 2880) return "昨天";
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "暂时无法完成，请重试。";
}
