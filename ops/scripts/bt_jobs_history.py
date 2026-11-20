#!/usr/bin/env python3
# bt_jobs_history.py — READ-ONLY: the Buildertrend job list each ops-daily run kept (artifact "ops-snapshots",
# 7 days: ops/data/buildertrend/job_fields.json), for the given job numbers: present or not, status, status
# updated. Shows when a job left the list the bot sees. Needs GH_TOKEN (actions: read) and GITHUB_REPOSITORY.
#   python3 scripts/bt_jobs_history.py 0040 0056 …
import io, json, os, sys, urllib.error, urllib.request, zipfile
repo, tok = os.environ['GITHUB_REPOSITORY'], os.environ['GH_TOKEN']
want = sys.argv[1:]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)
def get(url, raw=False):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {tok}', 'Accept': 'application/vnd.github+json'})
    if not raw: return json.load(urllib.request.urlopen(req, timeout=120))
    # The zip download redirects to a signed storage URL that must be fetched WITHOUT the GitHub token.
    try: r = opener.open(req, timeout=120); return r.read()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308): return urllib.request.urlopen(e.headers['Location'], timeout=120).read()
        raise
arts = []
for page in range(1, 6):
    a = get(f'https://api.github.com/repos/{repo}/actions/artifacts?name=ops-snapshots&per_page=100&page={page}')['artifacts']
    arts += [x for x in a if not x['expired']]
    if len(a) < 100: break
arts.sort(key=lambda x: x['created_at'])
print(f'{len(arts)} snapshots')
prev = None
for a in arts:
    try:
        z = zipfile.ZipFile(io.BytesIO(get(a['archive_download_url'], raw=True)))
        name = next(n for n in z.namelist() if n.endswith('job_fields.json'))
        d = json.loads(z.read(name))
    except Exception as e:
        print(a['created_at'], 'unreadable', e); continue
    by = {}
    for j in d.get('jobs', []):
        by[str(j.get('name', ''))[:4]] = j
    row = ' | '.join(f"{n}: {('status ' + str(by[n].get('status')) + ' (upd ' + str(by[n].get('statusUpdatedAt') or '')[:10] + ')') if n in by else 'GONE'}" for n in want)
    line = f"{d.get('count')} jobs · {row}"
    if line != prev: print(a['created_at'], line)
    prev = line
