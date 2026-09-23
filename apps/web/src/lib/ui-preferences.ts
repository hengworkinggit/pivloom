"use client";

import { useEffect, useSyncExternalStore } from "react";

export type Locale = "zh" | "en";
export type Theme = "light" | "dark";
type Preferences = Readonly<{ locale: Locale; theme: Theme }>;

const key = "pivloom.appearance.v1";
const initial: Preferences = { locale: "zh", theme: "light" };
let current: Preferences = initial;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: Preferences) {
  current = next;
  if (typeof document !== "undefined") {
    document.documentElement.lang = next.locale === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.theme = next.theme;
    document.documentElement.style.colorScheme = next.theme;
  }
  listeners.forEach((listener) => listener());
}

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? "{}") as Partial<Preferences>;
    publish({ locale: saved.locale === "en" ? "en" : "zh", theme: saved.theme === "dark" ? "dark" : "light" });
  } catch { publish(initial); }
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function getSnapshot() { return current; }
function getServerSnapshot() { return initial; }

export function useUiPreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    load();
    const onStorage = (event: StorageEvent) => { if (event.key === key) { loaded = false; load(); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  function update(next: Preferences) {
    publish(next);
    try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep this tab usable without storage. */ }
  }
  return {
    ...preferences,
    setLocale: (locale: Locale) => update({ ...current, locale }),
    setTheme: (theme: Theme) => update({ ...current, theme }),
    text: (zh: string, en: string) => preferences.locale === "en" ? en : zh,
  };
}
