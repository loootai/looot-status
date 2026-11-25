# looot-status

Data behind [looot.ai/status](https://looot.ai/status). Source of truth for these files: `scripts/status/data-repo` in
loootai/coset-gateway (#3353); change them there by PR and copy them here.

- `probe.mjs` checks the API gateway, the dashboard, the catalog and MCP every 5 minutes (`.github/workflows/probe.yml`),
  with plain requests and no key, and writes `status.json`: the current state, the last check, 90 days of daily counts
  and the incidents.
- `incidents/` holds one markdown note per incident. Copy `incidents/_TEMPLATE.md` to `incidents/<date>-<slug>.md`,
  fill it in with the wording of the approved outage notice (B1, B2, B3 in
  `docs/security/customer-incident-notice-templates.md`) and push. The page shows it within a few minutes.
  - `status`: investigating, identified, monitoring or resolved. `impact`: degraded or down.
  - `components`: any of api, dashboard, catalog, mcp, comma separated.
  - Add each update as a new `## <time> UTC, <status>` section at the top of the updates; set `resolved:` and
    `status: resolved` when it is over.
- Never put a key, a customer's name or internal detail in a note: this repo is public.

## Timer: the keeper Worker

GitHub's schedule skips hours, so a Cloudflare Worker (`worker/index.mjs`, `wrangler.toml`, Cron Trigger every 5 minutes,
free tier) starts `probe.yml` by `workflow_dispatch` whenever no probe run is queued or running. The cron lines in
`probe.yml` stay as a fallback. Test: `node --test worker/index.test.mjs`. Deploy: `npx wrangler deploy` and
`npx wrangler secret put GITHUB_TOKEN` (fine-grained, this repo only, Actions read and write).
