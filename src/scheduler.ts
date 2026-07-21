import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { HOME_ROOT } from "./config.js";

// In-process scheduler: tasks fire while adhd is running (not a background
// daemon). `at` is either "HH:MM" (daily) or "every 30m" / "every 2h".
export const SCHEDULE_FILE = join(HOME_ROOT, "schedule.json");

export type Task = { id: string; at: string; prompt: string };

export function loadSchedule(): Task[] {
  if (!existsSync(SCHEDULE_FILE)) return [];
  try {
    const v = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
    return Array.isArray(v) ? v.filter((t) => t?.id && t?.at && t?.prompt) : [];
  } catch {
    return [];
  }
}

export function saveSchedule(tasks: Task[]) {
  mkdirSync(HOME_ROOT, { recursive: true });
  writeFileSync(SCHEDULE_FILE, JSON.stringify(tasks, null, 2));
}

type Parsed = { kind: "daily"; h: number; m: number } | { kind: "interval"; ms: number } | null;

export function parseAt(at: string): Parsed {
  const hm = at.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) return { kind: "daily", h: +hm[1], m: +hm[2] };
  const iv = at.match(/^every\s+(\d+)\s*([mh])$/i);
  if (iv) return { kind: "interval", ms: +iv[1] * (iv[2].toLowerCase() === "h" ? 3600 : 60) * 1000 };
  return null;
}

export function isDue(task: Task, now: Date, lastRun?: number): boolean {
  const p = parseAt(task.at);
  if (!p) return false;
  if (p.kind === "interval") return lastRun === undefined || now.getTime() - lastRun >= p.ms;
  // daily: fire once when the clock hits HH:MM (guard against re-firing in the
  // same minute via lastRun).
  const match = now.getHours() === p.h && now.getMinutes() === p.m;
  return match && (lastRun === undefined || now.getTime() - lastRun > 60_000);
}

export function scheduleTools(): Record<string, Tool> {
  return {
    schedule: tool({
      description:
        "Manage scheduled tasks that auto-run while adhd is open. action 'add' needs id, at ('HH:MM' daily or 'every 30m'), and prompt. action 'list' returns current tasks. action 'remove' needs id.",
      inputSchema: z.object({
        action: z.enum(["add", "list", "remove"]),
        id: z.string().optional(),
        at: z.string().optional(),
        prompt: z.string().optional(),
      }),
      execute: async ({ action, id, at, prompt }) => {
        const tasks = loadSchedule();
        if (action === "list")
          return tasks.map((t) => `${t.id} @ ${t.at}: ${t.prompt}`).join("\n") || "(no scheduled tasks)";
        if (action === "remove") {
          saveSchedule(tasks.filter((t) => t.id !== id));
          return `removed ${id}`;
        }
        // add
        if (!id || !at || !prompt) return "add needs id, at, and prompt";
        if (!parseAt(at)) return `bad 'at' — use 'HH:MM' or 'every 30m', got "${at}"`;
        saveSchedule([...tasks.filter((t) => t.id !== id), { id, at, prompt }]);
        return `scheduled ${id} @ ${at}`;
      },
    }),
  };
}
