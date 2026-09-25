#!/usr/bin/env python3
"""Probe the bot mailbox over IMAP and list recent messages (no bodies printed).

Usage: BOT_EMAIL=... BOT_EMAIL_PASSWORD=... python3 collectors/mail/imap_probe.py [N]

Behind an HTTP proxy (HTTPS_PROXY set) it tunnels the IMAP connection with
CONNECT, which is what the Claude cloud container requires; elsewhere it
connects directly.
"""
import email
import imaplib
import os
import socket
import ssl
import sys
from email.header import decode_header, make_header
from urllib.parse import urlparse

HOST, PORT = 'imap.gmail.com', 993
user, pwd = os.environ.get('BOT_EMAIL'), os.environ.get('BOT_EMAIL_PASSWORD')
if not user or not pwd:
    sys.exit('BOT_EMAIL / BOT_EMAIL_PASSWORD not set')
n = int(sys.argv[1]) if len(sys.argv) > 1 else 30


def open_socket():
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if not proxy:
        return socket.create_connection((HOST, PORT), timeout=30)
    u = urlparse(proxy)
    s = socket.create_connection((u.hostname, u.port), timeout=30)
    s.sendall(f'CONNECT {HOST}:{PORT} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n\r\n'.encode())
    resp = b''
    while b'\r\n\r\n' not in resp:
        chunk = s.recv(4096)
        if not chunk:
            break
        resp += chunk
    status = resp.split(b'\r\n', 1)[0].decode(errors='replace')
    if ' 200 ' not in status:
        sys.exit(f'proxy CONNECT failed: {status}')
    return s


class TunneledIMAP(imaplib.IMAP4):
    def _create_socket(self, timeout):
        raw = open_socket()
        ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
        return ctx.wrap_socket(raw, server_hostname=HOST)


def hdr(v):
    try:
        return str(make_header(decode_header(v or '')))
    except Exception:
        return v or ''


m = TunneledIMAP(HOST, PORT)
m.login(user, pwd)
print('login ok as', user)
typ, boxes = m.list()
print('folders:', len(boxes))
m.select('INBOX', readonly=True)
typ, data = m.search(None, 'ALL')
ids = data[0].split()
print('INBOX messages:', len(ids))
for i in ids[-n:][::-1]:
    typ, msg = m.fetch(i, '(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])')
    h = email.message_from_bytes(msg[0][1])
    print(f"{hdr(h['Date'])[:25]:25} | {hdr(h['From'])[:45]:45} | {hdr(h['Subject'])[:80]}")
m.logout()
