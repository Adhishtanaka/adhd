import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { ROOTS } from "./config.js";

export type Skill = { name: string; description: string; body: string };

// Parse minimal YAML frontmatter (name/description) + body. No YAML dep needed.
export function parseSkill(md: string, fallbackName: string): Skill {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { name: fallbackName, description: "", body: md.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const c = line.indexOf(":");
    if (c === -1) continue;
    meta[line.slice(0, c).trim()] = line
      .slice(c + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return {
    name: meta.name || fallbackName,
    description: meta.description || "",
    body: m[2].trim(),
  };
}

export function loadSkills(): Record<string, Skill> {
  const out: Record<string, Skill> = {};
  for (const root of ROOTS) {
    const dir = join(root, "skills");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      out[name] = parseSkill(readFileSync(file, "utf8"), name);
    }
  }
  return out;
}

export function skillsPromptSection(skills: Record<string, Skill>): string {
  const list = Object.values(skills);
  if (!list.length) return "";
  const lines = list.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n\nAvailable skills (call use_skill with the name to load full instructions):\n${lines}`;
}

export function useSkillTool(skills: Record<string, Skill>): Tool {
  return tool({
    description:
      "Load a skill's full instructions into context by name. Call before doing a task a skill covers.",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const s = skills[name];
      if (!s) return `no skill named "${name}". Available: ${Object.keys(skills).join(", ") || "(none)"}`;
      return s.body;
    },
  });
}
