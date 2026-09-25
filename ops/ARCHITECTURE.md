# PKB Ops — architecture

Status: **draft for validation** (2026-09-25). Nothing here is code yet except the
Marion County collector in `collectors/energov/`.

## 1. Principles

1. **PKB Ops is the operational source of truth.** County portals, e-mail and
   Buildertrend are *sources* (we read) or *destinations* (we write), never where
   state lives. If a bridge breaks, operations continue; only the copy lags.
2. **Everything becomes an event.** Every observed change ("review v4 denied by
   Building Plans", "Framing inspection passed", "contract signed") is appended
   to an immutable timeline. Current state = latest reading; KPIs = reading the
   history.
3. **One engine, several modules.** Permits, Inspections, Contracts and Field are
   configurations of the same skeleton: *connector → event → rule → action*.
4. **AI proposes, a person approves** (at first). E-mails to the designer,
   vendors and clients are born as drafts with a "Send" button. Once the edit
   rate drops, rules are switched to automatic one by one.
5. **Portable.** Runs on Supabase + Node; secrets in `.env`; nothing tied to the
   development environment.

## 2. Overview

```
SOURCES                        PKB OPS (Supabase + Node workers)                 DESTINATIONS
───────                        ─────────────────────────────────                 ────────────
EnerGov portals ──┐            ┌──────────┐   ┌────────┐   ┌───────┐   ┌───────┐  E-mail (designer,
 (Marion, Citrus, Orange)      │collectors├──▶│ events ├──▶│ rules ├──▶│actions├─▶ vendors, client)
Bot mailbox (IMAP) ───┤        └──────────┘   └────────┘   └───────┘   └───────┘  Buildertrend (RPA)
Buildertrend (notif.) ┤              ▲             │                        │      WhatsApp/SMS (phase 2)
Website (contract form)┤             │             ▼                        ▼
Field app (audio/photo)              │        ┌──────────┐            ┌──────────┐
                                     └────────┤  state   │◀───────────┤dashboard │
                                              └──────────┘            └──────────┘
```

Three real processes run:

| Process | What it does | Frequency |
|---|---|---|
| `collect` | reads portals, the bot mailbox, Buildertrend notifications; writes new events | portals 1×/day (06:00), e-mail every 15 min |
| `rules` | evaluates rules over new events; creates tasks, drafts, notifications | after each `collect` |
| `bridge` | executes approved actions: sends e-mail, writes Daily Logs to Buildertrend | continuous |

## 3. Modules

### 3.1 Permits (phase 1)
From contract signature to permit issued, including Septic (FDEP), Civic
Association (Citrus), impact fees, NOC, and the blockers below.

- Input: EnerGov collector (public), e-mail (designer, FDEP/septic designer, surveyor, county), spreadsheet (initial load).
- State per permit: portal status + **"ball with"** (county / sovereign / surveyor / shady / fdep / pkb / owner / blocked).
- Output: correction e-mail to the designer; 48 h follow-up; vendor requests on triggers; Buildertrend Daily Log on every change.

**Blockers and pauses.** Two things stop a job without being a permit process:

- *Turtle*: a gopher tortoise on the lot requires a tortoise survey and relocation
  before impact fees can be paid. Modeled as a job blocker with state
  (`none` / `survey_requested` / `relocation_pending` / `cleared`) and dates.
- *Job pauses*: the client asked for the permit but will wait to start; waiting
  for the 1st draw; waiting to sell to pay impact fees; waiting for the warranty
  deed. Modeled as `job_pauses(reason, started_at, ended_at)`. While a pause is
  open the job shows a badge instead of raising "stalled" alerts, and **every KPI
  clock subtracts the paused interval** (applied→issued, issued→foundation,
  construction time). A pause closes automatically when construction actually
  starts (first inspection requested, or the supervisor marks the start).

### 3.2 Inspections (phase 1, same collector)
- Input: the portal's Inspections tab (status, inspector, dates, reinspection) + county e-mail.
- Output: pass/fail notice to supervisor and sub with the inspector's comment; next step from the standard sequence; failure KPIs by type / inspector / sub.

### 3.3 Contracts and new jobs (phase 2)
- Input: website form e-mail → `contracts` (draft); signature (DocuSign/PandaDoc or signed PDF by e-mail) → `contract.signed` event.
- Output: follow-up until signed; on signature: create `job`, open `permit_case`, create the Buildertrend Job (RPA), issue the 1st draw invoice.

### 3.4 Field (phase 2)
- Input: supervisor sends audio + photos per house (simple app or WhatsApp).
- AI transcribes, summarizes, suggests the completed phase; supervisor confirms with one tap.
- Output: Daily Log + photos in Buildertrend; `field.report` event.

### 3.5 Full construction tracking and Finance (phase 3) — out of scope for this draft.

## 4. Connectors

| Connector | Direction | Technique | Credential | Status |
|---|---|---|---|---|
| EnerGov Marion | read | Playwright over the public UI; captures the portal's own JSON | none | **validated** |
| EnerGov Citrus / Orange / Charlotte | read | same, if they run EnerGov | tbd | waiting for URLs |
| Bot mailbox (Gmail) | read / send | IMAP + SMTP with an app password | `BOT_EMAIL_PASSWORD` | waiting for variable |
| Buildertrend | read notifications (invoice paid, overdue) / write Daily Log, photos, schedule | notification e-mails to the bot mailbox (read); RPA with the `PKB Ops Bot` user (write); API if granted | `BUILDERTREND_PASS` | user to be created |
| Website (contract form) | read | the e-mail the form already sends | — | phase 2 |
| Claude API | process | read review comments, classify causes, draft e-mails, transcribe audio | `ANTHROPIC_API_KEY` | — |

Every connector implements the same interface: `pull(since) → Event[]` and, when
it writes, `push(action) → Result`. Swapping RPA for an API in Buildertrend
touches nothing else.

## 5. Data model (schema `ops` in the same Supabase project)

Reuses `orgs` and `projects` from the estimator (a `job` points to its `project`
when an estimate exists).

```
jobs                 one house/build. address, parcel, county, model, owner, company (PKB/Prime),
                     contract_value, signed_at, draws, bt_job_name, project_id (→ projects), status,
                     turtle_state, turtle_survey_requested_at, turtle_cleared_at
job_pauses           reason (owner_deferred_start | awaiting_1st_draw | awaiting_impact_fees |
                     awaiting_warranty_deed | turtle | other), started_at, ended_at, note
job_contacts         designer (Sovereign), surveyor (Bailey), septic designer, subs; e-mails for requests

permit_cases         one per job and process type: building | septic | civic_assoc | impact_fees | noc | survey
                     county, portal_case_id, number, portal_status, ops_status, ball_with (county|sovereign|surveyor|shady|fdep|pkb|owner|blocked),
                     tracked_by (designer|pkb)  -- affordable: Sovereign drives resubmissions; custom: PKB does
                     applied_at, issued_at, last_collected_at
submittals           rounds: version, submitted_at, due_at, completed_at, status
review_items         per round and department: department, status, reviewer, reviewer_email, due_at, completed_at,
                     comments, cause_tags[] (AI: energy_calc, truss, digital_seal, site_plan, septic, ...)
inspections          number, type, status, requested_at, scheduled_at, actual_at, inspector, reinspection, passed, failed,
                     comments, cause_tags[]
holds                name, type, reason, comments, created_at, active

events               immutable timeline: job_id, permit_case_id?, kind, source (energov|email|buildertrend|user|rule),
                     occurred_at, payload jsonb, dedupe_key unique
tasks                follow-ups: kind (email_designer|followup_48h|vendor_request|...), due_at, status, assignee, payload
outbound_messages    drafts and sends: channel (email|whatsapp|bt_daily_log), to, subject, body, status (draft|approved|sent|failed),
                     approved_by, sent_at, in_reply_to_event
vendor_requests      per job: type (survey|stakeout|septic_design|noc|power|water|dumpster...), trigger_event, sent_at, done_at
contracts            phase 2: source_email, client, lot, model, value, status (requested|drafted|sent|signed), signed_at, job_id
field_reports        phase 2: job_id, supervisor, audio_path, photos[], transcript, summary, suggested_phase, confirmed
collector_runs       audit: connector, started_at, finished_at, items, errors
rules                active rules and mode (draft|auto) per rule
```

Idempotency keys: `events.dedupe_key` (e.g. `energov:review_item:<ItemReviewId>:<status>`),
`submittals(permit_case_id, version)`, `inspections(permit_case_id, number)`.

## 6. Rules v1 (all start in *draft* mode)

| # | Trigger | Action |
|---|---|---|
| R0 | `invoice.paid` for the 1st (licensing) invoice (Buildertrend payment e-mail) | draft the "start licensing" e-mail to Sovereign with the job data; on send `ball_with = sovereign`; open `permit_cases` building + septic + survey (see `docs/PROCESS_PERMITS.md`) |
| R1 | new `review_item.status = Requires Re-submit` | draft e-mail to the designer with the corrections itemized from the reviewer's comment; `ball_with = designer`; follow-up task at +48 h |
| R2 | follow-up task due and no new `submittal` | new follow-up to the designer; every 2 cycles escalate to `OPS_NOTIFY_EMAIL` |
| R3 | new `submittal` appears | close follow-ups; `ball_with = county`; Daily Log "Resubmitted v{n}" |
| R4 | `permit_case.status → Issued` | `permit.issued` event; fire `vendor_requests` configured for "after issuance"; Daily Log |
| R5 | new `hold.active = true` | immediate alert (e-mail) with the reason; `ball_with = pkb` |
| R6 | `permit_case` with no event for N days (N per status), and no open pause | "stalled" flag on the dashboard and in the weekly digest |
| R7 | new `inspection.failed` | notice to supervisor + responsible sub with the comment; "reschedule" task; Daily Log |
| R8 | new `inspection.passed` | notice to supervisor with the next step in the sequence; Daily Log; closes an open `owner_deferred_start` pause if it is the first inspection |
| R9 | any permit/inspection change | Buildertrend Daily Log with the change text (one entry per day per job) |
| R10 | website form e-mail (phase 2) | create draft `contract`; task for Guilherme; follow-up until `signed` |

## 7. Dashboard (v1 screens)

1. **Today** — exceptions: active holds, denied reviews without a reply, overdue follow-ups, failed inspections, stalled permits. Each row with an action button (approve draft, mark resolved).
2. **Permits** — the spreadsheet, alive: one row per job, columns per process (BP, Septic, Civic, ...), turtle/pause badges, "ball with", days in state. Filters by county / company / owner of the step. A separate strip: "N houses with permit ready waiting on the client", with days waiting.
3. **Permit** — one job's timeline: rounds, comments per department, e-mails sent, inspections, holds, pauses.
4. **KPIs** — applied→issued days by county / model / designer (pauses excluded); county days vs. resubmission days; failure causes by department; inspection failure rate by type / inspector / sub; monthly trend.
5. **Outbox** — drafts awaiting approval; send history.
6. **Settings** — contacts per job, vendor triggers, mode per rule, standard inspection sequence per county.

## 8. Phases and what we need from you in each

| Phase | Deliverable | Needed |
|---|---|---|
| 0 (now) | structure, schema, Marion collector, spreadsheet load | validate this document |
| 1 | Permits + Inspections in Marion: events, R1–R9 in draft mode, Daily Log via RPA, screens 1–4 | Citrus/Orange URLs; Buildertrend bot user; bot mailbox password; designer's e-mail; vendor request list with triggers |
| 2 | Contracts (R10) + Field (audio/photo) | how the website sends the request; e-signature tool; contract template; who the supervisors are and which phones they use |
| 3 | Full construction tracking + Finance | separate conversation |

## 9. Open decisions

1. Team notification channel: e-mail only, or WhatsApp/SMS already in phase 1? (Proposal: e-mail in phase 1; WhatsApp in phase 2.)
2. Prime and PKB on the same dashboard with a company filter? (Proposal: yes; the portal already exposes the contractor.)
3. Where the workers run: Supabase Edge Functions + cron, or your own Node server? (Proposal: a Node server with `pm2`, because the Buildertrend RPA needs Chromium.)
4. Who approves drafts in phase 1: you, Guilherme, or both?
