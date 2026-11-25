import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDispatch, tick } from "./index.mjs";

const now = Date.parse("2026-11-25T20:00:00Z");
const run = (status, startedMinAgo) => ({ status, run_started_at: new Date(now - startedMinAgo * 60000).toISOString() });

test("dispatches when every recent run is completed (the 2026-11-25 gap)", () => {
  assert.equal(shouldDispatch([run("completed", 50), run("completed", 71)], now), true);
  assert.equal(shouldDispatch([], now), true);
});
test("leaves a queued or running probe alone (one-round or #3444 loop)", () => {
  assert.equal(shouldDispatch([run("in_progress", 120)], now), false);
  assert.equal(shouldDispatch([run("queued", 1)], now), false);
});
test("a run stuck for over 6.5 h does not block a restart", () => {
  assert.equal(shouldDispatch([run("in_progress", 400)], now), true);
});
test("tick dispatches probe.yml on main with the token, and only when idle", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push([init.method ?? "GET", url, init.headers.authorization, init.body]);
    if (url.includes("/runs?")) return new Response(JSON.stringify({ workflow_runs: [run("completed", 30)] }), { status: 200 });
    return new Response(null, { status: 204 });
  };
  assert.deepEqual(await tick({ REPO: "loootai/looot-status", GITHUB_TOKEN: "t" }, now), { dispatched: true });
  assert.deepEqual(calls[1], ["POST", "https://api.github.com/repos/loootai/looot-status/actions/workflows/probe.yml/dispatches", "Bearer t", '{"ref":"main"}']);
  globalThis.fetch = async () => new Response(JSON.stringify({ workflow_runs: [run("in_progress", 3)] }), { status: 200 });
  assert.equal((await tick({ REPO: "r", GITHUB_TOKEN: "t" }, now)).dispatched, false);
});
test("a GitHub error throws so the cron run shows as failed in Cloudflare", async () => {
  globalThis.fetch = async () => new Response("Bad credentials", { status: 401 });
  await assert.rejects(tick({ REPO: "r", GITHUB_TOKEN: "x" }, now), /401/);
});
