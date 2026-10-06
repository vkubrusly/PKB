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
import time
import urllib.error
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
    # a momentary Supabase hiccup (429 / 5xx / network) is retried; a bad token (401) is not
    for k in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read() or b'[]')
        except urllib.error.HTTPError as e:
            if k == 3 or not (e.code == 429 or e.code >= 500):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if k == 3:
                raise
        time.sleep(5 * (k + 1))


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


def field(body, label):
    m = re.search(r'(?:^|\n)\s*' + label + r'\s+(.+?)\s*(?:\n|$)', body or '', re.I)
    return m.group(1).strip() if m else None


def money(v):
    try:
        return float(v.replace('$', '').replace(',', '')) if v else None
    except ValueError:
        return None


def work_request(body):
    # Website form (noreply@notify.pkbhomes.com): "Nome… Empresa… Telefone… E-mail…" run together.
    t = re.sub(r'\s+', ' ', body or '')
    grab = lambda a, b: (re.search(a + r'\s*(.*?)\s*(?=' + b + r'|$)', t) or [None, None])[1]
    return {k: (v or '').strip() or None for k, v in {
        'client': grab('CLIENTE Nome', 'Empresa'), 'company': grab('Empresa', 'Telefone'),
        'phone': grab('Telefone', 'E-mail'), 'email': grab('E-mail', 'PROJETO|🏠'),
        'address': grab('Endereço-?', 'Cidade'), 'city': grab('Cidade', 'Parcel ID'),
        'parcel': grab('Parcel ID', 'Modelo'), 'model': grab('Modelo', 'County'),
        'county': grab('County', 'Preço'), 'price': grab('Preço', 'CORRETOR|📋'),
        'agent': grab('CORRETOR Nome', 'Telefone'),
    }.items()}


def classify(from_addr, subject, body):
    f, s = (from_addr or '').lower(), subject or ''
    parsed = {}
    if 'notify.pkbhomes.com' in f or re.search(r'new work request', s, re.I):
        return 'work_request', work_request(body)
    m = AMOUNT_RE.search(s)
    if m:
        parsed['amount'] = float(m.group(1).replace(',', ''))
    if 'buildertrend.com' in f:
        a = re.match(r'^(.+?) (created|updated|voided|deleted|sent) an? (?:new )?\$', s)
        if a:
            parsed.update(actor=a.group(1), action=a.group(2))
        if re.search(r'daily log', s, re.I):
            return 'bt_daily_log', parsed
        if re.search(r'invoice', s, re.I):
            # Structured block in the notification: Title / ID # / Status / Invoice amount / Balance due.
            parsed.update({k: v for k, v in {
                'title': field(body, 'Title'), 'invoice_id': field(body, 'ID #'), 'status': field(body, 'Status'),
                'deadline': field(body, 'Deadline'), 'invoice_amount': money(field(body, 'Invoice amount')),
                'balance_due': money(field(body, 'Balance due'))}.items() if v is not None})
            if (parsed.get('status') or '').lower() == 'paid' or (parsed.get('balance_due') == 0 and parsed.get('invoice_amount')):
                return 'bt_invoice_paid', parsed
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

    for k in range(4):   # Gmail sometimes drops the first connection
        try:
            m = imaplib.IMAP4_SSL(HOST, 993)
            m.login(user, pwd)
            break
        except (imaplib.IMAP4.abort, OSError) as e:
            if k == 3:
                raise
            print(f'IMAP connect failed ({e}), retrying')
            time.sleep(10 * (k + 1))
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


def reparse():
    # Re-classify stored messages with the current rules (no mailbox access needed).
    rows = sql("select id, from_addr, subject, body_text from ops.inbound_emails")
    for r in rows:
        cat, parsed = classify(r['from_addr'], r['subject'], r['body_text'] or '')
        jm = JOB_RE.search(r['subject'] or '') or JOB_RE.search((r['body_text'] or '')[:400])
        jn = jm.group(1) if jm else None
        sql(f"update ops.inbound_emails set category = {q(cat)}, parsed = {q(json.dumps(parsed))}::jsonb, job_number = {q(jn)}, "
            f"job_id = (select j.id from ops.jobs j where j.org_id = ops.inbound_emails.org_id and j.job_number = {q(jn)}) where id = {q(r['id'])}")
    print('reparsed', len(rows))


if __name__ == '__main__':
    reparse() if '--reparse' in sys.argv else main()
