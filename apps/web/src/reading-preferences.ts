import { useState } from "react";

export type ReadingPreferences = {
  theme: "auto" | "light" | "dark";
  font: "serif" | "sans";
  size: number;
  leading: number;
};
export const defaultReading: ReadingPreferences = {
  theme: "auto",
  font: "serif",
  size: 19,
  leading: 1.7,
};
export function readingPreferences(
  value: Partial<ReadingPreferences>,
): ReadingPreferences {
  return {
    theme:
      value.theme === "light" || value.theme === "dark" ? value.theme : "auto",
    font: value.font === "sans" ? "sans" : "serif",
    size: Number.isFinite(value.size)
      ? Math.max(14, Math.min(28, Math.round(value.size!)))
      : 19,
    leading: [1.55, 1.7, 1.85].includes(value.leading!) ? value.leading! : 1.7,
  };
}
// Only presentation preferences, partitioned by account; no reading content.
export function useReadingPreferences(user: string) {
  const key = `palimora:reading:${user}`;
  const [preferences, setPreferences] = useState<ReadingPreferences>(() => {
    try {
      return readingPreferences(
        JSON.parse(localStorage.getItem(key) ?? "{}") ?? {},
      );
    } catch {
      return { ...defaultReading };
    }
  });
  const [persistent, setPersistent] = useState(true);
  const save = (value: Partial<ReadingPreferences>) => {
    const next = readingPreferences({ ...preferences, ...value });
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setPersistent(true);
    } catch {
      setPersistent(false);
    }
  };
  return { preferences, save, persistent };
}
