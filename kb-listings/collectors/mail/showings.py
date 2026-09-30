"""Parse showing-platform e-mails (ShowingTime, BrokerBay, Aligned Showings, plain agent e-mail).

parse_showing(from_addr, subject, body, received_at, listings) → dict | None

The formats below are written from the platforms' public notification layouts and are
deliberately tolerant: every field is optional, the listing is found by MLS number or by the
street address of one of OUR listings (so unrelated mail is ignored), and the external id
falls back to a stable hash. Tighten the patterns with real samples as they arrive
(tests in test_showings.py).
"""
import hashlib
import re
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo('America/New_York')

PLATFORMS = [
    ('showingtime', re.compile(r'showingtime\.com|showingtimeplus\.com', re.I)),
    ('brokerbay', re.compile(r'brokerbay\.com', re.I)),
    ('aligned', re.compile(r'alignedshowings\.com', re.I)),
    ('showingassist', re.compile(r'showingassist\.com', re.I)),
]

# Order matters: the first event whose pattern hits the subject (then the body head) wins.
EVENTS = [
    ('feedback', re.compile(r'\bfeedback\b', re.I)),
    ('cancelled', re.compile(r'\bcancel+(?:ed|led|lation)?\b', re.I)),
    ('declined', re.compile(r'\b(declined|denied|rejected)\b', re.I)),
    ('rescheduled', re.compile(r'\breschedul', re.I)),
    ('confirmed', re.compile(r'\b(confirmed|approved|accepted)\b', re.I)),
    ('requested', re.compile(r'\b(request(?:ed)?|new (?:showing|appointment|booking)|pending approval|awaiting approval)\b', re.I)),
]
SHOWING_WORD = re.compile(r'\b(showing|appointment|booking|tour)\b', re.I)

MONTHS = {m: i + 1 for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
TIME = r'(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?'
DATE_PATTERNS = [
    # Tuesday, September 29, 2026 2:00 PM   |  Sep 29, 2026 at 2:00 pm   |  September 29 2026, 2:00PM
    re.compile(r'(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*(?:at|@|,|-)?\s*)' + TIME, re.I),
    # 09/29/2026 2:00 PM  |  9/29/26 @ 2:00pm
    re.compile(r'(\d{1,2})/(\d{1,2})/(\d{2,4})\s*(?:at|@|,|-)?\s*' + TIME, re.I),
]
END_TIME = re.compile(TIME + r'\s*(?:-|–|to)\s*' + TIME, re.I)

EMAIL_RE = re.compile(r'[\w.+-]+@[\w-]+(?:\.[\w-]+)+')
PHONE_RE = re.compile(r'(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b')
AGENT_LABELS = r"(?:buyer'?s?\s+agent|showing\s+agent|agent\s+name|requested\s+by|requesting\s+agent|scheduled\s+by|agent)"
BROKERAGE_LABELS = r'(?:brokerage|office|company|firm)'
ID_RE = re.compile(r'(?:appointment|showing|booking|confirmation|request)\s*(?:id|#|number|no\.?)\s*[:#]?\s*([A-Z0-9-]{5,})', re.I)
TAG_RE = re.compile(r'\[Showing (S-[0-9A-F]{6})\]')


def _norm(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def street_key(addr):
    """'1234 SW 142nd Place Rd, Ocala FL' → ('1234', 'sw142plrd')."""
    first = (addr or '').split(',')[0].lower()
    m = re.match(r'\s*(\d+)\s+(.*)', first)
    if not m:
        return None
    rest = re.sub(r'\b(street|st|road|rd|lane|ln|place|pl|court|ct|circle|cir|terrace|ter|avenue|ave|drive|dr|loop|way|boulevard|blvd|trail|trl|run|path|pass)\b\.?', '', m.group(2))
    rest = re.sub(r'(\d+)(st|nd|rd|th)\b', r'\1', rest)
    return m.group(1), re.sub(r'[^a-z0-9]', '', rest)


def match_listing(text, listings):
    """The listing this message is about: MLS number first, then street number + street name."""
    for l in listings:
        mls = (l.get('mls_number') or '').strip()
        if mls and re.search(r'(?<![A-Z0-9])' + re.escape(mls) + r'(?![A-Z0-9])', text, re.I):
            return l
    low = text.lower()
    for l in listings:
        k = street_key(l.get('address'))
        if not k or len(k[1]) < 3:
            continue
        num, name = k
        # street number as a whole word, and the street name (without suffixes) right after it
        for m in re.finditer(r'(?<!\d)' + re.escape(num) + r'(?!\d)', low):
            window = re.sub(r'[^a-z0-9]', '', re.sub(r'(\d+)(st|nd|rd|th)\b', r'\1', low[m.end():m.end() + 60]))
            window = re.sub(r'(street|road|lane|place|court|circle|terrace|avenue|drive|loop|way|boulevard|trail)', '', window)
            if window.startswith(name[:12]) or name[:12] in window[:len(name) + 6]:
                return l
    return None


def _dt(y, mo, d, hh, mm, ap):
    h = int(hh) % 12 + (12 if ap.lower() == 'p' else 0)
    y = int(y)
    y = y + 2000 if y < 100 else y
    try:
        return datetime(y, int(mo), int(d), h, int(mm or 0), tzinfo=TZ)
    except ValueError:
        return None


def parse_when(text):
    """(starts_at, ends_at) as aware datetimes (America/New_York), or (None, None)."""
    for i, pat in enumerate(DATE_PATTERNS):
        m = pat.search(text)
        if not m:
            continue
        if i == 0:
            mo = MONTHS.get(m.group(1)[:3].lower())
            if not mo:
                continue
            start = _dt(m.group(3), mo, m.group(2), m.group(4), m.group(5), m.group(6))
            y, d = m.group(3), m.group(2)
        else:
            mo = int(m.group(1))
            start = _dt(m.group(3), mo, m.group(2), m.group(4), m.group(5), m.group(6))
            y, d = m.group(3), m.group(2)
        if not start:
            continue
        end = None
        e = END_TIME.search(text[m.start():m.end() + 40])
        if e:
            end = _dt(y, mo, d, e.group(4), e.group(5), e.group(6))
            if end and end <= start:
                end = None
        return start, end
    return None, None


def _label(text, labels, stop=r'(?:\n|$|\s{3,}|\|)'):
    m = re.search(r'(?:^|\n|\|)\s*' + labels + r'\s*[:\-]\s*(.+?)\s*' + stop, text, re.I)
    return _norm(m.group(1)) if m else None


def parse_agent(text, ignore_domains):
    name = _label(text, AGENT_LABELS)
    if name:
        name = re.split(r'\s+(?:\(|\||phone|email|e-mail|cell|office)', name, flags=re.I)[0]
        name = EMAIL_RE.sub('', name).strip(' ,-') or None
        if name and (len(name) > 60 or re.search(r'\d{3}', name)):
            name = None
    brokerage = _label(text, BROKERAGE_LABELS)
    # The agent block: text after the agent label (or the whole body) for e-mail and phone.
    at = re.search(AGENT_LABELS, text, re.I)
    block = text[at.start():at.start() + 600] if at else text
    email = next((e.lower() for e in EMAIL_RE.findall(block) + EMAIL_RE.findall(text)
                  if not any(e.lower().endswith(d) for d in ignore_domains)), None)
    p = PHONE_RE.search(block) or PHONE_RE.search(text)
    phone = f'({p.group(1)}) {p.group(2)}-{p.group(3)}' if p else None
    return {'agent_name': name, 'agent_email': email, 'agent_phone': phone, 'agent_brokerage': brokerage}


def parse_feedback(text):
    """Feedback text from a platform 'feedback received' e-mail: the Q&A block, trimmed."""
    m = re.search(r'(feedback[^\n]*\n)(.+?)(?:\n\s*(?:view (?:all|full|in)|log ?in|unsubscribe|thank you|thanks,|©|this (?:e-?mail|message) was sent)|$)', text, re.I | re.S)
    body = (m.group(2) if m else text).strip()
    return re.sub(r'\n{3,}', '\n\n', body)[:4000] or None


def parse_showing(from_addr, subject, body, received_at, listings, own_domains=()):
    """Return a showing event for one of our listings, or None if the message is not one."""
    f, s = (from_addr or '').lower(), subject or ''
    text = s + '\n' + (body or '')
    source = next((name for name, rx in PLATFORMS if rx.search(f)), None)
    tag = TAG_RE.search(s)
    if tag:  # reply from the buyer's agent to our feedback request
        return {'event': 'feedback_reply', 'ref': tag.group(1), 'source': 'reply',
                'agent_email': f, 'feedback_text': body}
    if not source and not SHOWING_WORD.search(s):
        return None
    listing = match_listing(text, listings)
    if not listing:
        return None
    head = s + '\n' + (body or '')[:600]
    event = next((ev for ev, rx in EVENTS if rx.search(s)), None) or next((ev for ev, rx in EVENTS if rx.search(head)), None)
    if not event:
        return None
    ignore = tuple(d.lower() for d in own_domains) + ('showingtime.com', 'showingtimeplus.com', 'brokerbay.com',
                                                     'alignedshowings.com', 'showingassist.com', 'noreply', 'no-reply')
    starts_at, ends_at = parse_when(text)
    agent = parse_agent(body or '', ignore)
    idm = ID_RE.search(text)
    ext = idm.group(1) if idm else None
    if not ext:
        seed = f"{listing['id']}|{starts_at.isoformat() if starts_at else received_at}|{agent['agent_email'] or agent['agent_name'] or f}"
        ext = 'h' + hashlib.sha1(seed.encode()).hexdigest()[:16]
    out = {'event': event, 'source': source or 'email', 'external_id': ext, 'listing_id': listing['id'],
           'starts_at': starts_at.isoformat() if starts_at else None, 'ends_at': ends_at.isoformat() if ends_at else None,
           **agent}
    if event == 'feedback':
        out['feedback_text'] = parse_feedback(body or '')
    return out
