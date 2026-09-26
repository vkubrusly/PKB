# Open questions — PKB Ops

Updated 2026-09-26 after Victor's answers. Answers are recorded in
`ARCHITECTURE.md` §6/§9, `docs/PROCESS_PERMITS.md` and `config/contacts.json`.

## Still open

1. **Standard inspection sequence** and the next step after each inspection — Victor will send material.
2. **Citrus Civic Association** — what is submitted, to whom, how approval arrives (check with Guilherme).
3. **Orange County Fast Track login** (contractor account) — public search is behind a CAPTCHA.
4. **Charlotte, Sarasota (North Port) and Lake** — permit search URLs.
5. **Buildertrend API** — request sent to the rep, waiting for an answer.
6. **Missing e-mail samples** for the parser: a Sovereign correction e-mail and a Buildertrend "invoice paid" notification.
7. **WhatsApp** — PKB Ops number and Meta Business account (later).
8. **Contracts (phase 2)** — Victor is checking whether it can be done inside Buildertrend; the website form will also e-mail the bot.

## Security (deferred by decision)

- Credentials that appeared in a screenshot are still to be rotated; the bot's Buildertrend role stays Admin for now.

## Decided 2026-09-26

- All permit e-mails copied to the bot mailbox.
- Vendors after issuance: requested by the supervisor; the system reminds.
- Follow-ups only after a correction request; spacing adapts to the reply.
- "Stalled" thresholds: start with defaults, tune with experience.
- Septic: e-mails, then the county portal.
- Itemized corrections e-mail to Sovereign is a new PKB standard.
- Supervisors schedule their inspections; the system sends reminders.
- Inspection failures → supervisor, project manager(s), Cristiano.
- PP = Permit Plan requested (Sovereign asked to start).
- Impact fees / NOC → Daniela, Cc Guilherme.
- Access: admin (Victor + partners) and operational (supervisors, own jobs only).
- Hosting: Supabase for now; collectors on scheduled GitHub Actions.
- Field module: 3 supervisors, mostly iPhone, audio mostly Portuguese.
