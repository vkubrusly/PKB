"""Header decoding and plain-text body extraction for IMAP messages."""
import re
from email.header import decode_header, make_header
from html import unescape

BODY_MAX = 20000


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
        html = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</tr>|</li>', '\n', html)
        html = re.sub(r'(?i)</td>', ' | ', html)
        text = unescape(re.sub(r'<[^>]+>', ' ', html))
        return re.sub(r'[ \t]+', ' ', re.sub(r'\n\s*\n+', '\n\n', text)).strip()[:BODY_MAX]
    return ''
