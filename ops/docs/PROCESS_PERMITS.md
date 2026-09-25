# Permit process — as it runs today

Source: Guilherme's walkthrough (audio, 2026-09-25) plus the Permits Control
spreadsheet and the Marion County portal. Applies to the affordable models
(Sunny, Sunny Farm, Florida, Belvedere, Safira, Maya…). Custom homes (Orange,
Charlotte) may differ — to be confirmed.

## Steps

| # | Step | Who acts | Signal we can read | Ball with |
|---|---|---|---|---|
| 1 | Investor signs the contract | client / Guilherme | contract signed (phase 2: e-signature tool); today: spreadsheet `Signed Date` | pkb |
| 2 | 1st invoice issued (licensing) | PKB (Buildertrend) | Buildertrend invoice created | owner |
| 3 | 1st invoice paid | client | **Buildertrend "invoice paid / payment received" e-mail** → `invoice.paid` event | pkb |
| 4 | Same day: "start licensing" e-mail to Sovereign with the job data, asking for building permit + septic permit (Guilherme in copy) | Guilherme → **automated draft** (rule R0) | e-mail sent from the bot mailbox | sovereign |
| 5 | Sovereign requests the survey | Sovereign → surveyor (Bailey) | e-mail thread (bot in copy) | surveyor |
| 6 | Survey drawing returned | surveyor | e-mail with attachment | sovereign |
| 7 | Sovereign prepares the site plan (model documentation prepared in parallel) | Sovereign | — | sovereign |
| 8a | Sovereign submits the **building permit** to the county | Sovereign | portal: case appears, `Applied Date` | county |
| 8b | Sovereign sends the site plan to Shady for the **septic** application | Sovereign → Shady | e-mail | shady |
| 9 | Shady returns the septic application (~10–15 days) | Shady | e-mail | sovereign |
| 10 | Sovereign submits the septic application (FDEP) and later collects the approval | Sovereign | e-mail / FDEP | fdep |
| 11 | County department reviews; corrections go back to Sovereign; resubmissions until approved | county ↔ Sovereign | portal: submittals, review items with comments | county / sovereign |
| 12 | Fees, NOC confirmation, impact fees, permit issued | county / PKB | portal: `Fees Due` → `Fees Paid` → `Issued`; workflow "Confirm Notice of Commencement" | pkb / county |

Septic usually comes out before the building permit; when the building permit is
fast (20-odd days) the septic may finish later.

## Blockers seen in practice

- **Turtle** (gopher tortoise on the lot): tortoise survey + relocation before impact fees can be paid.
- **Client defers the start** after the permit is ready; **waiting for the 1st draw**; **waiting to sell to pay impact fees**; **waiting for the warranty deed**. All are `job_pauses` and are excluded from KPI clocks.
- **County holds**: e.g. "Contact Medium Hold — EXPIRED STATE LICENSE" (contractor license lapse; seen inactive on 36 Marion permits), Utilities setup hold, inspection holds. Only *Stop Action* holds block; *Alert Message Only* holds are parcel notes.

## What the system measures that the spreadsheet cannot

- Pre-portal clock: invoice paid → start e-mail → survey requested → survey received → building permit submitted.
- Septic clock: site plan → Shady → FDEP submitted → FDEP approved.
- Per review round: county days vs. resubmission days, and which department failed with which cause.
- Days waiting on each party (`ball_with`) — the number that tells where to push.

## Rules this adds to ARCHITECTURE.md §6

| # | Trigger | Action |
|---|---|---|
| R0 | `invoice.paid` for the 1st (licensing) invoice | draft the "start licensing" e-mail to Sovereign with the job data (address, parcel, model, owner, county); on send: `ball_with = sovereign`; open `permit_cases` building + septic + survey |
| R0b | no survey request seen within 3 business days of the start e-mail | follow-up to Sovereign |
| R0c | septic design not returned by Shady within 15 days of the site plan | follow-up to Shady, Sovereign in copy |

## Open questions

1. The exact content of the start e-mail (forward a real one to the bot mailbox).
2. Contact e-mails: Sovereign, Shady, Bailey.
3. ~~Custom homes: same designer?~~ **Answered:** custom homes use other designers and **PKB tracks the permit itself**. Modeled as `job_contacts.designer` per job and `permit_cases.tracked_by = designer | pkb`. For `pkb`-tracked cases the correction e-mail goes to that job's designer, the 48 h follow-up is PKB's, and R0 (start e-mail to Sovereign) does not apply.
4. Who pays impact fees and when, and how the NOC is recorded (county workflow shows "Confirm Notice of Commencement").
