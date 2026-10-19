# PKB Ops — handoff for a new Claude session

Read this first, then `README.md` and `ARCHITECTURE.md`. Owner: **Victor Kubrusly** (victor@pkbhomes.com),
writes in Portuguese; UI text in English. State as of 2026-10-12.

## Working rules (Victor)
- **Only state a number, cause or conclusion the data shows**, with the jobs/items behind it, the
  period and the source. A cause only when a county comment / Daily Log says it ("reason not stated"
  otherwise). County wording: "Revisions Required" is a correction, not a denial. If there is no data, say so.
- Never paste passwords/tokens in chat; secrets live in GitHub secrets / Supabase / the session environment.
- Don't bypass CAPTCHAs/WAF. Buildertrend cookies stay out of the repo.
- Never delete jobs in Buildertrend. Write to Buildertrend only where Victor said so (Daily Logs from
  rules / field / Ask, Lead Opportunities after confirmation, "Permit number" field when empty, Schedule
  items marked complete from county evidence — `rules/bt_schedule.mjs`, `config/bt_schedule_map.json`, never un-marks).
- Ask before any new outward-facing send (e-mail to outside PKB) or data deletion.
- Merging your own PRs into the default branch is authorized. Default branch: `claude/new-session-zkg2g6`.
- Reading the bot mailbox (botpkbhomes@gmail.com) and marking messages read is authorized.

## Access
- Database: `cd ops && npm ci && node -e "import('./scripts/sb.mjs').then(async m=>console.log(await m.sql('select 1')))"`
  (`sql()` uses `SUPABASE_ACCESS_TOKEN`, Management API; project `fvjknahpmihueyeasgbx`). The `ops`
  schema is not exposed to the API; the portal uses SECURITY DEFINER RPCs in `public`.
  In Claude sessions the token comes from the Claude environment "PKB Ops" (network: full); only
  sessions started after a secret change pick it up.
- GitHub logs can't be downloaded from a session; use job steps + check-run annotations. Probes report
  through `::notice::` annotations (`ops-probe.yml`, `collectors/buildertrend/probe.mjs`).

## Secrets (names and where they live — never the values)
- GitHub Actions secrets: `SUPABASE_ACCESS_TOKEN` (expires 10/2027; the watchdog e-mails Victor if it
  is refused), `BT_COOKIES_JSON` (bot's Buildertrend session), `BOT_EMAIL_PASSWORD` (bot Gmail app
  password). Repo variables: `OPS_SEND_ENABLED`, `OPS_BT_POST`, `OPS_R1_ENABLED`.
- Supabase: Edge Function secret `ANTHROPIC_API_KEY`; Vault `github_actions_token` (GitHub token with
  Actions permission, used by pg_cron to dispatch workflows).
- Claude environment "PKB Ops": `SUPABASE_ACCESS_TOKEN`.

## How it runs
- **Clock:** Supabase pg_cron (migration 0031) dispatches GitHub workflows — `ops-daily` rounds at
  4 AM, 9, 11 AM, 1, 3, 5 PM Florida (13 min early), `ops-mail` hourly :07, `ops-bt-post` hourly :25.
  Token: Vault secret `github_actions_token`. GitHub's own cron lines remain as fallback; the
  ops-daily gate skips them when a dispatched round started in the last 70 min. `ops-watchdog`
  (every 15 min) restarts a missed round and e-mails Victor if the Supabase token is refused.
- **Round (`ops-daily`, ~30 min; ~50 with Buildertrend photos at 4 AM / 1 PM):** Buildertrend jobs +
  custom fields → (photos) → Daily Logs text → permit discovery (`scripts/discover_permits.mjs`, all
  counties with a portal; applicant must be Prime Kubrusly Basso / Cristiano Pedrosa) → county portals
  in parallel (`scripts/collect_all.mjs`) → load → Buildertrend "Permit number" → inspection plans →
  rules → portal snapshot → Buildertrend Daily Logs.
- **Immediate posting:** trigger `bt_post_now` (0032) dispatches `ops-bt-post` when a FIELD/ASK Daily
  Log or a confirmed lead becomes a draft.
- **Portal** budget.pkbhomes.com/ops/ (`frontend/public/ops/index.html`, GitHub Pages) reads
  `ops.snapshots` (board) + live outbox. **Field channel** /ops/field/. **Ask** = Edge Function
  `supabase/functions/ops-ask` (Sonnet 5.5; tools incl. `search_daily_logs`, `get_daily_logs`
  with coverage gaps). Field = `supabase/functions/ops-field`. Anthropic key: Supabase secret
  `ANTHROPIC_API_KEY` (on 10/12 the account behind it hit its spend limit, blocked until 11/01 —
  Ask/field summaries fail until the key is replaced with one from an org with credit).
- **Portal roles** (`ops.portal_users`): admin Victor; partners Thiago, Guilherme, Cristiano, Daniela,
  Gabriel; pm Carlos, Camila; field supervisors.
- **Permit office:** Sovereign coordinates Marion, Citrus and house 0042; everything else PKB (Guilherme).

## Claude routines (claude.ai, Team account since 2026-10-12)
- "PKB Ops — pedidos de mudança (diário)" 7:52 AM Florida: works open `ops.change_requests`, opens PRs
  (doesn't merge), writes the answer on the request.
- "PKB Ops — sugestões de melhoria (semanal)" Monday 6:41 AM Florida: updates `ops.suggestions` from the
  last month of data, respects Victor's Accept/Dismiss (migration 0033), follows the accuracy rules
  above, writes only to that table.
- Both start a fresh session in the "PKB Ops" environment and clone the repo themselves (tested 10/12:
  token present, `sb.mjs` query OK). Pending: add `vkubrusly/PKB` as a source of both routines in
  claude.ai → Routines so they can push and open PRs. The old account's routines were disabled 10/12.

## Open items
- Orange (FastTrack): collected every round since 2026-10-14 with both contractor logins (GitHub secrets
  `ORANGE_PORTAL_USER/PASS`, `ORANGE_PORTAL_USER_2/PASS_2`; which permit is on which login:
  `config/fasttrack_accounts.json`). Reviewer comments and inspector notes come from the portal's PDF reports.
  Not read yet: permits older than 6 months (My Permit Search). Dry run: `ops-probe.yml` → fasttrack-collect. S050 (BLD2026-16696) is a City of Orlando
  number, not Fast Track. Lake (S051) has no collector.
- City of Orlando houses (0041, 0060, 0061, 0072) have no permit search.
- S043: permit number BLD202502570 doesn't exist on the Citrus portal — needs the right number.
- Pre-permit data still partly comes from a static spreadsheet CSV (2026-09-25).
- Field channel barely used (1 confirmed report in October) — adoption with the supervisors.
- `ANTHROPIC_API_KEY`: replace with a key from an org with credit (Ask and field summaries down).
- WhatsApp channel, STT provider for audio/video, DocuSign: waiting on Victor.
