import { tool, type Tool } from "ai";
import { z } from "zod";

// A checklist the agent keeps while it works on something multi-step, so the
// person watching can see the plan and where it's up to instead of inferring it
// from a stream of tool calls.
//
// This is loop.ts's spec_set/spec_check idea (which only ever existed inside
// loop_task) brought into ordinary chat. Kept separate rather than shared: the
// loop's checklist gates when the loop ENDS, this one is purely for showing the
// work, and merging them would tie a UI concern to a control-flow one.
//
// One list at a time, in RAM. adhd runs exactly one turn at a time (web.ts gates
// everything on `busy`), so this module only ever describes the turn in flight;
// web.ts swaps the owning session's list in at the start of a turn and takes it
// back at the end, which is what keeps two browsers from sharing a checklist.
export type TodoItem = { title: string; status: "pending" | "doing" | "done" };

let items: TodoItem[] = [];
let notify: (items: TodoItem[]) => void = () => {};

export const todoItems = (): TodoItem[] => items;
export function setTodoSink(fn: (items: TodoItem[]) => void): void {
  notify = fn;
}
/** New chat: drop the list so a stale plan doesn't outlive its task. */
export function resetTodos(): void {
  items = [];
  notify(items);
}
/**
 * Make `next` the live list, without notifying. Used to swap the owning
 * session's checklist in as its turn begins: the sink is fire-and-forget to
 * whoever is listening, and announcing the swap would replay one session's plan
 * into another's transcript.
 */
export function loadTodos(next: TodoItem[]): void {
  items = next;
}

export function todoTools(): Record<string, Tool> {
  return {
    todo_write: tool({
      description:
        "Show the user your plan for a multi-step task, and keep it current. Call this once with the whole list when you start, " +
        "then again whenever a step's status changes — mark exactly one item 'doing' at a time and 'done' the moment it's finished. " +
        "Skip it for anything you'll finish in one or two steps; a checklist for a single lookup is noise.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              title: z.string().describe("short imperative phrase, e.g. 'Check the flight prices'"),
              status: z.enum(["pending", "doing", "done"]),
            }),
          )
          .describe("the full list, every call — it replaces the previous one"),
      }),
      execute: async ({ items: next }) => {
        items = next;
        notify(items);
        const done = items.filter((i) => i.status === "done").length;
        return `${done}/${items.length} done`;
      },
    }),
  };
}
