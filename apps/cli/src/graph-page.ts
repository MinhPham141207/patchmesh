/**
 * The work-graph explorer, as a single self-contained document.
 *
 * It is inlined as a string rather than shipped as an asset because `apps/cli` publishes only
 * what `tsc` emits into `dist`, and a page that has to be found on disk at run time is a page
 * that goes missing in a global install.
 *
 * The page fetches `/graph.json` on load and on demand, so leaving the tab open and hitting
 * reload after an agent session shows the new work rather than a snapshot frozen at launch.
 */
export const GRAPH_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PatchMesh work graph</title>
<style>
  :root {
    color-scheme: light;
    --plane: #f9f9f7;
    --surface: #fcfcfb;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --rule: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --accent: #2a78d6;
    --accent-soft: rgba(42,120,214,0.12);
    --critical: #d03b3b;
    --heat-1: #cde2fb;
    --heat-2: #9ec5f4;
    --heat-3: #5598e7;
    --heat-4: #256abf;
    --heat-5: #104281;
  }
  :root[data-theme="dark"], :root:not([data-theme="light"]) {
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --plane: #0d0d0d;
      --surface: #1a1a19;
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --rule: #383835;
      --border: rgba(255,255,255,0.10);
      --accent: #3987e5;
      --accent-soft: rgba(57,135,229,0.18);
      --critical: #d03b3b;
      --heat-1: #184f95;
      --heat-2: #1c5cab;
      --heat-3: #2a78d6;
      --heat-4: #5598e7;
      --heat-5: #9ec5f4;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --rule: #383835;
    --border: rgba(255,255,255,0.10);
    --accent: #3987e5;
    --accent-soft: rgba(57,135,229,0.18);
    --critical: #d03b3b;
    --heat-1: #184f95;
    --heat-2: #1c5cab;
    --heat-3: #2a78d6;
    --heat-4: #5598e7;
    --heat-5: #9ec5f4;
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--plane);
    color: var(--ink);
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  button, input, select { font: inherit; color: inherit; }

  header {
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    padding: 10px 16px 0;
    flex: none;
  }
  .titlebar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .brand { font-weight: 600; letter-spacing: -0.01em; }
  .ledger {
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 42ch;
  }
  .spacer { flex: 1 1 auto; }
  .control {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 9px;
    cursor: pointer;
  }
  .control:hover { background: var(--accent-soft); }
  .control[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: transparent; }
  .tabs { display: flex; gap: 2px; border: 1px solid var(--border); border-radius: 7px; padding: 2px; }
  .tabs .control { border: none; border-radius: 5px; }
  input[type="search"] {
    background: var(--plane);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 9px;
    min-width: 22ch;
  }
  input[type="search"]:focus-visible, .control:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .stats { display: flex; gap: 22px; padding: 10px 2px 12px; flex-wrap: wrap; }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat b { font-size: 19px; font-weight: 600; line-height: 1.1; }
  .stat span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .stat.alert b { color: var(--critical); }

  main { flex: 1 1 auto; display: grid; grid-template-columns: 250px minmax(0,1fr) 320px; min-height: 0; }
  aside, .detail { overflow: auto; background: var(--surface); }
  aside { border-right: 1px solid var(--border); }
  .detail { border-left: 1px solid var(--border); padding: 14px 14px 40px; }
  .stage { position: relative; min-width: 0; background: var(--plane); overflow: hidden; }
  .stage > svg, .stage > .tablewrap { position: absolute; inset: 0; }

  .rail-head {
    position: sticky; top: 0; background: var(--surface);
    padding: 10px 12px 6px; font-size: 11px; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .rail-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px; cursor: pointer; border: none; background: none;
    width: 100%; text-align: left;
  }
  .rail-item:hover { background: var(--accent-soft); }
  .rail-item[aria-current="true"] { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  .rail-item .id { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .rail-item .n { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .rail-item.sub { padding-left: 26px; }
  .rail-item.sub .id { color: var(--ink-2); }

  svg { display: block; width: 100%; height: 100%; }
  .node rect { stroke: var(--rule); stroke-width: 1; }
  .node text { font-size: 11px; fill: var(--ink); }
  .node .meta { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .node { cursor: pointer; }
  .link { fill: none; stroke: var(--accent); stroke-opacity: 0.45; }
  .link.reads { stroke: var(--muted); stroke-dasharray: 3 3; }
  .dim { opacity: 0.1; }
  .col-label { fill: var(--muted); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }

  .legend {
    position: absolute; left: 12px; bottom: 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 7px;
    padding: 8px 10px; display: flex; gap: 14px; font-size: 11px; color: var(--ink-2);
    align-items: center; flex-wrap: wrap; max-width: calc(100% - 24px);
  }
  .legend i { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--accent); vertical-align: middle; margin-right: 5px; }
  .legend i.reads { border-top-style: dashed; border-color: var(--muted); }
  .legend i.box { height: 10px; border: 1px solid var(--rule); background: var(--heat-2); border-radius: 2px; }
  .legend i.contested { border: 1px solid var(--critical); background: transparent; }
  .hint { position: absolute; right: 12px; bottom: 12px; font-size: 11px; color: var(--muted); }

  .tip {
    position: fixed; pointer-events: none; z-index: 20;
    background: var(--surface); color: var(--ink);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 6px 9px; font-size: 11px; max-width: 46ch;
    box-shadow: 0 6px 20px rgba(0,0,0,0.18);
    opacity: 0; transition: opacity 90ms;
  }
  .tip.on { opacity: 1; }
  .tip b { font-weight: 600; }

  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  thead th {
    position: sticky; top: 0; background: var(--surface); z-index: 1;
    text-align: left; font-weight: 600; font-size: 11px; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.04em;
    padding: 8px 10px; border-bottom: 1px solid var(--rule); cursor: pointer; white-space: nowrap;
  }
  thead th:hover { color: var(--ink); }
  tbody tr { border-bottom: 1px solid var(--grid); cursor: pointer; }
  tbody tr:hover { background: var(--accent-soft); }
  tbody tr[aria-current="true"] { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  td { padding: 6px 10px; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; width: 1%; white-space: nowrap; }
  td.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  td.path .dir { color: var(--muted); }
  .heat { display: inline-block; width: 22px; height: 10px; border-radius: 2px; border: 1px solid var(--border); vertical-align: -1px; margin-right: 6px; }
  .tablewrap { height: 100%; overflow: auto; background: var(--surface); }
  .flag { color: var(--critical); font-weight: 600; white-space: nowrap; }

  .detail h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 4px; font-weight: 600; }
  .detail h3 { font-size: 14px; margin: 0 0 12px; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
  .detail h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; font-size: 12px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; word-break: break-all; font-variant-numeric: tabular-nums; }
  .chip {
    display: inline-block; border: 1px solid var(--border); border-radius: 5px;
    padding: 1px 7px; margin: 0 4px 4px 0; font-size: 11px; cursor: pointer;
    background: transparent; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip:hover { background: var(--accent-soft); }
  .timeline { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  .timeline li { padding: 6px 0 6px 12px; border-left: 2px solid var(--grid); position: relative; }
  .timeline li::before {
    content: ""; position: absolute; left: -5px; top: 12px;
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); border: 2px solid var(--surface);
  }
  .timeline .when { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11px; }
  .timeline .who { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
  .timeline .hash { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .empty { color: var(--muted); padding: 24px 16px; }
  .gap { font-size: 11px; color: var(--ink-2); padding: 3px 0; border-bottom: 1px solid var(--grid); }
  .gap b { font-variant-numeric: tabular-nums; }

  @media (max-width: 1100px) {
    main { grid-template-columns: 200px minmax(0,1fr); }
    .detail { display: none; }
  }
</style>
</head>
<body>
<header>
  <div class="titlebar">
    <span class="brand">PatchMesh work graph</span>
    <span class="ledger" id="ledger"></span>
    <span class="spacer"></span>
    <input type="search" id="search" placeholder="Filter files, agents, tasks" autocomplete="off">
    <button class="control" id="contested" aria-pressed="false" title="Show only files more than one agent changed">Contested only</button>
    <div class="tabs" role="tablist">
      <button class="control" id="tab-map" aria-pressed="true" role="tab">Map</button>
      <button class="control" id="tab-files" aria-pressed="false" role="tab">Files</button>
    </div>
    <button class="control" id="reload" title="Re-read the ledger">Reload</button>
    <button class="control" id="theme" title="Toggle light and dark">Theme</button>
  </div>
  <div class="stats" id="stats"></div>
</header>
<main>
  <aside id="rail"></aside>
  <div class="stage" id="stage">
    <svg id="canvas" role="img" aria-label="Agents and the files they changed"></svg>
    <div class="tablewrap" id="tablewrap" hidden><table id="table"><thead></thead><tbody></tbody></table></div>
    <div class="legend" id="legend">
      <span><i></i>changed</span>
      <span><i class="reads"></i>read</span>
      <span><i class="box"></i>file, shaded by number of changes</span>
      <span><i class="box contested"></i>contested (&gt;1 agent)</span>
    </div>
    <div class="hint" id="hint">scroll to zoom · drag to pan · click to select</div>
  </div>
  <div class="detail" id="detail"></div>
</main>
<div class="tip" id="tip"></div>
<script>
"use strict";
var NS = "http://www.w3.org/2000/svg";
var model = null;
var selection = null;      // {kind:"agent"|"task"|"file"|"dir", id:string}
var expanded = {};         // directory -> true
var tab = "map";
var contestedOnly = false;
var query = "";
var sort = { key: "changes", dir: -1 };
var view = { x: 0, y: 0, k: 1 };
var contentWidth = 930;
var fitted = false;

function byId(id) { return document.getElementById(id); }
function svgEl(tag, attrs) {
  var node = document.createElementNS(NS, tag);
  for (var key in attrs) if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, String(attrs[key]));
  return node;
}
function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function shortId(id) {
  if (!id) return "unattributed";
  var trimmed = id.replace(/^(agent|task)_/, "");
  return trimmed.length > 22 ? trimmed.slice(0, 10) + "\\u2026" + trimmed.slice(-6) : trimmed;
}
function when(iso) {
  if (!iso) return "unknown time";
  var d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

/* ---------- data shaping ---------- */

function fileMatches(file) {
  if (contestedOnly && file.changedBy.length < 2) return false;
  if (query === "") return true;
  if (file.path.toLowerCase().indexOf(query) !== -1) return true;
  var i;
  for (i = 0; i < file.changedBy.length; i++) if (file.changedBy[i].toLowerCase().indexOf(query) !== -1) return true;
  for (i = 0; i < file.taskIds.length; i++) if (file.taskIds[i].toLowerCase().indexOf(query) !== -1) return true;
  return false;
}
function visibleFiles() { return model.files.filter(fileMatches); }
function dirKey(file) { return file.dir === "" ? "." : file.dir; }

function agentById(id) {
  for (var i = 0; i < model.agents.length; i++) if (model.agents[i].id === id) return model.agents[i];
  return null;
}
function taskById(id) {
  for (var i = 0; i < model.tasks.length; i++) if (model.tasks[i].id === id) return model.tasks[i];
  return null;
}
function fileById(id) {
  for (var i = 0; i < model.files.length; i++) if (model.files[i].id === id) return model.files[i];
  return null;
}

/* Agents ordered so a subagent sits directly under the agent that spawned it. */
function orderedAgents() {
  var roots = model.agents.filter(function (a) { return a.parentId === null; });
  var out = [];
  roots.forEach(function (root) {
    out.push(root);
    model.agents.forEach(function (a) { if (a.parentId === root.id) out.push(a); });
  });
  model.agents.forEach(function (a) { if (out.indexOf(a) === -1) out.push(a); });
  return out;
}

/*
 * Changes no agent claims still happened.
 *
 * On a hook-recorded ledger a large share of file changes arrive with null attribution -- a
 * shell command wrote the file and nothing in the payload said who ran it. Dropping their
 * edges would draw a map whose lines add up to less than the change count above it, so they
 * get a row of their own and are named for what they are.
 */
var UNATTRIBUTED = "(unattributed)";
function mapAgents() {
  var agents = orderedAgents();
  if (model.counts.unattributedChanges > 0) {
    agents = agents.concat([{
      id: UNATTRIBUTED,
      label: "unattributed",
      parentId: null,
      taskIds: [],
      changeCount: model.counts.unattributedChanges,
      readCount: 0,
      fileIds: [],
      firstAt: null,
      lastAt: null,
      synthetic: true
    }]);
  }
  return agents;
}

/* Does this selection touch this file? Selection drives every dimming decision. */
function selectionTouches(file) {
  if (!selection) return true;
  if (selection.kind === "file") return file.id === selection.id;
  if (selection.kind === "dir") return dirKey(file) === selection.id;
  if (selection.kind === "agent") return file.changedBy.indexOf(selection.id) !== -1 || file.readBy.indexOf(selection.id) !== -1;
  if (selection.kind === "task") return file.taskIds.indexOf(selection.id) !== -1;
  return true;
}
function selectionTouchesAgent(agentId) {
  if (!selection) return true;
  if (agentId === UNATTRIBUTED) {
    if (selection.kind === "file") { var uf = fileById(selection.id); return uf !== null && uf.changes.some(function (c) { return c.agentId === null; }); }
    if (selection.kind === "dir") return model.files.some(function (f) { return dirKey(f) === selection.id && f.changes.some(function (c) { return c.agentId === null; }); });
    return false;
  }
  if (selection.kind === "agent") return agentId === selection.id;
  if (selection.kind === "task") { var t = taskById(selection.id); return t !== null && t.agentIds.indexOf(agentId) !== -1; }
  if (selection.kind === "file") { var f = fileById(selection.id); return f !== null && (f.changedBy.indexOf(agentId) !== -1 || f.readBy.indexOf(agentId) !== -1); }
  if (selection.kind === "dir") {
    return model.files.some(function (f) {
      return dirKey(f) === selection.id && (f.changedBy.indexOf(agentId) !== -1 || f.readBy.indexOf(agentId) !== -1);
    });
  }
  return true;
}

function heatColor(changes) {
  if (changes >= 12) return "var(--heat-5)";
  if (changes >= 6) return "var(--heat-4)";
  if (changes >= 3) return "var(--heat-3)";
  if (changes >= 2) return "var(--heat-2)";
  return "var(--heat-1)";
}

/* ---------- header ---------- */

function renderStats() {
  var host = byId("stats");
  host.textContent = "";
  var c = model.counts;
  var cells = [
    ["events", c.events, false],
    ["agents", c.agents, false],
    ["tasks", c.tasks, false],
    ["files", c.files, false],
    ["changes", c.changes, false],
    ["contested files", c.contested, c.contested > 0],
    ["unattributed changes", c.unattributedChanges, c.unattributedChanges > 0]
  ];
  cells.forEach(function (cell) {
    var stat = el("div", "stat" + (cell[2] ? " alert" : ""));
    stat.appendChild(el("b", null, cell[1].toLocaleString()));
    stat.appendChild(el("span", null, cell[0]));
    host.appendChild(stat);
  });
  byId("ledger").textContent = model.ledger;
  byId("ledger").title = model.ledger + " \\u00b7 read " + when(model.generatedAt);
}

/* ---------- left rail ---------- */

function railItem(label, count, kind, id, isSub) {
  var button = el("button", "rail-item" + (isSub ? " sub" : ""));
  button.appendChild(el("span", "id", label));
  button.appendChild(el("span", "n", count));
  button.title = id;
  if (selection && selection.kind === kind && selection.id === id) button.setAttribute("aria-current", "true");
  button.addEventListener("click", function () { select(kind, id); });
  return button;
}

function renderRail() {
  var rail = byId("rail");
  rail.textContent = "";
  rail.appendChild(el("div", "rail-head", "Agents \\u00b7 " + model.agents.length));
  orderedAgents().forEach(function (agent) {
    var label = agent.parentId === null ? shortId(agent.id) : "\\u21b3 " + shortId(agent.id);
    rail.appendChild(railItem(label, agent.changeCount, "agent", agent.id, agent.parentId !== null));
  });
  rail.appendChild(el("div", "rail-head", "Tasks \\u00b7 " + model.tasks.length));
  model.tasks
    .slice()
    .sort(function (a, b) { return b.changeCount - a.changeCount; })
    .forEach(function (task) { rail.appendChild(railItem(shortId(task.id), task.changeCount, "task", task.id, false)); });
  if (model.gaps.length > 0) {
    rail.appendChild(el("div", "rail-head", "Coverage gaps"));
    var box = el("div");
    box.style.padding = "4px 12px 20px";
    model.gaps.forEach(function (gap) {
      var line = el("div", "gap");
      line.appendChild(el("b", null, gap.count + "\\u00d7 "));
      line.appendChild(document.createTextNode(gap.kind + " \\u2014 " + gap.reason));
      box.appendChild(line);
    });
    rail.appendChild(box);
  }
}

/* ---------- map ---------- */

var AGENT_X = 24, AGENT_W = 230, FILE_X = 430, FILE_W = 460, ROW = 22, GAPY = 4;

/* Right column rows: one per directory, expanded into its files when the user opens it. */
function fileRows() {
  var groups = [];
  var index = {};
  visibleFiles().forEach(function (file) {
    var key = file.dir === "" ? "." : file.dir;
    if (index[key] === undefined) { index[key] = groups.length; groups.push({ dir: key, files: [] }); }
    groups[index[key]].files.push(file);
  });
  var rows = [];
  groups.forEach(function (group) {
    var open = expanded[group.dir] === true || query !== "";
    var changes = group.files.reduce(function (total, file) { return total + file.changes.length; }, 0);
    rows.push({ kind: "dir", dir: group.dir, files: group.files, changes: changes, open: open });
    if (open) group.files.forEach(function (file) { rows.push({ kind: "file", file: file, dir: group.dir }); });
  });
  return rows;
}

function renderMap() {
  var canvas = byId("canvas");
  canvas.textContent = "";
  var agents = mapAgents();
  var rows = fileRows();

  if (rows.length === 0) {
    canvas.setAttribute("viewBox", "0 0 600 200");
    var note = svgEl("text", { x: 24, y: 40, fill: "var(--muted)", "font-size": 14 });
    note.textContent = model.files.length === 0 ? "No file changes recorded yet." : "No files match this filter.";
    canvas.appendChild(note);
    return;
  }

  var root = svgEl("g", { id: "viewport" });
  var linkLayer = svgEl("g", {});
  var nodeLayer = svgEl("g", {});
  root.appendChild(linkLayer);
  root.appendChild(nodeLayer);
  canvas.appendChild(root);

  var top = 46;
  var agentY = {};
  var y = top;
  agents.forEach(function (agent) {
    agentY[agent.id] = y + ROW / 2;
    y += ROW + GAPY;
  });
  var agentBottom = y;

  var rowY = [];
  y = top;
  rows.forEach(function (row, i) {
    rowY[i] = y + ROW / 2;
    y += ROW + (row.kind === "dir" ? GAPY + 2 : 1);
  });
  var fileBottom = y;
  var height = Math.max(agentBottom, fileBottom) + 40;

  var head = svgEl("text", { x: AGENT_X, y: 26, "class": "col-label" });
  head.textContent = "agents \\u00b7 " + agents.length;
  root.appendChild(head);
  var head2 = svgEl("text", { x: FILE_X, y: 26, "class": "col-label" });
  head2.textContent = "files \\u00b7 " + visibleFiles().length + (query || contestedOnly ? " (filtered)" : "");
  root.appendChild(head2);

  /* Aggregate edges to whatever the right column is currently showing: a collapsed
     directory carries the sum of its files' edges, so opening a group refines the picture
     instead of changing it. */
  var links = {};
  rows.forEach(function (row, i) {
    var files = row.kind === "dir" ? (row.open ? [] : row.files) : [row.file];
    files.forEach(function (file) {
      file.changes.forEach(function (change) { tally(links, change.agentId === null ? UNATTRIBUTED : change.agentId, i, "changes"); });
      file.reads.forEach(function (read) { tally(links, read.agentId === null ? UNATTRIBUTED : read.agentId, i, "reads"); });
    });
  });

  Object.keys(links).forEach(function (key) {
    var link = links[key];
    if (agentY[link.agentId] === undefined) return;
    var y1 = agentY[link.agentId];
    var y2 = rowY[link.row];
    var x1 = AGENT_X + AGENT_W;
    var x2 = FILE_X;
    var mid = (x1 + x2) / 2;
    var path = svgEl("path", {
      d: "M" + x1 + "," + y1 + "C" + mid + "," + y1 + " " + mid + "," + y2 + " " + x2 + "," + y2,
      "class": "link" + (link.kind === "reads" ? " reads" : ""),
      "stroke-width": Math.min(4, 1 + Math.log(link.weight) / Math.log(3))
    });
    var row = rows[link.row];
    var file = row.kind === "file" ? row.file : null;
    var lit = selectionTouchesAgent(link.agentId) &&
      (file !== null ? selectionTouches(file) : row.files.some(selectionTouches));
    if (!lit) path.setAttribute("class", path.getAttribute("class") + " dim");
    linkLayer.appendChild(path);
  });

  agents.forEach(function (agent) {
    var lit = selectionTouchesAgent(agent.id);
    var group = svgEl("g", { "class": "node" + (lit ? "" : " dim") });
    var indent = agent.parentId === null ? 0 : 14;
    group.appendChild(svgEl("rect", {
      x: AGENT_X + indent, y: agentY[agent.id] - ROW / 2, width: AGENT_W - indent, height: ROW, rx: 5,
      fill: selection && selection.kind === "agent" && selection.id === agent.id ? "var(--accent-soft)" : "var(--surface)"
    }));
    var label = svgEl("text", { x: AGENT_X + indent + 8, y: agentY[agent.id] + 4, fill: agent.synthetic ? "var(--muted)" : null });
    label.textContent = agent.synthetic ? "\\u2014 unattributed" : (agent.parentId === null ? "" : "\\u21b3 ") + shortId(agent.id);
    group.appendChild(label);
    var meta = svgEl("text", { x: AGENT_X + AGENT_W - 8, y: agentY[agent.id] + 4, "class": "meta", "text-anchor": "end" });
    meta.textContent = agent.changeCount;
    group.appendChild(meta);
    if (agent.synthetic) {
      group.addEventListener("mousemove", function (event) {
        showTip(event, "<b>unattributed</b><br>" + plural(agent.changeCount, "change", "changes") +
          " whose causing tool call was not recorded<br>usually a shell command that wrote a file");
      });
      group.addEventListener("mouseleave", hideTip);
    } else {
      bind(group, "agent", agent.id, agentTip(agent));
    }
    nodeLayer.appendChild(group);
  });

  rows.forEach(function (row, i) {
    var group, rect, label, meta;
    if (row.kind === "dir") {
      group = svgEl("g", { "class": "node" + (selection && !row.files.some(selectionTouches) ? " dim" : "") });
      rect = svgEl("rect", {
        x: FILE_X, y: rowY[i] - ROW / 2, width: FILE_W, height: ROW, rx: 5,
        fill: "var(--plane)", stroke: "var(--rule)"
      });
      group.appendChild(rect);
      label = svgEl("text", { x: FILE_X + 8, y: rowY[i] + 4 });
      label.textContent = (row.open ? "\\u25be " : "\\u25b8 ") + (row.dir === "." ? "(repository root)" : row.dir) + "/";
      group.appendChild(label);
      meta = svgEl("text", { x: FILE_X + FILE_W - 8, y: rowY[i] + 4, "class": "meta", "text-anchor": "end" });
      meta.textContent = row.files.length + " files \\u00b7 " + row.changes + " changes";
      group.appendChild(meta);
      group.addEventListener("click", function (event) {
        event.stopPropagation();
        expanded[row.dir] = !row.open;
        selection = { kind: "dir", id: row.dir };
        render();
      });
      group.addEventListener("mousemove", function (event) { showTip(event, "<b>" + escapeHtml(row.dir) + "/</b><br>" + plural(row.files.length, "file", "files") + " \\u00b7 " + plural(row.changes, "change", "changes") + "<br>click to " + (row.open ? "collapse" : "expand")); });
      group.addEventListener("mouseleave", hideTip);
    } else {
      var file = row.file;
      var contested = file.changedBy.length > 1;
      group = svgEl("g", { "class": "node" + (selectionTouches(file) ? "" : " dim") });
      rect = svgEl("rect", {
        x: FILE_X + 16, y: rowY[i] - ROW / 2 + 3, width: FILE_W - 16, height: ROW - 6, rx: 3,
        fill: heatColor(file.changes.length),
        stroke: contested ? "var(--critical)" : "var(--rule)",
        "stroke-width": contested ? 1.5 : 1,
        "fill-opacity": 0.55
      });
      group.appendChild(rect);
      label = svgEl("text", { x: FILE_X + 26, y: rowY[i] + 4 });
      label.textContent = file.name;
      group.appendChild(label);
      meta = svgEl("text", { x: FILE_X + FILE_W - 8, y: rowY[i] + 4, "class": "meta", "text-anchor": "end" });
      meta.textContent = (contested ? "\\u26a0 " + file.changedBy.length + " agents \\u00b7 " : "") + plural(file.changes.length, "change", "changes");
      group.appendChild(meta);
      bind(group, "file", file.id, fileTip(file));
    }
    nodeLayer.appendChild(group);
  });

  contentWidth = FILE_X + FILE_W + 40;
  sizeCanvas();
  applyView();
}

/*
 * One content unit is one CSS pixel at scale 1.
 *
 * The viewBox is sized from the stage rather than from the drawing, so a graph five thousand
 * units tall is scrolled through rather than shrunk to illegibility, and so the pixel deltas
 * a wheel or a drag reports can go straight into the transform without a second conversion.
 */
function sizeCanvas() {
  var canvas = byId("canvas");
  var rect = byId("stage").getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.setAttribute("viewBox", "0 0 " + rect.width + " " + rect.height);
  canvas.setAttribute("preserveAspectRatio", "xMinYMin meet");
  if (!fitted) {
    view.k = Math.min(1, rect.width / contentWidth);
    view.x = 0;
    view.y = 0;
    fitted = true;
  }
}

function tally(links, agentId, row, kind) {
  var key = agentId + "\\t" + row + "\\t" + kind;
  if (links[key] === undefined) links[key] = { agentId: agentId, row: row, kind: kind, weight: 0 };
  links[key].weight += 1;
}

function bind(group, kind, id, tip) {
  group.addEventListener("click", function (event) { event.stopPropagation(); select(kind, id); });
  group.addEventListener("mousemove", function (event) { showTip(event, tip); });
  group.addEventListener("mouseleave", hideTip);
}

function agentTip(agent) {
  return "<b>" + escapeHtml(agent.id) + "</b><br>" +
    plural(agent.changeCount, "change", "changes") + " \\u00b7 " + plural(agent.taskIds.length, "task", "tasks") + "<br>" +
    when(agent.firstAt) + " \\u2192 " + when(agent.lastAt);
}
function fileTip(file) {
  var who = file.changedBy.length === 0 ? "no attributed agent" : file.changedBy.map(shortId).join(", ");
  return "<b>" + escapeHtml(file.path) + "</b><br>" +
    plural(file.changes.length, "change", "changes") + " by " + escapeHtml(who) + "<br>last " + when(file.lastAt);
}
function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- pan and zoom ---------- */

function applyView() {
  var viewport = byId("viewport");
  if (viewport) viewport.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
}
function installPanZoom() {
  var stage = byId("stage");
  var dragging = false, lastX = 0, lastY = 0;
  stage.addEventListener("wheel", function (event) {
    if (tab !== "map") return;
    event.preventDefault();
    var factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    var next = Math.min(6, Math.max(0.1, view.k * factor));
    var rect = byId("stage").getBoundingClientRect();
    var px = event.clientX - rect.left, py = event.clientY - rect.top;
    view.x = px - (px - view.x) * (next / view.k);
    view.y = py - (py - view.y) * (next / view.k);
    view.k = next;
    applyView();
  }, { passive: false });
  stage.addEventListener("mousedown", function (event) {
    if (tab !== "map" || event.button !== 0) return;
    dragging = true; lastX = event.clientX; lastY = event.clientY;
    stage.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", function (event) {
    if (!dragging) return;
    view.x += event.clientX - lastX;
    view.y += event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    applyView();
  });
  window.addEventListener("mouseup", function () { dragging = false; byId("stage").style.cursor = ""; });
  byId("canvas").addEventListener("click", function () { select(null, null); });
}

/* ---------- files table ---------- */

var COLUMNS = [
  { key: "path", label: "File" },
  { key: "changes", label: "Changes" },
  { key: "agents", label: "Agents" },
  { key: "tasks", label: "Tasks" },
  { key: "last", label: "Last touched" }
];

function sortValue(file, key) {
  if (key === "path") return file.path;
  if (key === "changes") return file.changes.length;
  if (key === "agents") return file.changedBy.length;
  if (key === "tasks") return file.taskIds.length;
  return file.lastAt === null ? "" : file.lastAt;
}

function renderTable() {
  var table = byId("table");
  var head = table.tHead;
  var body = table.tBodies[0];
  head.textContent = "";
  body.textContent = "";
  var tr = el("tr");
  COLUMNS.forEach(function (column) {
    var th = el("th", null, column.label + (sort.key === column.key ? (sort.dir === 1 ? " \\u2191" : " \\u2193") : ""));
    th.addEventListener("click", function () {
      if (sort.key === column.key) sort.dir = -sort.dir;
      else { sort.key = column.key; sort.dir = column.key === "path" ? 1 : -1; }
      renderTable();
    });
    tr.appendChild(th);
  });
  head.appendChild(tr);

  var rows = visibleFiles().slice().sort(function (a, b) {
    var left = sortValue(a, sort.key), right = sortValue(b, sort.key);
    return (left < right ? -1 : left > right ? 1 : 0) * sort.dir;
  });
  if (rows.length === 0) {
    var empty = el("tr");
    var cell = el("td", "empty", "No files match this filter.");
    cell.colSpan = COLUMNS.length;
    empty.appendChild(cell);
    body.appendChild(empty);
    return;
  }
  rows.forEach(function (file) {
    var row = el("tr");
    if (selection && selection.kind === "file" && selection.id === file.id) row.setAttribute("aria-current", "true");
    var path = el("td", "path");
    var swatch = el("span", "heat");
    swatch.style.background = heatColor(file.changes.length);
    path.appendChild(swatch);
    if (file.dir !== "") path.appendChild(el("span", "dir", file.dir + "/"));
    path.appendChild(document.createTextNode(file.name));
    row.appendChild(path);
    row.appendChild(el("td", "num", file.changes.length));
    var agents = el("td", "num");
    if (file.changedBy.length > 1) agents.appendChild(el("span", "flag", "\\u26a0 " + file.changedBy.length));
    else agents.appendChild(document.createTextNode(String(file.changedBy.length)));
    row.appendChild(agents);
    row.appendChild(el("td", "num", file.taskIds.length));
    row.appendChild(el("td", "num", when(file.lastAt)));
    row.addEventListener("click", function () { select("file", file.id); });
    body.appendChild(row);
  });
}

/* ---------- detail panel ---------- */

function chip(label, kind, id) {
  var button = el("button", "chip", label);
  button.title = id;
  button.addEventListener("click", function () { select(kind, id); });
  return button;
}
function kv(pairs) {
  var list = el("dl", "kv");
  pairs.forEach(function (pair) {
    if (pair[1] === null || pair[1] === undefined) return;
    list.appendChild(el("dt", null, pair[0]));
    list.appendChild(el("dd", null, pair[1]));
  });
  return list;
}

function renderDetail() {
  var host = byId("detail");
  host.textContent = "";
  if (!selection) {
    host.appendChild(el("h2", null, "Nothing selected"));
    host.appendChild(el("p", "empty", "Pick an agent, a directory or a file. The map dims everything the selection did not touch, and this panel shows what was recorded about it."));
    return;
  }
  if (selection.kind === "agent") return renderAgentDetail(host, agentById(selection.id));
  if (selection.kind === "task") return renderTaskDetail(host, taskById(selection.id));
  if (selection.kind === "file") return renderFileDetail(host, fileById(selection.id));
  return renderDirDetail(host, selection.id);
}

function renderAgentDetail(host, agent) {
  if (!agent) return;
  host.appendChild(el("h2", null, agent.parentId === null ? "Agent" : "Subagent"));
  host.appendChild(el("h3", null, agent.id));
  host.appendChild(kv([
    ["Changes", agent.changeCount],
    ["Reads", agent.readCount],
    ["Files touched", agent.fileCount === undefined ? agent.fileIds.length : agent.fileCount],
    ["First seen", when(agent.firstAt)],
    ["Last seen", when(agent.lastAt)]
  ]));
  if (agent.parentId !== null) {
    host.appendChild(el("h4", null, "Spawned by"));
    host.appendChild(chip(shortId(agent.parentId), "agent", agent.parentId));
  }
  var children = model.agents.filter(function (a) { return a.parentId === agent.id; });
  if (children.length > 0) {
    host.appendChild(el("h4", null, "Subagents \\u00b7 " + children.length));
    children.forEach(function (child) { host.appendChild(chip(shortId(child.id), "agent", child.id)); });
  }
  if (agent.taskIds.length > 0) {
    host.appendChild(el("h4", null, "Tasks \\u00b7 " + agent.taskIds.length));
    agent.taskIds.forEach(function (id) { host.appendChild(chip(shortId(id), "task", id)); });
  }
  var touched = model.files.filter(function (f) { return f.changedBy.indexOf(agent.id) !== -1; });
  host.appendChild(el("h4", null, "Files changed \\u00b7 " + touched.length));
  touched.slice(0, 40).forEach(function (f) { host.appendChild(chip(f.path, "file", f.id)); });
  if (touched.length > 40) host.appendChild(el("p", "empty", "and " + (touched.length - 40) + " more"));
}

function renderTaskDetail(host, task) {
  if (!task) return;
  host.appendChild(el("h2", null, "Task"));
  host.appendChild(el("h3", null, task.id));
  host.appendChild(kv([
    ["Changes", task.changeCount],
    ["Files touched", task.fileCount === undefined ? task.fileIds.length : task.fileCount],
    ["Started", when(task.firstAt)],
    ["Last change", when(task.lastAt)]
  ]));
  host.appendChild(el("h4", null, "Run by"));
  task.agentIds.forEach(function (id) { host.appendChild(chip(shortId(id), "agent", id)); });
  var touched = model.files.filter(function (f) { return f.taskIds.indexOf(task.id) !== -1; });
  host.appendChild(el("h4", null, "Files \\u00b7 " + touched.length));
  touched.slice(0, 40).forEach(function (f) { host.appendChild(chip(f.path, "file", f.id)); });
}

function renderDirDetail(host, dir) {
  var files = model.files.filter(function (f) { return f.dir === dir || (dir === "." && f.dir === ""); });
  host.appendChild(el("h2", null, "Directory"));
  host.appendChild(el("h3", null, dir + "/"));
  var changes = files.reduce(function (total, f) { return total + f.changes.length; }, 0);
  var contested = files.filter(function (f) { return f.changedBy.length > 1; });
  host.appendChild(kv([["Files", files.length], ["Changes", changes], ["Contested files", contested.length]]));
  host.appendChild(el("h4", null, "Files"));
  files.forEach(function (f) { host.appendChild(chip(f.name, "file", f.id)); });
}

function renderFileDetail(host, file) {
  if (!file) return;
  host.appendChild(el("h2", null, "File"));
  host.appendChild(el("h3", null, file.path));
  host.appendChild(kv([
    ["Kind", file.kind],
    ["Changes", file.changes.length],
    ["Reads", file.reads.length],
    ["Agents", file.changedBy.length],
    ["First touched", when(file.firstAt)],
    ["Last touched", when(file.lastAt)],
    ["Resource id", file.id]
  ]));
  if (file.changedBy.length > 1) {
    var warn = el("p", "flag", "\\u26a0 Contested \\u2014 " + file.changedBy.length + " agents changed this file");
    host.appendChild(warn);
  }
  if (file.changedBy.length > 0) {
    host.appendChild(el("h4", null, "Changed by"));
    file.changedBy.forEach(function (id) { host.appendChild(chip(shortId(id), "agent", id)); });
  }
  if (file.readBy.length > 0) {
    host.appendChild(el("h4", null, "Read by"));
    file.readBy.forEach(function (id) { host.appendChild(chip(shortId(id), "agent", id)); });
  }
  host.appendChild(el("h4", null, "History \\u00b7 " + file.changes.length));
  if (file.changes.length === 0) {
    host.appendChild(el("p", "empty", "No recorded changes."));
    return;
  }
  var list = el("ul", "timeline");
  file.changes.slice().reverse().forEach(function (change) {
    var item = el("li");
    item.appendChild(el("div", "when", when(change.at) + " \\u00b7 " + change.changeKind));
    item.appendChild(el("div", "who", shortId(change.agentId)));
    if (change.after !== null) {
      var hash = (change.before === null ? "" : String(change.before).slice(0, 8) + " \\u2192 ") + String(change.after).slice(0, 8);
      item.appendChild(el("div", "hash", hash));
    }
    list.appendChild(item);
  });
  host.appendChild(list);
}

/* ---------- tooltip ---------- */

function showTip(event, html) {
  var tip = byId("tip");
  tip.innerHTML = html;
  tip.classList.add("on");
  var pad = 14;
  var x = event.clientX + pad;
  var y = event.clientY + pad;
  var box = tip.getBoundingClientRect();
  if (x + box.width > window.innerWidth) x = event.clientX - box.width - pad;
  if (y + box.height > window.innerHeight) y = event.clientY - box.height - pad;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}
function hideTip() { byId("tip").classList.remove("on"); }

/* ---------- wiring ---------- */

function select(kind, id) {
  selection = kind === null ? null : { kind: kind, id: id };
  if (kind === "file") {
    var file = fileById(id);
    if (file && tab === "map") expanded[file.dir === "" ? "." : file.dir] = true;
  }
  render();
}

function setTab(next) {
  tab = next;
  byId("tab-map").setAttribute("aria-pressed", String(next === "map"));
  byId("tab-files").setAttribute("aria-pressed", String(next === "files"));
  byId("canvas").style.display = next === "map" ? "block" : "none";
  byId("legend").hidden = next !== "map";
  byId("tablewrap").hidden = next !== "files";
  byId("hint").hidden = next !== "map";
  render();
}

function render() {
  renderStats();
  renderRail();
  if (tab === "map") renderMap(); else renderTable();
  renderDetail();
}

function load() {
  return fetch("/graph.json", { cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (data) { model = data; render(); })
    .catch(function (error) {
      document.body.innerHTML = "<p class='empty'>Could not read the ledger: " + escapeHtml(error.message) +
        "<br>The <code>patchmesh graph</code> process may have stopped.</p>";
    });
}

byId("search").addEventListener("input", function (event) {
  query = event.target.value.trim().toLowerCase();
  render();
});
byId("contested").addEventListener("click", function (event) {
  contestedOnly = !contestedOnly;
  event.currentTarget.setAttribute("aria-pressed", String(contestedOnly));
  render();
});
byId("tab-map").addEventListener("click", function () { setTab("map"); });
byId("tab-files").addEventListener("click", function () { setTab("files"); });
byId("reload").addEventListener("click", function () { load(); });
byId("theme").addEventListener("click", function () {
  var current = document.documentElement.getAttribute("data-theme");
  var next = current === "dark" ? "light" : current === "light" ? "dark" : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", next);
});
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") select(null, null);
  if (event.key === "/" && document.activeElement !== byId("search")) { event.preventDefault(); byId("search").focus(); }
});

window.addEventListener("resize", function () { if (tab === "map") sizeCanvas(); });
installPanZoom();
load();
</script>
</body>
</html>
`;
