// looot status keeper (#3353). A Cloudflare Worker with a Cron Trigger every 5 minutes (free tier). GitHub's own schedule
// skips hours (2026-11-25: runs only at 08:28, 18:49, 19:10 UTC), so this Worker is the timer: it asks GitHub whether a
// probe run is queued or running and, if none is, starts .github/workflows/probe.yml with workflow_dispatch. The probe
// itself and status.json stay exactly as they are (the page keeps reading raw.githubusercontent .../status.json), so it
// works with today's one-round probe and with #3444's long-running loop job: a running loop is left alone, a dead one is
// restarted within 5 minutes. Secret GITHUB_TOKEN: fine-grained, this repo only, Actions read and write.

/** The workflow file this keeper starts. */
export const WORKFLOW = "probe.yml";
/** A queued or running probe older than this is treated as stuck and does not block a new dispatch (#3444 loops ~5h45m). */
export const STUCK_MS = 6.5 * 3600 * 1000;

/** Decides from the workflow's recent runs whether to dispatch: true when no run is queued or in progress (stuck ones ignored). */
export function shouldDispatch(runs, now) {
  return !runs.some((r) => ["queued", "in_progress", "waiting", "pending", "requested"].includes(r.status) && now - Date.parse(r.run_started_at ?? r.created_at) < STUCK_MS);
}

/** Calls the GitHub REST API with the Worker's token. */
async function github(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "looot-status-keeper", "x-github-api-version": "2022-11-28", ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 204) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

/** One keeper tick: list the last runs, dispatch the probe when none is active. Returns what it did, for the logs. */
export async function tick(env, now = Date.now()) {
  const { workflow_runs: runs } = await github(env, `/actions/workflows/${WORKFLOW}/runs?per_page=20`);
  if (!shouldDispatch(runs, now)) return { dispatched: false, active: runs.filter((r) => r.status !== "completed").length };
  await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: JSON.stringify({ ref: env.BRANCH ?? "main" }) });
  return { dispatched: true };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => console.log(JSON.stringify(r))));
  },
  async fetch() {
    return new Response("looot status keeper: no public routes. Status: https://looot.ai/status\n", { status: 404 });
  },
};
