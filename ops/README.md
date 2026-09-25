# PKB Ops — permits, inspections and construction tracking

Operations module for PKB Homes (separate from the estimator in `frontend/` +
`supabase/`). Goal: replace the *Permits Control* spreadsheet with a system that
**reads the sources of truth by itself** (county portals, e-mail, Buildertrend),
keeps history as events, and gives back a dashboard, alerts and automations
(review e-mail to the designer, follow-ups, vendor requests).

Design: [`ARCHITECTURE.md`](ARCHITECTURE.md).

```
ops/
  collectors/energov/   collector for Tyler EnerGov CSS portals (Marion; Citrus/Orange to confirm)
  analysis/             first KPIs straight from collected JSON
  data/permits/         imported Permits Control spreadsheet (UTF-8 CSV)
  data/portal/<county>/ one JSON per permit, as the portal returned it + a normalized block
```

## EnerGov collector (county portals)

Marion County runs Tyler EnerGov *Citizen Self Service*. Lookup is **public**
(no login) and exposes, per permit: status and dates, submittal rounds, review
items per department **with the reviewer's full comments**, inspections, holds,
contacts (contractor and subs), fees and sub-records. Only attachments,
e-reviews and events require being a contact on the record.

```bash
cd ops && npm install
node collectors/energov/collect.mjs --county marion BLDR-26-05-13402
node collectors/energov/collect.mjs --county marion --from-csv data/permits/permits_control_2026-09-25.csv
node analysis/permits_kpi.mjs --county marion --md data/portal/marion/_kpi.md
```

Output in `data/portal/marion/<PERMIT>.json`:

- `raw` — the JSON responses the portal itself loaded (by route), for auditing
- `permit` — the normalized block the rest of the system consumes:
  `submittals[]` (version, dates), `reviewItems[]` (department, status, reviewer,
  e-mail, due date, comments), `workflow[]`, `inspections[]`, `holds[]`,
  `contacts[]`, `feeSummary`, `subRecords[]`

The collector drives the real portal in headless Chromium (Playwright) and
captures the JSON the UI requests; it does not re-implement the calls. That keeps
us on the same path as a human visitor and survives cosmetic UI changes.

Optional variables: `CHROMIUM_PATH` (Chromium binary), `HTTPS_PROXY`.

## Credentials

Copy `.env.example` to `.env` and fill it in. `.env` is never committed.

## Next steps (in order)

1. Citrus and Orange: confirm they run EnerGov; if so, add them to `PORTALS`.
2. Data model (Supabase, schema `ops`): `jobs`, `job_pauses`, `permit_cases`,
   `submittals`, `review_items`, `inspections`, `holds`, `events` + rules/notifications.
3. Bot mailbox reader (IMAP) → events (designer, FDEP, surveyor, Buildertrend).
4. Rules: "Requires Re-submit" review → draft e-mail to the designer with the
   corrections itemized → 48 h follow-up until `submittals[+1]` appears.
5. KPI dashboard: days per round (county × designer), failure causes by
   department, stalled permits, active holds, pauses excluded from clocks.
6. Buildertrend (RPA with the `PKB Ops Bot` user): Daily Log per check, Job per contract.
