#!/usr/bin/env node
// looot status probe (#3353). Runs in the public data repo loootai/looot-status every 5 minutes (GitHub Actions on a
// public repo cost no minutes), outside Render and Vercel. It checks four components with plain unauthenticated
// requests (no key, no paid call), keeps 90 days of daily up/total counts, reads the incident notes in incidents/*.md
// and writes one file, status.json, that looot.ai/status reads. Dependency-free on purpose: Node 20+ only.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Days of history kept and shown. */
export const HISTORY_DAYS = 90;
/** A check slower than this counts as up but slow (degraded). */
export const SLOW_MS = 5000;
const TIMEOUT_MS = 15000;
const INCIDENT_STATES = new Set(["investigating", "identified", "monitoring", "resolved"]);

/** The components on the page and how each is checked; `accept` decides up or down from the answer. */
export const COMPONENTS = [
  {
    id: "api",
    name: "API gateway",
    description: "REST API, CLI and runs",
    request: { url: "https://api.looot.ai/ready", method: "GET" },
    accept: (res) => res.status === 200 && /"status"\s*:\s*"ok"/.test(res.body),
  },
  {
    id: "dashboard",
    name: "Dashboard",
    description: "Sign-in and the looot.ai dashboard",
    request: { url: "https://looot.ai/auth/sign-in", method: "GET" },
    accept: (res) => res.status === 200,
  },
  {
    id: "catalog",
    name: "Catalog",
    description: "Search and the public catalog",
    request: { url: "https://api.looot.ai/v1/public-catalog?limit=1", method: "GET" },
    accept: (res) => res.status === 200 && /"items"\s*:\s*\[\s*\{/.test(res.body),
  },
  {
    id: "mcp",
    name: "MCP",
    description: "The MCP server at api.looot.ai/mcp",
    // Without a key the MCP route answers 401 with a WWW-Authenticate challenge: that proves the route and its auth layer answer.
    request: {
      url: "https://api.looot.ai/mcp",
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "looot-status-probe", version: "1" } } }),
    },
    accept: (res) => res.status === 401 && Boolean(res.wwwAuthenticate),
  },
];

/** Turns one answer (or a network error) into a check result: ok, slow or down, with the status code and time taken. */
export function classifyCheck(component, res, at) {
  if (res.error) return { at, ok: false, slow: false, status: null, ms: res.ms ?? null, error: String(res.error).slice(0, 120) };
  const ok = component.accept(res);
  return { at, ok, slow: ok && res.ms > SLOW_MS, status: res.status, ms: res.ms, error: ok ? null : `unexpected answer ${res.status}` };
}

async function runRequest(request) {
  const started = Date.now();
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { "user-agent": "looot-status-probe", ...(request.headers ?? {}) },
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, 4000);
    return { status: response.status, body, wwwAuthenticate: response.headers.get("www-authenticate"), ms: Date.now() - started };
  } catch (error) {
    return { error: error?.name === "TimeoutError" ? `timeout after ${TIMEOUT_MS} ms` : error?.message ?? "request failed", ms: Date.now() - started };
  }
}

/** Adds one round of checks to the state: the last 3 results per component and the daily up/total counts, trimmed to 90 days. */
export function recordChecks(previous, checks, now) {
  const day = now.toISOString().slice(0, 10);
  const days = { ...(previous?.days ?? {}) };
  const recent = { ...(previous?.recent ?? {}) };
  for (const [id, check] of Object.entries(checks)) {
    const bucket = { ...(days[day] ?? {}) };
    const counts = bucket[id] ?? { up: 0, total: 0 };
    bucket[id] = { up: counts.up + (check.ok ? 1 : 0), total: counts.total + 1 };
    days[day] = bucket;
    recent[id] = [check, ...(recent[id] ?? [])].slice(0, 3);
  }
  const oldest = new Date(now.getTime() - (HISTORY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(days)) if (key < oldest) delete days[key];
  return { days, recent };
}

/** Current state of one component from its last results and any open incident: up, degraded or down. Two failures in a row are down, one is degraded. */
export function componentState(recent, openIncidentImpact) {
  let state = "up";
  if (recent?.length) {
    if (!recent[0].ok && recent[1] && !recent[1].ok) state = "down";
    else if (!recent[0].ok || recent[0].slow) state = "degraded";
  } else state = "unknown";
  if (openIncidentImpact === "down") return "down";
  if (openIncidentImpact && state === "up") return "degraded";
  return state;
}

/** Parses one incident note: front matter (title, status, components, impact, started, resolved) and "## <time UTC>, <status>" updates, newest first. */
export function parseIncident(id, text) {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${id}: missing front matter`);
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!meta.title) throw new Error(`${id}: title is required`);
  const status = (meta.status || "investigating").toLowerCase();
  if (!INCIDENT_STATES.has(status)) throw new Error(`${id}: status must be one of ${[...INCIDENT_STATES].join(", ")}`);
  const known = new Set(COMPONENTS.map((c) => c.id));
  const components = (meta.components || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of components) if (!known.has(c)) throw new Error(`${id}: unknown component ${c}`);
  const updates = [];
  for (const section of match[2].split(/^## /m).slice(1)) {
    const [heading, ...rest] = section.split("\n");
    const head = /^(.+?),\s*([a-z]+)\s*$/i.exec(heading.trim());
    updates.push({ at: head ? head[1].trim() : heading.trim(), status: head ? head[2].toLowerCase() : null, body: rest.join("\n").trim() });
  }
  return {
    id,
    title: meta.title,
    status,
    impact: meta.impact === "down" ? "down" : "degraded",
    components,
    started: meta.started || null,
    resolved: meta.resolved || null,
    updates,
  };
}

/** Reads incidents/*.md (files starting with "_" are templates), newest first; a broken note fails the run so it is fixed, never silently dropped. */
export function readIncidents(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .sort()
    .reverse()
    .map((name) => parseIncident(name.replace(/\.md$/, ""), readFileSync(join(dir, name), "utf8")));
}

/** Builds the published status.json from the probe state and the incidents. */
export function buildStatus(state, incidents, now) {
  const open = incidents.filter((i) => i.status !== "resolved");
  return {
    version: 1,
    generatedAt: now.toISOString(),
    components: COMPONENTS.map((c) => {
      const impact = open.filter((i) => i.components.includes(c.id)).reduce((worst, i) => (worst === "down" || i.impact === "down" ? "down" : "degraded"), null);
      const recent = state.recent[c.id] ?? [];
      return { id: c.id, name: c.name, description: c.description, state: componentState(recent, impact), lastCheck: recent[0] ?? null };
    }),
    days: state.days,
    incidents,
  };
}

async function main() {
  const root = process.cwd();
  const statePath = join(root, "status.json");
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const incidents = readIncidents(join(root, "incidents"));
  const now = new Date();
  const checks = {};
  if (process.argv.includes("--incidents-only")) {
    // An incident edit republishes at once without adding a check round.
  } else {
    const answers = await Promise.all(COMPONENTS.map((c) => runRequest(c.request)));
    COMPONENTS.forEach((c, i) => (checks[c.id] = classifyCheck(c, answers[i], now.toISOString())));
  }
  const state = recordChecks(previous ? { days: previous.days, recent: previous.recentChecks ?? {} } : null, checks, now);
  const status = { ...buildStatus(state, incidents, now), recentChecks: state.recent };
  writeFileSync(statePath, `${JSON.stringify(status, null, 1)}\n`);
  for (const c of status.components) console.log(`${c.id}: ${c.state} ${c.lastCheck ? `${c.lastCheck.status ?? c.lastCheck.error} ${c.lastCheck.ms} ms` : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
