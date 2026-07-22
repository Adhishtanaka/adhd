// Flows page: a React Flow canvas for building workflows adhd can run.
//
// Loaded as a module (importmap in index.html) with its own React copy — this is
// a separate root from the UMD React app.js uses for the spec renderer, so the
// two never share state. Everything here talks to /flows, /flows/run,
// /flows/control and the `flow` SSE events app.js forwards via window.onFlowEvent.
//
// Node semantics (n8n-style, NOT an agent): a node is a function. A prompt node
// is one model call with no tools; a tool node runs exactly one tool. Output
// flows along the edges — {{prev}} in any field is the previous node's output.
import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";

const h = React.createElement;
const uid = () => Math.random().toString(36).slice(2, 9);
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- node types ------------------------------------------------------------
const dot = { width: 8, height: 8, background: "rgb(var(--c-accent))", border: "none" };
const excerpt = (s, n = 60) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : "");

// _s is the live run status stamped on by the page (running / ok / error).
const BORDER = { running: "border-signal", ok: "border-done", error: "border-bad" };
const shellCls = (data, selected) =>
  `rounded-xl border bg-surface px-3 py-2 text-xs min-w-[160px] max-w-[220px] ${
    BORDER[data._s] || (selected ? "border-signal" : "border-line")
  } ${data._s === "running" ? "animate-pulse" : ""}`;

const kindLabel = (data, kind) =>
  h("div", { className: "font-mono text-[10px] text-dim mb-1 flex justify-between gap-2" },
    h("span", null, kind),
    data._ms != null ? h("span", null, `${(data._ms / 1000).toFixed(1)}s`) : null,
  );

function PromptNode({ data, selected }) {
  return h(
    "div",
    { className: shellCls(data, selected) },
    h(Handle, { type: "target", position: Position.Left, style: dot }),
    kindLabel(data, "prompt"),
    h("div", { className: "text-paper" }, excerpt(data.prompt) || "(empty)"),
    h(Handle, { type: "source", position: Position.Right, style: dot }),
  );
}

function IfNode({ data, selected }) {
  return h(
    "div",
    { className: shellCls(data, selected) },
    h(Handle, { type: "target", position: Position.Left, style: dot }),
    kindLabel(data, "if / else"),
    h("div", { className: "text-paper" }, excerpt(data.question) || "(no question)"),
    h("div", { className: "mt-2 flex flex-col gap-1 items-end font-mono text-[10px]" },
      h("span", { className: data._branch === "yes" ? "text-done" : "text-dim" }, "yes"),
      h("span", { className: data._branch === "no" ? "text-done" : "text-dim" }, "no"),
    ),
    // Two outputs; the runner follows the edge whose sourceHandle matches the answer.
    h(Handle, { id: "yes", type: "source", position: Position.Right, style: { ...dot, top: "auto", bottom: 26 } }),
    h(Handle, { id: "no", type: "source", position: Position.Right, style: { ...dot, top: "auto", bottom: 8 } }),
  );
}

function ToolNode({ data, selected }) {
  return h(
    "div",
    { className: shellCls(data, selected) },
    h(Handle, { type: "target", position: Position.Left, style: dot }),
    kindLabel(data, "tool"),
    h("div", { className: "text-paper font-mono" }, data.tool || "(pick a tool)"),
    h(Handle, { type: "source", position: Position.Right, style: dot }),
  );
}

// Start/End are markers: Start is where the run begins, End stops it. They make
// the entry point explicit instead of "whichever node nothing points at".
function StartNode({ data }) {
  return h(
    "div",
    { className: `rounded-full border px-4 py-2 text-xs font-mono ${BORDER[data._s] || "border-done"} bg-surface text-done` },
    "start",
    h(Handle, { type: "source", position: Position.Right, style: dot }),
  );
}
function EndNode({ data }) {
  return h(
    "div",
    { className: `rounded-full border px-4 py-2 text-xs font-mono ${BORDER[data._s] || "border-line"} bg-surface text-dim` },
    h(Handle, { type: "target", position: Position.Left, style: dot }),
    "end",
  );
}

const nodeTypes = { start: StartNode, prompt: PromptNode, if: IfNode, tool: ToolNode, end: EndNode };

// ---- inspector -------------------------------------------------------------
const field = "w-full bg-raise border border-line rounded-lg px-2 py-1.5 text-xs text-paper outline-none focus:border-dim";
const btn = "px-2.5 py-1.5 rounded-lg border border-line text-xs hover:border-dim transition disabled:opacity-40";

function Inspector({ node, onChange, onDelete, toolNames, toolArgs }) {
  if (!node)
    return h(
      "div",
      { className: "p-4 text-xs text-dim space-y-2" },
      h("p", null, "Select a node to edit it."),
      h("p", null, "Each node is a step: it takes the previous node's output as input and passes its own on."),
      h("p", null, h("span", { className: "font-mono text-paper" }, "{{prev}}"), " in any field is replaced by that input. Without it, the input is appended."),
    );
  const d = node.data || {};
  const set = (patch) => onChange({ ...d, ...patch });
  const rows = [h("div", { key: "t", className: "font-mono text-[10px] text-dim" }, node.type)];

  if (node.type === "prompt")
    rows.push(
      h("textarea", {
        key: "p",
        className: field + " h-40 resize-none",
        placeholder: "What this step should produce. One model call, no tools.",
        value: d.prompt || "",
        onChange: (e) => set({ prompt: e.target.value }),
      }),
    );

  if (node.type === "if")
    rows.push(
      h("textarea", {
        key: "q",
        className: field + " h-24 resize-none",
        placeholder: "A yes/no question about the input, e.g. “does this mention rain?”",
        value: d.question || "",
        onChange: (e) => set({ question: e.target.value }),
      }),
    );

  if (node.type === "tool") {
    const args = d.args || {};
    // The fields come from the tool's own schema (served by /state), so there's
    // nothing to guess — required ones are marked, enums become dropdowns.
    const spec = toolArgs[d.tool] || [];
    rows.push(
      h(
        "select",
        { key: "s", className: field, value: d.tool || "", onChange: (e) => set({ tool: e.target.value, args: {} }) },
        h("option", { value: "" }, "pick a tool…"),
        toolNames.map((t) => h("option", { key: t, value: t }, t)),
      ),
      spec.length
        ? h("div", { key: "al", className: "text-[10px] text-dim" }, "{{prev}} inserts the previous node's output.")
        : null,
      ...spec.map((a) =>
        h(
          "label",
          { key: a.key, className: "flex flex-col gap-1" },
          h(
            "span",
            { className: "font-mono text-[10px] text-dim" },
            a.key,
            a.required ? h("span", { className: "text-bad" }, " *") : null,
            a.description ? h("span", { className: "font-sans normal-case" }, ` — ${a.description}`) : null,
          ),
          a.options
            ? h(
                "select",
                { className: field, value: args[a.key] ?? "", onChange: (e) => set({ args: { ...args, [a.key]: e.target.value } }) },
                h("option", { value: "" }, a.required ? "choose…" : "(default)"),
                a.options.map((o) => h("option", { key: o, value: o }, o)),
              )
            : h("textarea", {
                className: field + " resize-y h-16",
                value: args[a.key] ?? "",
                onChange: (e) => set({ args: { ...args, [a.key]: e.target.value } }),
              }),
        ),
      ),
    );
  }

  rows.push(h("button", { key: "del", className: btn + " text-bad border-bad/40", onClick: onDelete }, "Delete node"));
  return h("div", { className: "p-4 flex flex-col gap-2" }, rows);
}

// ---- run log ---------------------------------------------------------------
// One row per node with its duration and its actual output, collapsed. This is
// the "what happened" view — the tool-name firehose is gone with the agent.
function RunLog({ entries }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);
  if (!entries.length) return null;
  return h(
    "div",
    { ref, className: "h-40 overflow-y-auto border-t border-line p-2 text-[11px] font-mono space-y-1" },
    entries.map((e, i) =>
      h(
        "details",
        { key: i, className: "group" },
        h(
          "summary",
          { className: `cursor-pointer ${e.status === "error" ? "text-bad" : e.status === "running" ? "text-signal" : "text-dim"}` },
          `${e.icon} ${e.title}`,
          e.ms != null ? h("span", { className: "text-dim" }, `  ${(e.ms / 1000).toFixed(1)}s`) : null,
        ),
        e.body
          ? h("pre", { className: "whitespace-pre-wrap text-paper/80 pl-4 pt-1 max-h-48 overflow-y-auto" }, e.body)
          : null,
      ),
    ),
  );
}

// ---- page ------------------------------------------------------------------
function FlowsPage() {
  const [flows, setFlows] = useState([]);
  const [id, setId] = useState(null);
  const [name, setName] = useState("Untitled flow");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState(null);
  const [toolNames, setToolNames] = useState([]);
  const [toolArgs, setToolArgs] = useState({});
  const [entries, setEntries] = useState([]);
  const [runState, setRunState] = useState("idle"); // idle | running | paused
  const [marks, setMarks] = useState({}); // nodeId → { _s, _ms, _branch }

  useEffect(() => {
    fetch("/flows").then((r) => r.json()).then(setFlows);
    fetch("/state")
      .then((r) => r.json())
      .then((s) => {
        setToolNames(s.toolNames || []);
        setToolArgs(s.toolArgs || {});
      });

    const push = (e) => setEntries((l) => [...l.slice(-199), e]);
    const mark = (nid, patch) => setMarks((m) => ({ ...m, [nid]: { ...m[nid], ...patch } }));

    window.onFlowEvent = (ev) => {
      switch (ev.type) {
        case "run-start":
          setRunState("running");
          setMarks({});
          setEntries([{ icon: "▶", title: ev.name, status: "running" }]);
          break;
        case "node-start":
          mark(ev.id, { _s: "running", _ms: null, _branch: null });
          push({ icon: "▸", title: `${ev.kind} · ${excerpt(ev.label, 50)}`, status: "running" });
          break;
        case "node-done":
          mark(ev.id, { _s: "ok", _ms: ev.ms, _branch: ev.branch });
          setEntries((l) => {
            const last = l[l.length - 1];
            const done = { ...last, status: "ok", ms: ev.ms, body: ev.branch ? `→ ${ev.branch}` : ev.output };
            return [...l.slice(0, -1), done];
          });
          break;
        case "node-error":
          if (ev.id) mark(ev.id, { _s: "error", _ms: ev.ms });
          push({ icon: "✕", title: ev.message, status: "error", ms: ev.ms });
          break;
        case "run-done":
          setRunState("idle");
          push({ icon: "✔", title: "done", status: "ok", body: ev.output });
          break;
        case "run-stopped":
          setRunState("idle");
          push({ icon: "■", title: "stopped", status: "error" });
          break;
        case "state":
          setRunState(ev.state === "stopped" ? "idle" : ev.state);
          break;
      }
    };
  }, []);

  const open = (f) => {
    setId(f.id);
    setName(f.name);
    setNodes(f.nodes || []);
    setEdges(f.edges || []);
    setSelected(null);
    setMarks({});
  };
  // A new flow starts wired: start → end, so there's always an obvious entry.
  const blank = () => {
    const s = uid();
    const e = uid();
    setId(uid());
    setName("Untitled flow");
    setNodes([
      { id: s, type: "start", position: { x: 60, y: 160 }, data: {} },
      { id: e, type: "end", position: { x: 420, y: 160 }, data: {} },
    ]);
    setEdges([{ id: `${s}-${e}`, source: s, target: e }]);
    setSelected(null);
    setMarks({});
  };

  const add = (type) =>
    setNodes((ns) => [
      ...ns,
      {
        id: uid(),
        type,
        position: { x: 80 + ns.length * 60, y: 80 + ns.length * 90 },
        data: type === "tool" ? { tool: "", args: {} } : {},
      },
    ]);

  const onConnect = useCallback((c) => setEdges((es) => addEdge(c, es)), [setEdges]);

  const save = async () => {
    const fid = id || uid();
    // Strip React Flow's transient fields and the run marks — only the graph
    // itself belongs in flows.json.
    const clean = nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data }));
    const flow = {
      id: fid,
      name,
      nodes: clean,
      edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
    };
    await post("/flows", flow);
    setId(fid);
    setFlows(await (await fetch("/flows")).json());
  };

  const run = async () => {
    if (!id) return;
    await save();
    setEntries([]);
    setMarks({});
    const r = await post("/flows/run", { id });
    if (!r.ok) setEntries([{ icon: "✕", title: r.status === 409 ? "busy — adhd is mid-turn" : "could not start (API key?)", status: "error" }]);
  };
  const control = async (action) => {
    const { state } = await (await post("/flows/control", { action })).json();
    setRunState(state === "stopped" ? "idle" : state);
  };

  const remove = async () => {
    if (!id) return;
    await post("/flows/delete", { id });
    setFlows(await (await fetch("/flows")).json());
    blank();
  };

  const sel = nodes.find((n) => n.id === selected) || null;
  // Run marks are layered on for display only; `nodes` stays the saved graph.
  const shown = useMemo(
    () => nodes.map((n) => (marks[n.id] ? { ...n, data: { ...n.data, ...marks[n.id] } } : n)),
    [nodes, marks],
  );

  return h(
    "div",
    { className: "flex-1 flex min-h-0" },
    // saved flows
    h(
      "aside",
      { className: "w-52 shrink-0 border-r border-line p-3 flex flex-col gap-1 overflow-y-auto" },
      h("button", { className: btn + " mb-2", onClick: blank }, "+ New flow"),
      flows.map((f) =>
        h(
          "button",
          {
            key: f.id,
            onClick: () => open(f),
            className: `text-left px-2 py-1.5 rounded-lg text-xs ${f.id === id ? "bg-surface text-paper" : "text-dim hover:text-paper"}`,
          },
          f.name,
        ),
      ),
    ),
    // canvas + toolbar + log
    h(
      "div",
      { className: "flex-1 flex flex-col min-w-0" },
      h(
        "div",
        { className: "flex items-center gap-2 p-2 border-b border-line" },
        h("input", { className: field + " w-56", value: name, onChange: (e) => setName(e.target.value) }),
        h("button", { className: btn, onClick: () => add("prompt") }, "+ Prompt"),
        h("button", { className: btn, onClick: () => add("if") }, "+ If"),
        h("button", { className: btn, onClick: () => add("tool") }, "+ Tool"),
        h("button", { className: btn, onClick: () => add("end") }, "+ End"),
        h(
          "div",
          { className: "ml-auto flex gap-2 items-center" },
          runState === "idle"
            ? h(
                React.Fragment,
                null,
                h("button", { className: btn, onClick: remove }, "Delete"),
                h("button", { className: btn, onClick: save }, "Save"),
                h("button", { className: btn + " bg-paper text-base border-transparent", onClick: run }, "Run"),
              )
            : h(
                React.Fragment,
                null,
                h("span", { className: "font-mono text-[11px] text-dim" }, runState),
                runState === "paused"
                  ? h("button", { className: btn, onClick: () => control("resume") }, "Resume")
                  : h("button", { className: btn, onClick: () => control("pause") }, "Pause"),
                h("button", { className: btn + " text-bad border-bad/40", onClick: () => control("stop") }, "Stop"),
              ),
        ),
      ),
      h(
        "div",
        { className: "flex-1 min-h-0" },
        h(
          ReactFlow,
          {
            nodes: shown,
            edges,
            nodeTypes,
            onNodesChange,
            onEdgesChange,
            onConnect,
            onNodeClick: (_, n) => setSelected(n.id),
            onPaneClick: () => setSelected(null),
            colorMode:
              matchMedia("(prefers-color-scheme: light)").matches && window.currentThemePref?.() !== "dark"
                ? "light"
                : "dark",
            fitView: true,
          },
          h(Background, null),
          h(Controls, null),
        ),
      ),
      h(RunLog, { entries }),
    ),
    // inspector
    h(
      "aside",
      { className: "w-72 shrink-0 border-l border-line overflow-y-auto" },
      h(Inspector, {
        node: sel,
        toolNames,
        toolArgs,
        onChange: (data) => setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, data } : n))),
        onDelete: () => {
          setNodes((ns) => ns.filter((n) => n.id !== selected));
          setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
          setSelected(null);
        },
      }),
    ),
  );
}

// ---- mount -----------------------------------------------------------------
const panel = document.getElementById("flows-panel");
let root = null;
window.openFlows = () => {
  panel.classList.remove("hidden");
  if (!root) {
    const header = document.createElement("div");
    header.className = "flex items-center gap-3 px-5 h-14 border-b border-line shrink-0";
    header.innerHTML = `<button class="text-dim hover:text-paper">← Back</button><span class="font-display font-bold">Flows</span>`;
    header.firstChild.onclick = () => window.closeFlows();
    const body = document.createElement("div");
    body.className = "flex-1 flex min-h-0";
    panel.append(header, body);
    root = createRoot(body);
    root.render(h(FlowsPage, null));
  }
};
window.closeFlows = () => panel.classList.add("hidden");
document.getElementById("open-flows").onclick = () => window.openFlows();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.closeFlows();
});
