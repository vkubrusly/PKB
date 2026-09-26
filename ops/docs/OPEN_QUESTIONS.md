# Open questions — PKB Ops

Reviewed 2026-09-26 against everything answered or built so far. Ordered by what
blocks phase 1 (Permits + Inspections) first.

## A. Blocking phase 1

1. **Which inbox receives the permit e-mails?** Sovereign, the county, Shady and
   Bailey write to Guilherme (guilherme@pkbhomes.com, Outlook). The system reads
   the bot mailbox (Gmail). Options: (a) a forwarding rule in Guilherme's mailbox
   for those senders → botpkbhomes@gmail.com, or (b) always Cc the bot. Which?
2. **Vendor requests after the permit is issued.** Which requests go out, to whom,
   and on which trigger? (e.g. stake-out → Bailey; power/TUG; water/sewer;
   dumpster; portable toilet; NOC recording; impact fees.)
3. **48 h follow-up rules.** Assumed: follow-up to the designer every 48 h until a
   new submittal appears; every 2nd follow-up escalates to Victor. Confirm, and
   say whether weekends count.
4. **"Stalled" thresholds.** After how many days without movement should a permit
   raise an alert, per stage? (proposal: in review 15 d, corrections 5 d,
   fees due 3 d, issued without first inspection 20 d)
5. **Septic (FDEP) status.** Is it visible on any portal (FDEP / Health Dept), or
   only through Shady/Sovereign e-mails?
6. **Missing examples for the e-mail parser:** a correction e-mail from Sovereign
   and a Buildertrend "invoice paid" notification, forwarded to the bot mailbox.
7. **Orange County Fast Track login** (contractor account) — its public search is
   behind a CAPTCHA.
8. **Charlotte, Sarasota (North Port) and Lake** — permit search URLs (7 jobs).

## B. Inspections

9. **Who schedules inspections** — PKB (portal/IVR) or each sub? Should the system
   schedule the next one, or only tell someone to?
10. **Standard inspection sequence** per county, and the "next step" after each
    one (e.g. Foundation pre-pour passed → pour slab → request Framing).
11. **Which sub answers for each inspection type** (for failure attribution:
    plumbing, electrical, mechanical, framing, roofing…).

## C. Process details

12. **"PP Requested"** column in the spreadsheet — what is PP?
13. **Citrus Civic Association** — what is submitted, to whom, and how approval arrives.
14. **Impact fees and NOC** — who pays / records them, and when in the flow.
15. **Buildertrend API** — was the e-mail to the Buildertrend rep sent? Any answer?

## D. Dashboard and access

16. **Who uses the dashboard and with what access** — e.g. Victor/Guilherme full;
    supervisors see only their jobs; Sovereign read-only on their permits?
17. **Hosting** — which cloud account for the server (AWS, DigitalOcean, …) and who owns it.
18. **WhatsApp** — PKB Ops number, Meta Business account, and the team's numbers
    (who wants WhatsApp, who only e-mail).

## E. Phase 2 (not blocking now)

19. **Field module** — how many supervisors, iPhone/Android, app vs. WhatsApp group
    per house, audio language, and whether Buildertrend schedules use a standard
    template per model.
20. **Contracts** — fields the website form sends, contract template(s), e-signature
    tool, where the process gets lost today, what is created in Buildertrend on
    signature, and the draw/invoice schedule.

## F. Security housekeeping

21. Rotate the credentials that appeared in a screenshot (Buildertrend bot
    password, bot Gmail password → use an app password, Supabase token, database
    password) and move the bot's Buildertrend role back from Admin to a read-mostly
    role with **Jobs List / Job Info: View**.

## Answered (for reference)

Counties and portals (Marion + Winter Park EnerGov, Citrus Accela — public;
Orange Fast Track — login); public status without login; designer = Sovereign for
affordable models, other designers for custom with PKB tracking; start trigger =
1st invoice paid in Buildertrend; start e-mail template; contacts; notification
lists (permit vs. inspection); e-mail sending automatic with Guilherme in Cc;
e-mail + WhatsApp channels; single PKB dashboard; cloud VM; Buildertrend read via
seeded session (no public API); job matching by parcel then address; turtle and
client pauses excluded from KPIs; English for the product; monitoring ends at CO,
CO appears on the portal.
