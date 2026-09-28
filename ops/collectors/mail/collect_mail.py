#!/usr/bin/env python3
"""Read new messages from the bot mailbox, store them in ops.inbound_emails, mark them read.

Every message (not only permit mail) is kept: the more the system knows, the better the
rules, the dashboard and the assistant get. Each message is classified (Buildertrend
invoice / invoice paid / daily log / bill, county, designer, septic, surveyor, other),
linked to the job named in the subject ("0048 - OC - …") and, for Buildertrend activity,
turned into an ops.events row.

Usage (env: BOT_EMAIL, BOT_EMAIL_PASSWORD, SUPABASE_ACCESS_TOKEN):
  python3 collectors/mail/collect_mail.py            # unread messages, then mark them read
  python3 collectors/mail/collect_mail.py --all      # backfill every message in the inbox
  python3 collectors/mail/collect_mail.py --dry-run  # parse and print, write nothing, flag nothing
"""
import email
import imaplib
import json
import os
import re
import sys
import urllib.request
from email.header import decode_header, make_header
from email.utils import getaddresses, parseaddr, parsedate_to_datetime
from html import unescape

HOST = 'imap.gmail.com'
REF = os.environ.get('SUPABASE_PROJECT_REF', 'fvjknahpmihueyeasgbx')
ORG = os.environ.get('OPS_ORG_NAME', 'PKB Homes')
DRY = '--dry-run' in sys.argv
ALL = '--all' in sys.argv
BODY_MAX = 20000
BATCH = 40


def sql(query):
    token = (os.environ.get('SUPABASE_ACCESS_TOKEN') or '').strip()
    if token.startswith('ssbp_'):
        token = token[1:]
    req = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{REF}/database/query',
        data=json.dumps({'query': query}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'pkb-ops-mail'},
        method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b'[]')


def q(v):
    if v is None:
        return 'null'
    return "'" + str(v).replace("'", "''").replace('\x00', '') + "'"


def qa(items):
    return 'array[' + ','.join(q(i) for i in items) + ']::text[]' if items else "'{}'::text[]"


def hdr(v):
    try:
        return str(make_header(decode_header(v or ''))).strip()
    except Exception:
        return (v or '').strip()


def body_text(msg):
    plain, html = None, None
    for part in msg.walk() if msg.is_multipart() else [msg]:
        if part.get_content_maintype() == 'multipart' or part.get_filename():
            continue
        try:
            payload = part.get_payload(decode=True)
            text = payload.decode(part.get_content_charset() or 'utf-8', errors='replace') if payload else ''
        except Exception:
            continue
        if part.get_content_type() == 'text/plain' and plain is None:
            plain = text
        elif part.get_content_type() == 'text/html' and html is None:
            html = text
    if plain:
        return plain.strip()[:BODY_MAX]
    if html:
        html = re.sub(r'(?is)<(script|style).*?</\1>', ' ', html)
        html = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>', '\n', html)
        text = unescape(re.sub(r'<[^>]+>', ' ', html))
        return re.sub(r'[ \t]+', ' ', re.sub(r'\n\s*\n+', '\n\n', text)).strip()[:BODY_MAX]
    return ''


JOB_RE = re.compile(r"(?:^|for |job '|job \")(\d{4}|S\d{3}) - ")
AMOUNT_RE = re.compile(r'\$([\d,]+(?:\.\d{2})?)')


def classify(from_addr, subject, body):
    f, s = (from_addr or '').lower(), subject or ''
    parsed = {}
    m = AMOUNT_RE.search(s)
    if m:
        parsed['amount'] = float(m.group(1).replace(',', ''))
    if 'buildertrend.com' in f:
        a = re.match(r'^(.+?) (created|updated|voided|deleted|sent) an? (?:new )?\$', s)
        if a:
            parsed.update(actor=a.group(1), action=a.group(2))
        if re.search(r'daily log', s, re.I):
            return 'bt_daily_log', parsed
        if re.search(r'invoice', s, re.I) and re.search(r'\bpaid\b|payment (?:received|made)|has been paid', s + ' ' + body[:500], re.I):
            parsed['action'] = 'paid'
            return 'bt_invoice_paid', parsed
        if re.search(r'invoice', s, re.I):
            return 'bt_invoice', parsed
        if re.search(r'\bbill\b', s, re.I):
            if re.search(r'payment made', s, re.I):
                parsed['action'] = 'paid'
            elif re.search(r'ready for payment', s, re.I):
                parsed['action'] = 'ready'
            return 'bt_bill', parsed
        return 'bt_other', parsed
    if re.search(r'marionfl\.org|citrus|ocfl\.net|cityofwinterpark|orlando\.gov|charlottecounty|northportfl|lakecountyfl|sarasota', f):
        return 'county', parsed
    if re.search(r'sovereign|sconsult\.us|fredianiputini', f):
        return 'designer', parsed
    if 'shady' in f:
        return 'septic', parsed
    if 'baileysurveying' in f:
        return 'surveyor', parsed
    if f.endswith('google.com'):
        return 'google', parsed
    return 'other', parsed


def main():
    user, pwd = os.environ.get('BOT_EMAIL'), os.environ.get('BOT_EMAIL_PASSWORD')
    if not user or not pwd:
        sys.exit('BOT_EMAIL / BOT_EMAIL_PASSWORD not set')
    org = None if DRY else sql(f"select id from public.orgs where name = {q(ORG)} limit 1")
    org_id = org[0]['id'] if org else None
    if not DRY and not org_id:
        sys.exit(f'org {ORG} not found')

    m = imaplib.IMAP4_SSL(HOST, 993)
    m.login(user, pwd)
    m.select('INBOX', readonly=DRY)
    typ, data = m.search(None, 'ALL' if ALL else 'UNSEEN')
    ids = data[0].split() if data and data[0] else []
    print(f"{'all' if ALL else 'unread'} messages: {len(ids)}")

    counts, rows = {}, []

    def flush():
        if DRY or not rows:
            rows.clear()
            return
        values = []
        for r in rows:
            values.append('(' + ','.join([
                q(org_id), q(r['message_id']), q(r['received_at']), q(r['from_addr']), q(r['from_name']),
                qa(r['to']), qa(r['cc']), q(r['subject']), q(r['body']), q(r['category']), q(r['job_number']),
                f"(select id from ops.jobs where org_id = {q(org_id)} and job_number = {q(r['job_number'])})" if r['job_number'] else 'null',
                q(json.dumps(r['parsed'])) + '::jsonb']) + ')')
        stmt = ('insert into ops.inbound_emails (org_id, message_id, received_at, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, category, job_number, job_id, parsed) values '
                + ','.join(values) + ' on conflict (org_id, message_id) do nothing;')
        # Buildertrend activity becomes events (dedupe on the message id).
        ev = [r for r in rows if r['category'] in ('bt_invoice', 'bt_invoice_paid', 'bt_daily_log', 'bt_bill') and r['job_number'] and r['received_at']]
        if ev:
            kind = {'bt_invoice': 'invoice.updated', 'bt_invoice_paid': 'invoice.paid', 'bt_daily_log': 'daily_log.added', 'bt_bill': 'bill.updated'}
            stmt += ' insert into ops.events (org_id, job_id, kind, source, occurred_at, payload, dedupe_key) select j.org_id, j.id, v.kind, \'buildertrend\', v.at::timestamptz, v.payload::jsonb, v.dk from (values ' + ','.join(
                '(' + ','.join([q(r['job_number']), q(kind[r['category']]), q(r['received_at']), q(json.dumps({**r['parsed'], 'subject': r['subject']})), q('email:' + r['message_id'])]) + ')' for r in ev
            ) + f') as v(job_number, kind, at, payload, dk) join ops.jobs j on j.org_id = {q(org_id)} and j.job_number = v.job_number on conflict (org_id, dedupe_key) do nothing;'
        sql(stmt)
        # Mark read only once stored.
        m.store(','.join(r['uid'] for r in rows), '+FLAGS', '\\Seen')
        rows.clear()

    for num in ids:
        typ, msg_data = m.fetch(num, '(BODY.PEEK[])')
        raw = next((p[1] for p in msg_data if isinstance(p, tuple)), None)
        if not raw:
            continue
        msg = email.message_from_bytes(raw)
        name, addr = parseaddr(hdr(msg.get('From')))
        subject = hdr(msg.get('Subject'))
        body = body_text(msg)
        try:
            received = parsedate_to_datetime(msg.get('Date')).isoformat()
        except Exception:
            received = None
        category, parsed = classify(addr, subject, body)
        jm = JOB_RE.search(subject) or JOB_RE.search(body[:400])
        row = {
            'uid': num.decode(), 'message_id': (msg.get('Message-ID') or f"no-id:{received}:{subject}")[:500],
            'received_at': received, 'from_addr': addr.lower(), 'from_name': name,
            'to': [a.lower() for _, a in getaddresses(msg.get_all('To', [])) if a],
            'cc': [a.lower() for _, a in getaddresses(msg.get_all('Cc', [])) if a],
            'subject': subject, 'body': body, 'category': category,
            'job_number': jm.group(1) if jm else None, 'parsed': parsed,
        }
        counts[category] = counts.get(category, 0) + 1
        if DRY:
            print(f"{(received or '')[:16]:16} | {category:15} | {row['job_number'] or '-':5} | {json.dumps(parsed)[:40]:40} | {subject[:70]}")
        rows.append(row)
        if len(rows) >= BATCH:
            flush()
    flush()
    m.logout()
    print('by category:', json.dumps(counts, sort_keys=True))


if __name__ == '__main__':
    main()
