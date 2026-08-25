/**
 * The PatchMesh console, as a single self-contained document.
 *
 * Inlined as a string for the same reason `graph-page.ts` is: `apps/cli` publishes only what
 * `tsc` emits into `dist`, so a page that has to be found on disk at run time is a page that
 * goes missing in a global install. Written without template literals inside, so nothing in
 * the page body needs escaping against the literal that carries it.
 *
 * Each lens fetches its own bounded endpoint on first view and caches it until Reload, so
 * opening the console costs one windowed read rather than a full projection.
 */
export const CONSOLE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PatchMesh console</title>
<style>
  :root {
    color-scheme: light;
    --plane: #f9f9f7;
    --surface: #fcfcfb;
    --sunk: #f2f1ec;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --rule: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --accent: #2a78d6;
    --accent-soft: rgba(42,120,214,0.12);
    --critical: #d03b3b;
    --critical-soft: rgba(208,59,59,0.10);
    --caution: #96660f;
    --caution-soft: rgba(150,102,15,0.12);
    --good: #35774f;
    --heat-0: #eceae3;
    --heat-1: #cde2fb;
    --heat-2: #9ec5f4;
    --heat-3: #5598e7;
    --heat-4: #256abf;
    --heat-5: #104281;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --plane: #0d0d0d;
      --surface: #1a1a19;
      --sunk: #131312;
      --ink: #ffffff;
      --ink-2: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --rule: #383835;
      --border: rgba(255,255,255,0.10);
      --accent: #3987e5;
      --accent-soft: rgba(57,135,229,0.18);
      --critical: #e25555;
      --critical-soft: rgba(226,85,85,0.14);
      --caution: #d9a441;
      --caution-soft: rgba(217,164,65,0.14);
      --good: #5fb37f;
      --heat-0: #232322;
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
    --sunk: #131312;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --rule: #383835;
    --border: rgba(255,255,255,0.10);
    --accent: #3987e5;
    --accent-soft: rgba(57,135,229,0.18);
    --critical: #e25555;
    --critical-soft: rgba(226,85,85,0.14);
    --caution: #d9a441;
    --caution-soft: rgba(217,164,65,0.14);
    --good: #5fb37f;
    --heat-0: #232322;
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
    display: flex; flex-direction: column; overflow: hidden;
  }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

  header { border-bottom: 1px solid var(--border); background: var(--surface); flex: none; }
  .titlebar { display: flex; align-items: center; gap: 12px; padding: 9px 14px; }
  .brand { font-weight: 600; letter-spacing: -0.01em; flex: none; }
  .ledger {
    font: 400 11.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--muted); flex: 1; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left;
  }
  .control {
    flex: none; font: 500 11.5px/1 system-ui, sans-serif; color: var(--ink-2);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 4px; padding: 6px 10px; cursor: pointer;
  }
  .control:hover { color: var(--ink); border-color: var(--rule); }

  main { flex: 1; display: grid; grid-template-columns: 190px 1fr; min-height: 0; }
  nav {
    border-right: 1px solid var(--border); background: var(--sunk);
    padding: 14px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
  }
  .navlabel {
    font: 600 10px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.13em;
    text-transform: uppercase; color: var(--muted); padding: 6px 10px 10px;
  }
  .lens {
    display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
    background: none; border: 0; border-radius: 4px; padding: 8px 10px;
    font: 500 13.5px/1.3 system-ui, sans-serif; color: var(--ink-2); cursor: pointer;
  }
  .lens:hover { background: var(--border); color: var(--ink); }
  .lens[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); }
  .lens .route { font: 400 11px/1 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); margin-left: auto; }
  .lens[aria-selected="true"] .route { color: var(--accent); }
  .navnote {
    margin-top: auto; padding: 12px 10px 4px; font-size: 11.5px; line-height: 1.45;
    color: var(--muted); border-top: 1px solid var(--border);
  }

  .stage { overflow: auto; padding: 20px 24px 40px; min-width: 0; }
  .view[hidden] { display: none; }
  .vhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .vhead h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: -0.015em; }
  .vsub { font-size: 12.5px; color: var(--muted); margin: 4px 0 18px; }
  .vsub b { color: var(--ink-2); font-weight: 500; }

  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 1px;
    background: var(--border); border: 1px solid var(--border);
    border-radius: 5px; overflow: hidden; margin-bottom: 20px;
  }
  .stat { background: var(--surface); padding: 11px 13px; }
  .stat dt {
    font: 600 10px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 7px;
  }
  .stat dd {
    margin: 0; font: 600 21px/1 ui-monospace, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
  }
  .stat dd small { font-size: 11.5px; font-weight: 400; color: var(--muted); letter-spacing: 0; margin-left: 3px; }
  .stat.is-critical dd { color: var(--critical); }
  .stat.is-caution dd { color: var(--caution); }
  .stat.is-good dd { color: var(--good); }

  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font: 500 11px/1 ui-monospace, Menlo, Consolas, monospace;
    padding: 3.5px 7px; border-radius: 3px; background: var(--sunk);
    border: 1px solid var(--border); color: var(--ink-2); white-space: nowrap;
  }
  .chip.agent { color: var(--accent); background: var(--accent-soft); border-color: transparent; }
  .chip.warn { color: var(--caution); background: var(--caution-soft); border-color: transparent; }
  .chip.crit { color: var(--critical); background: var(--critical-soft); border-color: transparent; }
  .chip.live { color: var(--good); background: transparent; border-color: var(--good); }
  .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--good); animation: pulse 2.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

  .cards { display: flex; flex-direction: column; gap: 9px; }
  .card { border: 1px solid var(--border); border-radius: 5px; background: var(--surface); padding: 12px 14px; }
  .card.is-live { border-color: var(--good); }
  .cardtop { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; margin-bottom: 8px; }
  .cardtop .when { margin-left: auto; font: 400 11.5px/1 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); }
  .cardtitle { font: 500 13px/1.3 ui-monospace, Menlo, Consolas, monospace; color: var(--ink); }
  .paths { display: flex; flex-wrap: wrap; gap: 5px; }
  .pathchip {
    font: 400 11px/1.35 ui-monospace, Menlo, Consolas, monospace; color: var(--ink-2);
    background: var(--sunk); border: 1px solid var(--border); border-radius: 3px; padding: 2.5px 6px;
  }
  .pathchip .dir { color: var(--muted); }
  .commit { margin-top: 8px; font-size: 12px; color: var(--ink-2); display: flex; gap: 7px; align-items: baseline; }
  .commit::before { content: "\\2713"; color: var(--good); font-size: 11px; flex: none; }

  table.dt { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .dt th {
    font: 600 10px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); text-align: right;
    padding: 0 10px 9px; border-bottom: 1px solid var(--rule); white-space: nowrap;
  }
  .dt th:first-child, .dt td:first-child { text-align: left; padding-left: 2px; }
  .dt th.l, .dt td.l { text-align: left; }
  .dt td {
    text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--grid);
    font: 400 12.5px/1.4 ui-monospace, Menlo, Consolas, monospace;
  }
  .dt tbody tr:hover td { background: var(--sunk); }
  .dt .id { color: var(--ink); font-weight: 500; }
  .dt .dim { color: var(--muted); }
  .dt .sub td:first-child { padding-left: 18px; position: relative; }
  .dt .sub td:first-child::before { content: "\\21B3"; position: absolute; left: 4px; color: var(--muted); }
  .dt .sub .id { color: var(--ink-2); font-weight: 400; }

  .barcell { width: 92px; }
  .barwrap { background: var(--heat-0); border-radius: 3px; width: 100%; display: block; }
  .bar { height: 5px; border-radius: 3px; background: var(--heat-3); display: block; min-width: 2px; }

  .stream { display: flex; flex-direction: column; }
  .ev { display: grid; grid-template-columns: 64px 128px 1fr; gap: 12px; align-items: baseline; padding: 8px 4px; border-bottom: 1px solid var(--grid); }
  .ev:hover { background: var(--sunk); }
  .ev .t { font: 400 11.5px/1.5 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); font-variant-numeric: tabular-nums; }
  .ev .tool { font: 500 11px/1.5 ui-monospace, Menlo, Consolas, monospace; color: var(--ink-2); overflow-wrap: anywhere; }
  .ev .op { font: 400 12.5px/1.5 ui-monospace, Menlo, Consolas, monospace; color: var(--ink); overflow-wrap: anywhere; white-space: pre-wrap; }
  .ev .meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 5px; }
  .ev .rolled { font: 400 10.5px/1 ui-monospace, Menlo, Consolas, monospace; color: var(--muted); }

  .mxwrap { overflow: auto; border: 1px solid var(--border); border-radius: 5px; max-height: 62vh; }
  table.mx { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .mx th.corner {
    text-align: left; padding: 8px 10px; font: 600 10px/1 ui-monospace, Menlo, Consolas, monospace;
    letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
    position: sticky; left: 0; top: 0; background: var(--surface); z-index: 3;
  }
  .mx th.col {
    padding: 8px 0 10px; width: 32px; font: 500 10.5px/1 ui-monospace, Menlo, Consolas, monospace;
    color: var(--ink-2); writing-mode: vertical-rl; transform: rotate(180deg);
    white-space: nowrap; height: 112px; vertical-align: bottom;
    position: sticky; top: 0; background: var(--surface); z-index: 2;
  }
  .mx th.col.unattr { color: var(--caution); }
  .mx td.file {
    padding: 0 12px 0 10px; font: 400 12px/1 ui-monospace, Menlo, Consolas, monospace;
    white-space: nowrap; position: sticky; left: 0; background: var(--surface);
    z-index: 1; border-right: 1px solid var(--border);
  }
  .mx td.file .dir { color: var(--muted); }
  .mx tbody tr:hover td.file { background: var(--sunk); }
  .mx td.cell { width: 32px; height: 26px; text-align: center; border: 1px solid var(--surface); }
  .mx td.cell span { display: block; width: 100%; height: 100%; border-radius: 2px; font: 500 10.5px/26px ui-monospace, Menlo, Consolas, monospace; color: transparent; }
  .mx td.cell.h0 span { background: var(--heat-0); }
  .mx td.cell.h1 span { background: var(--heat-1); color: var(--heat-5); }
  .mx td.cell.h2 span { background: var(--heat-2); color: var(--heat-5); }
  .mx td.cell.h3 span { background: var(--heat-3); color: #ffffff; }
  .mx td.cell.h4 span { background: var(--heat-4); color: #ffffff; }
  .mx td.cell.h5 span { background: var(--heat-5); color: #ffffff; }
  .mx td.cell.ua span { background: var(--caution-soft); color: var(--caution); box-shadow: inset 0 0 0 1px var(--caution); }
  .mx td.cell.ua.h0 span { background: var(--heat-0); box-shadow: none; }
  .legend { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }
  .legend i { width: 15px; height: 11px; border-radius: 2px; display: inline-block; }

  .note {
    margin-top: 18px; padding: 12px 14px; border-radius: 5px; background: var(--sunk);
    border: 1px solid var(--border); font-size: 12.5px; line-height: 1.5; color: var(--ink-2);
  }
  .note.warn { background: var(--caution-soft); border-color: transparent; }
  .note b { color: var(--ink); }
  .empty { color: var(--muted); padding: 28px 0; font-size: 13px; }
  .failed { color: var(--critical); }

  @media (max-width: 860px) {
    main { grid-template-columns: 1fr; }
    nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); align-items: center; }
    .navlabel, .navnote { display: none; }
    .lens { width: auto; white-space: nowrap; }
    .lens .route { display: none; }
    .ev { grid-template-columns: 58px 1fr; }
    .ev .tool { display: none; }
  }
</style>
</head>
<body>
<header>
  <div class="titlebar">
    <span class="brand">PatchMesh</span>
    <span class="ledger" id="ledger"></span>
    <button class="control" id="reload" type="button" title="Re-read the ledger">Reload</button>
    <button class="control" id="theme" type="button" title="Toggle light and dark">Theme</button>
  </div>
</header>
<main>
  <nav role="tablist" aria-label="Console lenses">
    <span class="navlabel">Lenses</span>
    <button class="lens" role="tab" data-lens="now"    type="button">Now <span class="route">/</span></button>
    <button class="lens" role="tab" data-lens="agents" type="button">Agents <span class="route">/agents</span></button>
    <button class="lens" role="tab" data-lens="events" type="button">Events <span class="route">/events</span></button>
    <button class="lens" role="tab" data-lens="files"  type="button">Files <span class="route">/files</span></button>
    <button class="lens" role="tab" data-lens="map"    type="button">Map <span class="route">/map</span></button>
    <p class="navnote">Re-reads the ledger on every request. Bound to 127.0.0.1 &mdash; a ledger names every file in a private repository.</p>
  </nav>
  <div class="stage">
    <div class="view" id="view-now"></div>
    <div class="view" id="view-agents" hidden></div>
    <div class="view" id="view-events" hidden></div>
    <div class="view" id="view-files" hidden></div>
    <div class="view" id="view-map" hidden></div>
  </div>
</main>
<script>
(function () {
  "use strict";

  var ROUTES = { now: "/", agents: "/agents", events: "/events", files: "/files", map: "/map" };
  var ENDPOINT = {
    now: "/api/now.json", agents: "/api/agents.json", events: "/api/events.json",
    files: "/api/files.json", map: "/api/map.json"
  };
  var cache = {};
  var NOW = Date.now();

  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  function num(value) { return Number(value || 0).toLocaleString("en-US"); }
  function ago(iso) {
    if (!iso) return "\\u2014";
    var d = Math.max(0, (NOW - new Date(iso).getTime()) / 1000);
    if (d < 90) return Math.round(d) + "s ago";
    if (d < 5400) return Math.round(d / 60) + "m ago";
    if (d < 172800) return Math.round(d / 3600) + "h ago";
    return Math.round(d / 86400) + "d ago";
  }
  function clock(iso) { return String(iso || "").slice(11, 19); }
  function live(iso) { return !!iso && (NOW - new Date(iso).getTime()) < 360000; }
  function splitPath(p) {
    var i = String(p).lastIndexOf("/");
    return i < 0 ? { dir: "", name: p } : { dir: String(p).slice(0, i + 1), name: String(p).slice(i + 1) };
  }
  function pathChip(p) {
    var s = splitPath(p);
    return '<span class="pathchip"><span class="dir">' + esc(s.dir) + "</span>" + esc(s.name) + "</span>";
  }
  function statStrip(items) {
    return '<dl class="stats">' + items.map(function (s) {
      return '<div class="stat' + (s.tone ? " is-" + s.tone : "") + '"><dt>' + esc(s.k) + "</dt><dd>" +
        esc(s.v) + (s.sub ? "<small>" + esc(s.sub) + "</small>" : "") + "</dd></div>";
    }).join("") + "</dl>";
  }
  function boundsNote(b, noun) {
    if (!b || b.withheld <= 0) return "";
    return '<div class="note">Showing the top <b>' + num(b.shown) + "</b> of " + num(b.total) +
      " " + esc(noun) + ". <b>" + num(b.withheld) + " withheld</b> &mdash; every payload here is " +
      "capped, so it cannot grow with the ledger.</div>";
  }

  /* ------------------------------------------------------------- now */
  function renderNow(d) {
    var c = d.counts;
    var inFlight = (d.tasks || []).filter(function (t) { return live(t.endedAt); });
    var pct = c.tasks === 0 ? 0 : Math.round((c.nullAttribution / Math.max(c.events, 1)) * 100);
    var rate = c.totalScopes === 0 ? 0 : Math.round((c.coveredScopes / c.totalScopes) * 100);

    var h = '<div class="vhead"><h1>Now</h1>' +
      (inFlight.length ? '<span class="chip live"><span class="pulse"></span>' + inFlight.length + " in flight</span>" : "") +
      "</div>";
    h += '<p class="vsub">' + (d.window ? "Last <b>" + Math.round(d.window / 60) + "h</b> \\u00b7 " : "") +
      "<b>" + num((d.tasks || []).length) + " of " + num(c.tasks) + " tasks</b> \\u00b7 " +
      "the rest is one click away, not on this screen</p>";

    h += statStrip([
      { k: "Events", v: num(c.events) },
      { k: "Agents", v: num(c.agents) },
      { k: "Tasks", v: num(c.tasks) },
      { k: "Coverage", v: rate + "%", sub: num(c.coveredScopes) + "/" + num(c.totalScopes) },
      { k: "Null attribution", v: num(c.nullAttribution), sub: pct + "%", tone: "caution" },
      { k: "Health", v: d.health, tone: d.health === "healthy" ? "good" : "critical" }
    ]);

    if (!d.tasks || d.tasks.length === 0) {
      h += '<div class="empty">No task has run in this window. If that is a surprise, run ' +
        "<b>patchmesh doctor</b> \\u2014 an empty answer and a broken recorder look identical here.</div>";
    } else {
      h += '<div class="cards">' + d.tasks.map(function (t) {
        var isLive = live(t.endedAt);
        return '<article class="card' + (isLive ? " is-live" : "") + '">' +
          '<div class="cardtop"><span class="cardtitle">' + esc(t.taskId.slice(0, 13)) + "</span>" +
          (t.agentIds || []).map(function (a) {
            return '<span class="chip agent">' + esc(a.slice(0, 14)) + "</span>";
          }).join("") +
          (isLive ? '<span class="chip live"><span class="pulse"></span>in flight</span>' : "") +
          (t.failed ? '<span class="chip crit">' + t.failed + " failed</span>" : "") +
          '<span class="when">' + num(t.calls) + " calls \\u00b7 " + ago(t.endedAt) + "</span></div>" +
          ((t.changedPaths || []).length
            ? '<div class="paths">' + t.changedPaths.map(pathChip).join("") +
              (t.moreChanged ? '<span class="pathchip">+' + t.moreChanged + " more</span>" : "") + "</div>"
            : '<div class="paths"><span class="pathchip">no files changed</span></div>') +
          (t.commits || []).map(function (m) { return '<div class="commit">' + esc(m) + "</div>"; }).join("") +
          "</article>";
      }).join("") + "</div>";
    }

    if (d.truncated) {
      h += '<div class="note">' + num(d.truncated) + " older task(s) in this window are not listed.</div>";
    }
    if (d.unattributedCalls) {
      h += '<div class="note warn"><b>' + num(d.unattributedCalls) + " call(s) belong to no task</b> " +
        "and cannot be summarised as a unit of work. They are counted here rather than dropped. " +
        "A changed file is not a finished intention.</div>";
    }
    return h;
  }

  /* ---------------------------------------------------------- agents */
  function renderAgents(d) {
    var rows = d.rows || [];
    if (rows.length === 0) return '<div class="vhead"><h1>Agents</h1></div><div class="empty">No agent has been observed here.</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.changes; }).concat([1]));
    var active = rows.filter(function (r) { return r.lastAt && (NOW - new Date(r.lastAt).getTime()) < 3600000; }).length;

    var h = '<div class="vhead"><h1>Agents</h1></div>' +
      '<p class="vsub">Sorted by <b>last active</b>, not by id \\u00b7 <b>' + active +
      " active in the last hour</b> \\u00b7 showing " + num(rows.length) + " of " + num(d.bounds.total) + "</p>";

    h += '<table class="dt"><thead><tr><th>Agent</th><th>Last active</th><th>Tasks</th>' +
      "<th>Files</th><th>Changes</th><th>Reads</th>" +
      '<th class="l barcell">Volume</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += "<tr" + (r.parentId ? ' class="sub"' : "") + ">" +
        '<td><span class="id">' + esc(r.short) + "</span>" +
        (live(r.lastAt) ? ' <span class="chip live"><span class="pulse"></span>live</span>' : "") + "</td>" +
        '<td class="' + (live(r.lastAt) ? "" : "dim") + '">' + ago(r.lastAt) + "</td>" +
        "<td>" + num(r.tasks) + "</td><td>" + num(r.files) + "</td><td>" + num(r.changes) + "</td>" +
        '<td class="' + (r.reads ? "" : "dim") + '">' + num(r.reads) + "</td>" +
        '<td class="l barcell"><span class="barwrap"><span class="bar" style="width:' +
        Math.max(2, (r.changes / max) * 100) + '%"></span></span></td></tr>';
    });
    h += "</tbody></table>" + boundsNote(d.bounds, "agents");
    return h;
  }

  /* ---------------------------------------------------------- events */
  function renderEvents(d) {
    var rows = d.rows || [];
    if (rows.length === 0) return '<div class="vhead"><h1>Events</h1></div><div class="empty">No events recorded.</div>';
    var ratio = rows.length === 0 ? 0 : (d.eventsRead / d.bounds.total);

    var h = '<div class="vhead"><h1>Events</h1></div>' +
      '<p class="vsub">Newest first \\u00b7 <b>request and complete collapsed into one row</b> \\u00b7 ' +
      num(d.eventsRead) + " events \\u2192 " + num(d.bounds.total) + " calls (" +
      ratio.toFixed(1) + "\\u00d7) \\u00b7 showing the latest " + num(rows.length) + "</p>";

    h += '<div class="stream">' + rows.map(function (e) {
      var op = String(e.operation || e.tool || "").replace(/^Bash\\s+/, "").trim();
      return '<div class="ev"><span class="t">' + esc(clock(e.at)) + "</span>" +
        '<span class="tool">' + esc(e.tool || "\\u2014") + "</span><span>" +
        '<span class="op">' + esc(op || "\\u2014") + (e.operationTruncated ? '<span class="rolled"> \\u2026</span>' : "") + "</span>" +
        '<span class="meta">' +
        (e.agentShort ? '<span class="chip agent">' + esc(e.agentShort) + "</span>"
                      : '<span class="chip warn">unattributed</span>') +
        (e.failed ? '<span class="chip crit">failed</span>' : "") +
        '<span class="rolled">' + e.events + " event" + (e.events === 1 ? "" : "s") + "</span>" +
        (e.changed || []).map(pathChip).join("") +
        (e.moreChanged ? '<span class="pathchip">+' + e.moreChanged + " more</span>" : "") +
        "</span></span></div>";
    }).join("") + "</div>";
    h += boundsNote(d.bounds, "calls");
    return h;
  }

  /* ----------------------------------------------------------- files */
  function renderFiles(d) {
    var rows = d.rows || [];
    if (rows.length === 0) return '<div class="vhead"><h1>Files</h1></div><div class="empty">No file has been changed here.</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.changes; }).concat([1]));

    var h = '<div class="vhead"><h1>Files</h1></div>' +
      '<p class="vsub">Ranked by churn \\u00b7 <b>' + num(d.counts.contested) + " of " + num(d.counts.files) +
      " files were changed by more than one agent</b> \\u00b7 showing " + num(rows.length) +
      " of " + num(d.bounds.total) + " changed</p>";

    h += statStrip([
      { k: "Files", v: num(d.counts.files) },
      { k: "Changes", v: num(d.counts.changes) },
      { k: "Contested", v: num(d.counts.contested), tone: "caution" },
      { k: "Unattributed", v: num(d.counts.unattributedChanges), tone: "critical" }
    ]);

    h += '<table class="dt"><thead><tr><th>Path</th><th>Changes</th><th>Agents</th>' +
      "<th>Unattributed</th><th>Last touched</th>" +
      '<th class="l barcell">Churn</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr><td class="l"><span class="dim">' + esc(r.dir ? r.dir + "/" : "") + '</span><span class="id">' +
        esc(r.name) + "</span></td><td>" + num(r.changes) + "</td>" +
        "<td>" + (r.contested ? '<span class="chip warn">' + r.agents.length + "</span>" : num(r.agents.length)) + "</td>" +
        "<td>" + (r.unattributed ? '<span class="chip crit">' + r.unattributed + "</span>" : '<span class="dim">0</span>') + "</td>" +
        '<td class="dim">' + ago(r.lastAt) + "</td>" +
        '<td class="l barcell"><span class="barwrap"><span class="bar" style="width:' +
        Math.max(2, (r.changes / max) * 100) + '%"></span></span></td></tr>';
    });
    h += "</tbody></table>" + boundsNote(d.bounds, "changed files");
    return h;
  }

  /* ------------------------------------------------------------- map */
  function renderMap(d) {
    var rows = d.rows || [];
    if (rows.length === 0) return '<div class="vhead"><h1>Map</h1></div><div class="empty">No change to map yet.</div>';

    var h = '<div class="vhead"><h1>Map</h1></div>' +
      '<p class="vsub">Agents \\u00d7 files \\u00b7 every cell is a change count \\u00b7 <b>top ' +
      num(rows.length) + " files \\u00d7 " + num(d.agents.length) +
      " busiest agents</b> \\u00b7 a row with more than one mark is a contested file</p>";

    h += '<div class="mxwrap"><table class="mx"><thead><tr><th class="corner">File</th>' +
      d.agents.map(function (a) { return '<th class="col">' + esc(a.short) + "</th>"; }).join("") +
      '<th class="col unattr">unattributed</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      h += '<tr><td class="file"><span class="dir">' + esc(r.dir ? r.dir + "/" : "") + "</span>" + esc(r.name) + "</td>" +
        r.cells.map(function (v) {
          return '<td class="cell h' + Math.min(5, v) + '"><span>' + v + "</span></td>";
        }).join("") +
        '<td class="cell ua h' + Math.min(5, r.unattributed) + '"><span>' + r.unattributed + "</span></td></tr>";
    });
    h += "</tbody></table></div>";

    h += '<div class="legend">Changes per agent, per file:' +
      [0, 1, 2, 3, 4, 5].map(function (n) { return '<i style="background:var(--heat-' + n + ')"></i>'; }).join("") +
      "<span>0 \\u2192 5+</span>" +
      '<i style="background:var(--caution-soft);box-shadow:inset 0 0 0 1px var(--caution)"></i>' +
      "<span>unattributed</span></div>";

    if (d.othersColumn) {
      h += '<div class="note">Some changes on these files belong to agents outside the busiest ' +
        num(d.agents.length) + ", so a row's marks can total less than its change count.</div>";
    }
    h += boundsNote(d.files, "changed files");
    return h;
  }

  var RENDER = { now: renderNow, agents: renderAgents, events: renderEvents, files: renderFiles, map: renderMap };

  function lensFromPath(path) {
    for (var key in ROUTES) { if (ROUTES[key] === path) return key; }
    return "now";
  }

  function show(lens, push) {
    var buttons = document.querySelectorAll(".lens");
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].setAttribute("aria-selected", String(buttons[i].getAttribute("data-lens") === lens));
    }
    for (var key in RENDER) {
      document.getElementById("view-" + key).hidden = key !== lens;
    }
    if (push && window.history && window.history.pushState) {
      window.history.pushState({ lens: lens }, "", ROUTES[lens]);
    }
    paint(lens);
  }

  function paint(lens) {
    var target = document.getElementById("view-" + lens);
    if (cache[lens]) { target.innerHTML = RENDER[lens](cache[lens]); return; }
    target.innerHTML = '<div class="empty">Reading the ledger\\u2026</div>';
    fetch(ENDPOINT[lens]).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).then(function (data) {
      if (data && data.error) throw new Error(data.error);
      cache[lens] = data;
      NOW = Date.now();
      if (data.ledger) document.getElementById("ledger").textContent = data.ledger;
      target.innerHTML = RENDER[lens](data);
    }).catch(function (error) {
      target.innerHTML = '<div class="empty">Could not read this lens: ' + esc(error.message) +
        ". The ledger may be mid-write \\u2014 try Reload.</div>";
    });
  }

  var navButtons = document.querySelectorAll(".lens");
  for (var i = 0; i < navButtons.length; i += 1) {
    navButtons[i].addEventListener("click", function (event) {
      show(event.currentTarget.getAttribute("data-lens"), true);
    });
  }
  window.addEventListener("popstate", function () { show(lensFromPath(window.location.pathname), false); });
  document.getElementById("reload").addEventListener("click", function () {
    cache = {};
    NOW = Date.now();
    show(document.querySelector('.lens[aria-selected="true"]').getAttribute("data-lens"), false);
  });
  document.getElementById("theme").addEventListener("click", function () {
    var root = document.documentElement;
    var dark = root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", dark ? "light" : "dark");
  });

  show(lensFromPath(window.location.pathname), false);
})();
</script>
</body>
</html>
`;
