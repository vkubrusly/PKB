"""SQL on the Kubrusly Basso Supabase project through the Management API (HTTPS, no driver).

Env: KB_SUPABASE_ACCESS_TOKEN (account token, sbp_…), KB_SUPABASE_PROJECT_REF (required — no default,
so this can never write into another company's database by accident).
"""
import json
import os
import urllib.request


def sql(query):
    ref = (os.environ.get('KB_SUPABASE_PROJECT_REF') or '').strip()
    token = (os.environ.get('KB_SUPABASE_ACCESS_TOKEN') or '').strip()
    if not ref or not token:
        raise SystemExit('KB_SUPABASE_PROJECT_REF / KB_SUPABASE_ACCESS_TOKEN not set')
    req = urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{ref}/database/query',
        data=json.dumps({'query': query}).encode(),
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'User-Agent': 'kb-listings'},
        method='POST')
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b'[]')


def q(v):
    if v is None:
        return 'null'
    return "'" + str(v).replace("'", "''").replace('\x00', '') + "'"


def qa(items):
    return 'array[' + ','.join(q(i) for i in items) + ']::text[]' if items else "'{}'::text[]"
