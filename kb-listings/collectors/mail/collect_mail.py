#!/usr/bin/env python3
"""Read the listing mailboxes (realtor accounts) for showing activity on OUR listings.

Up to N mailboxes, configured by environment (1 and 2 today):
  LISTING_MAIL{n}_USER, LISTING_MAIL{n}_PASS   IMAP login (Gmail/Workspace: app password)
  LISTING_MAIL{n}_HOST                         default imap.gmail.com
  LISTING_MAIL{n}_FOLDER                       default INBOX (Gmail: "[Gmail]/All Mail" also sees filtered mail)

These are personal mailboxes, so the reader is READ-ONLY: it never marks, moves or deletes a
message. It looks at the last --days (default 3) and skips messages already stored.
Only showing-related messages are stored (kb.inbound_emails, mailbox = the account):
  • ShowingTime / BrokerBay / Aligned / plain e-mail showing requests, confirmations,
    cancellations and feedback for a listing in kb.listings → kb.showings (upsert)
  • replies to our feedback request ("[Showing S-XXXXXX]" in the subject) → feedback on the showing
  • CSV attachments on a message whose subject mentions "MLS" → data/mls/inbox/ (import_csv.mjs)

Usage (env as above + KB_SUPABASE_ACCESS_TOKEN / KB_SUPABASE_PROJECT_REF):
  python3 collectors/mail/collect_mail.py [--days 120] [--dry-run]
"""
import email
import imaplib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses, parseaddr, parsedate_to_datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'lib')]
from db import q, qa, sql  # noqa: E402
from mailtext import body_text, hdr  # noqa: E402
from showings import SHOWING_WORD, PLATFORMS, TAG_RE, parse_showing  # noqa: E402

DRY = '--dry-run' in sys.argv
DAYS = int(sys.argv[sys.argv.index('--days') + 1]) if '--days' in sys.argv else 3
MLS_INBOX = HERE.parents[1] / 'data' / 'mls' / 'inbox'
OWN_DOMAINS = [d.strip().lower() for d in os.environ.get('LISTING_OWN_DOMAINS', 'victorkubrusly.com').split(',') if d.strip()]


def mailboxes():
    out = []
    for n in range(1, 6):
        user, pwd = os.environ.get(f'LISTING_MAIL{n}_USER'), os.environ.get(f'LISTING_MAIL{n}_PASS')
        if user and pwd:
            out.append({'user': user.strip(), 'pass': pwd.strip(),
                        'host': os.environ.get(f'LISTING_MAIL{n}_HOST') or 'imap.gmail.com',
                        'folder': os.environ.get(f'LISTING_MAIL{n}_FOLDER') or 'INBOX'})
    return out


def candidate(from_addr, subject):
    """Cheap header filter before downloading a body."""
    f = (from_addr or '').lower()
    return (any(rx.search(f) for _, rx in PLATFORMS) or SHOWING_WORD.search(subject or '')
            or TAG_RE.search(subject or '') or re.search(r'\bmls\b', subject or '', re.I))


def save_csv_attachments(msg, subject):
    if not re.search(r'\bmls\b', subject or '', re.I):
        return 0
    n = 0
    for part in msg.walk():
        name = part.get_filename() or ''
        if name.lower().endswith('.csv'):
            MLS_INBOX.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
            (MLS_INBOX / f'{stamp}_{re.sub(r"[^A-Za-z0-9._-]", "_", name)}').write_bytes(part.get_payload(decode=True) or b'')
            n += 1
    return n


def store(mbox, row, ev):
    """Insert the e-mail and apply the showing event (one SQL round trip)."""
    email_ins = (f"with e as (insert into kb.inbound_emails (mailbox, message_id, received_at, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, category, parsed) "
                 f"values ({q(mbox)}, {q(row['message_id'])}, {q(row['received_at'])}, {q(row['from_addr'])}, {q(row['from_name'])}, "
                 f"{qa(row['to'])}, {qa(row['cc'])}, {q(row['subject'])}, {q(row['body'])}, {q('showing_' + ev['event'])}, {q(json.dumps(ev))}::jsonb) "
                 f"on conflict (message_id) do nothing returning id) ")
    if ev['event'] == 'feedback_reply':
        # Only the agent we asked (or anyone outside the company) — never our own outgoing copy.
        return sql(email_ins + f"""update kb.showings s set feedback_text = left(coalesce(s.feedback_text || E'\\n\\n---\\n', '') || {q(ev['feedback_text'])}, 8000),
            feedback_received_at = coalesce(s.feedback_received_at, {q(row['received_at'])}::timestamptz), feedback_source = 'reply',
            feedback_interest = null, updated_at = now(), inbound_email_id = coalesce(s.inbound_email_id, (select id from e))
          where s.ref = {q(ev['ref'])} and exists (select 1 from e) returning s.ref""")

    status = {'requested': 'requested', 'confirmed': 'confirmed', 'declined': 'declined',
              'cancelled': 'cancelled', 'rescheduled': 'rescheduled', 'feedback': 'completed'}[ev['event']]
    cols = dict(listing_id=q(ev['listing_id']), source=q(ev['source']), external_id=q(ev['external_id']), status=q(status),
                requested_at=q(row['received_at']) if ev['event'] == 'requested' else 'null',
                starts_at=q(ev['starts_at']), ends_at=q(ev['ends_at']), agent_name=q(ev['agent_name']),
                agent_email=q(ev['agent_email']), agent_phone=q(ev['agent_phone']), agent_brokerage=q(ev['agent_brokerage']),
                mailbox=q(mbox), parsed=q(json.dumps(ev)) + '::jsonb')
    if ev['event'] == 'feedback':
        # Attach to the showing it follows: same platform id, else the latest one by the same agent on this listing.
        return sql(email_ins + f"""update kb.showings s set status = 'completed', feedback_text = {q(ev.get('feedback_text'))},
            feedback_received_at = {q(row['received_at'])}, feedback_source = 'platform', feedback_interest = null, updated_at = now()
          where s.id = (select id from kb.showings where listing_id = {q(ev['listing_id'])}
                          and (external_id = {q(ev['external_id'])} or (agent_email is not null and agent_email = {q(ev['agent_email'])})
                               or (agent_name is not null and agent_name ilike {q(ev['agent_name'])}))
                          and coalesce(starts_at, created_at) <= {q(row['received_at'])}::timestamptz
                        order by (external_id = {q(ev['external_id'])}) desc, starts_at desc nulls last limit 1)
            and exists (select 1 from e) returning s.ref""") or sql(
            f"""insert into kb.showings ({', '.join(cols)}, feedback_text, feedback_received_at, feedback_source)
                select {', '.join(cols.values())}, {q(ev.get('feedback_text'))}, {q(row['received_at'])}, 'platform'
                on conflict (source, external_id) do nothing returning ref""")
    # Later events win on status (a cancellation after a confirmation), known fields are kept.
    keep = ', '.join(f"{c} = coalesce(excluded.{c}, s.{c})" for c in ('starts_at', 'ends_at', 'agent_name', 'agent_email', 'agent_phone', 'agent_brokerage', 'requested_at'))
    return sql(email_ins + f"""insert into kb.showings as s ({', '.join(cols)}, inbound_email_id)
        select {', '.join(cols.values())}, (select id from e) where exists (select 1 from e)
        on conflict (source, external_id) do update set
          status = case when s.status = 'completed' then s.status else excluded.status end,
          {keep}, parsed = s.parsed || excluded.parsed, updated_at = now()
        returning ref""")


def read_mailbox(mb, listings, seen):
    m = imaplib.IMAP4_SSL(mb['host'], 993)
    m.login(mb['user'], mb['pass'])
    typ, _ = m.select(f'"{mb["folder"]}"', readonly=True)
    if typ != 'OK':
        raise RuntimeError(f"{mb['user']}: folder {mb['folder']} not found")
    since = (datetime.now() - timedelta(days=DAYS)).strftime('%d-%b-%Y')
    typ, data = m.search(None, 'SINCE', since)
    ids = data[0].split() if data and data[0] else []
    counts = {'scanned': len(ids)}
    for num in ids:
        typ, hd = m.fetch(num, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])')
        raw_h = next((p[1] for p in hd if isinstance(p, tuple)), b'')
        h = email.message_from_bytes(raw_h)
        mid = (h.get('Message-ID') or '').strip()
        _, addr = parseaddr(hdr(h.get('From')))
        subject = hdr(h.get('Subject'))
        if (mid and mid in seen) or not candidate(addr, subject):
            continue
        if any(addr.lower().endswith('@' + d) for d in OWN_DOMAINS) and TAG_RE.search(subject):
            continue  # our own feedback request (sent folder / All Mail)
        typ, full = m.fetch(num, '(BODY.PEEK[])')
        raw = next((p[1] for p in full if isinstance(p, tuple)), None)
        if not raw:
            continue
        msg = email.message_from_bytes(raw)
        name, addr = parseaddr(hdr(msg.get('From')))
        body = body_text(msg)
        try:
            received = parsedate_to_datetime(msg.get('Date')).isoformat()
        except Exception:
            received = datetime.now(timezone.utc).isoformat()
        if not DRY:
            counts['mls_csv'] = counts.get('mls_csv', 0) + save_csv_attachments(msg, subject)
        ev = parse_showing(addr, subject, body, received, listings, OWN_DOMAINS)
        if not ev:
            continue
        counts[ev['event']] = counts.get(ev['event'], 0) + 1
        row = {'message_id': (mid or f'no-id:{received}:{subject}')[:500], 'received_at': received,
               'from_addr': addr.lower(), 'from_name': name, 'subject': subject, 'body': body,
               'to': [a.lower() for _, a in getaddresses(msg.get_all('To', [])) if a],
               'cc': [a.lower() for _, a in getaddresses(msg.get_all('Cc', [])) if a]}
        print(f"  {received[:16]} {ev['event']:14} {ev.get('source', ''):12} {ev.get('agent_email') or ev.get('ref') or '-':32} {subject[:60]}")
        if not DRY:
            store(mb['user'], row, ev)
        seen.add(row['message_id'])
    m.logout()
    return counts


def main():
    boxes = mailboxes()
    if not boxes:
        sys.exit('no listing mailbox configured (LISTING_MAIL1_USER / LISTING_MAIL1_PASS)')
    listings = sql("select id::text, mls_number, address from kb.listings where status not in ('withdrawn', 'expired')")
    if not listings:
        print('no listings in kb.listings — load them first (scripts/load_listings.mjs)')
        return
    seen = {r['message_id'] for r in sql(f"select message_id from kb.inbound_emails where received_at > now() - interval '{DAYS + 2} days'")}
    failed = 0
    for mb in boxes:
        print(f"{mb['user']} ({mb['folder']}, last {DAYS} days){' DRY RUN' if DRY else ''}")
        try:
            print('  ', json.dumps(read_mailbox(mb, listings, seen), sort_keys=True))
        except Exception as e:  # one bad mailbox must not stop the other
            failed += 1
            print(f'  ERROR {mb["user"]}: {e}')
    if failed == len(boxes):
        sys.exit(1)


if __name__ == '__main__':
    main()
