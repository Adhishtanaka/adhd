// Long tool calls must not hold the turn open.
//
// A tool whose work passes its deadline hands the model back a "backgrounded"
// note instead of a result, so the model ends its turn immediately: `busy` goes
// false, the spinner stops, and the user can chat again while the work runs on.
// When the work finally lands, the finish sink wakes the agent with the result
// as a fresh turn (see drainJobs in web.ts).
//
// ponytail: the work keeps running as a floating promise rather than being
// split into start/poll halves — the AI SDK awaits execute(), and racing it is
// the whole trick. The ceiling is that a backgrounded job can't be cancelled and
// dies with the process; add a job store if either starts to matter.

export type FinishedJob = { id: string; label: string; result: string; seconds: number };

let onFinish: (j: FinishedJob) => void = () => {};
let onStart: (id: string, label: string) => void = () => {};
export function setJobSinks(finish: (j: FinishedJob) => void, start: (id: string, label: string) => void): void {
  onFinish = finish;
  onStart = start;
}

let seq = 0;
const running = new Map<string, string>(); // id → label, for the "what's still going" view
export function runningJobs(): { id: string; label: string }[] {
  return [...running].map(([id, label]) => ({ id, label }));
}

// Reset between tests; not used by the app.
export function _resetJobs(): void {
  seq = 0;
  running.clear();
}

const TIMED_OUT = Symbol("timed-out");

/**
 * Run `work` with a deadline. Resolves to the real result if it finishes in
 * time; otherwise backgrounds it and resolves to an instruction telling the
 * model to end its turn. Never rejects — a tool result must always be a string.
 */
export async function withDeadline(label: string, ms: number, work: () => Promise<string>): Promise<string> {
  const started = Date.now();
  // Start it, and swallow rejections into the same string channel so neither the
  // race nor the background continuation can produce an unhandled rejection.
  const settled = work().then(
    (v) => v,
    (e: unknown) => `failed: ${(e as Error)?.message ?? String(e)}`,
  );

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => r(TIMED_OUT), ms);
  });
  const winner = await Promise.race([settled, deadline]);
  clearTimeout(timer!);
  if (winner !== TIMED_OUT) return winner as string;

  const id = `job${++seq}`;
  running.set(id, label);
  onStart(id, label);
  void settled.then((result) => {
    running.delete(id);
    onFinish({ id, label, result, seconds: Math.round((Date.now() - started) / 1000) });
  });
  return (
    `Still running after ${Math.round(ms / 1000)}s — moved to the background as ${id} ("${label}"). ` +
    `You do NOT have the result yet. Do NOT retry this call, do NOT call another tool to get the same thing, ` +
    `and do NOT wait. End your turn NOW with one short line telling the user it's still running and you'll ` +
    `report back. The result will be delivered to you automatically as a new turn the moment it lands.`
  );
}
