"""Extra measures for Job 5: tool-definition overhead, requests before the faulty
file is first read, record-tool answer sizes, files in the code base.
Usage: python3 -I extra.py <batch dir> <bench dir>"""
import json, os, re, sys
from collections import defaultdict
b, bench = sys.argv[1], sys.argv[2]
faults = {json.load(open(os.path.join(bench, 'faults', f)))['id']: json.load(open(os.path.join(bench, 'faults', f))) for f in os.listdir(os.path.join(bench, 'faults')) if f.endswith('.json')}
DF = [k for k, v in faults.items() if v['class'] == 'data-flow']; CT = [k for k, v in faults.items() if v['class'] != 'data-flow']
man = json.load(open(os.path.join(bench, 'program', 'MANIFEST.json')))
print('working-folder files:', len(man), ' src:', sum(1 for k in man if k.startswith('src/')), ' fixtures:', sum(1 for k in man if k.startswith('fixtures/')))
runs = []
for fn in sorted(os.listdir(os.path.join(b, 'transcripts'))):
    s = int(fn[5]); fid = fn[7:].rsplit('-r', 1)[0]
    lines = [json.loads(l) for l in open(os.path.join(b, 'transcripts', fn))]
    resp = [d for d in lines if d['type'] == 'response']
    score = [d for d in lines if d['type'] == 'score'][0]
    # request index (1-based) of each tool call
    req = 0; first_faulty = None; locate_only = 0; recs = defaultdict(int); reqtools = defaultdict(list)
    for d in lines:
        if d['type'] == 'request': req = d['n']
        if d['type'] == 'tool':
            reqtools[req].append(d['name'])
            if d['name'] == 'read_file' and d['input'].get('path') == faults[fid]['file'] and first_faulty is None and not d['is_error']:
                first_faulty = req
            if d['name'] in ('why', 'story', 'step', 'map'): recs[d['name']] += len(d['content'])
    first_edit = next(r for r, ts in sorted(reqtools.items()) if 'edit_file' in ts)
    runs.append(dict(s=s, f=fid, fn=fn, n=len(resp), first_in=resp[0]['usage']['input_tokens'],
                     tok=sum(x['usage']['input_tokens'] + x['usage']['output_tokens'] for x in resp), solved=score['solved'],
                     first_faulty=first_faulty, first_edit=first_edit, recs=dict(recs), reqtools=dict(reqtools)))
base = sum(r['first_in'] for r in runs if r['s'] == 1) / 30
print(f'mean set-up 1 first-request input {base:.0f}')
for grp, fs in (('data-flow', DF), ('controls', CT), ('all', DF + CT)):
    for s in (1, 2, 3):
        rs = [r for r in runs if r['s'] == s and r['f'] in fs]
        tok = sum(r['tok'] for r in rs); sol = sum(r['solved'] for r in rs)
        over = sum((r['first_in'] - base) * r['n'] for r in rs)
        print(f' {grp:9s} set-up {s}: tokens {tok:,}; definitions beyond set-up 1 x requests = {over:,.0f} ({100*over/tok:.1f}%); per solved {tok/sol:,.0f}, without that overhead {(tok-over)/sol:,.0f}')
print('\nrequest at which the faulty file is first read / first edit (mean), by set-up and group')
for grp, fs in (('data-flow', DF), ('controls', CT)):
    for s in (1, 2, 3):
        rs = [r for r in runs if r['s'] == s and r['f'] in fs]
        ff = [r['first_faulty'] for r in rs if r['first_faulty']]
        print(f' {grp} set-up {s}: faulty file read at request {sum(ff)/len(ff):.2f} (read in {len(ff)}/{len(rs)} runs); first edit at {sum(r["first_edit"] for r in rs)/len(rs):.2f}')
print('\nset-up 3: requests before the faulty file was read that called ONLY locating tools (step/search/list_files/map)')
cnt = 0; tot = 0
for r in runs:
    if r['s'] != 3: continue
    tot += 1
    upto = r['first_faulty'] or r['first_edit']
    only = [k for k, ts in r['reqtools'].items() if k < upto and set(ts) <= {'step', 'search', 'list_files', 'map'}]
    if only: cnt += 1
print(f' runs with such a request: {cnt}/{tot}')
print(' runs that called step:', sum(1 for r in runs if r['s'] == 3 and 'step' in r['recs']), ' read faulty file without ever calling step:', sum(1 for r in runs if r['s'] == 3 and 'step' not in r['recs'] and r['first_faulty']))
print('\nset-up 3 record-tool answer characters per run (mean over 30):')
agg = defaultdict(int)
for r in runs:
    if r['s'] == 3:
        for k, v in r['recs'].items(): agg[k] += v
print(' ', {k: round(v / 30) for k, v in agg.items()})
print('\nset-up 3 runs that used no record tool except map:', [r['fn'] for r in runs if r['s'] == 3 and set(r['recs']) <= {'map'}])
print('set-up 3 first request tools:', sorted({tuple(sorted(r['reqtools'][1])) for r in runs if r['s'] == 3}))

print('\nper set-up: runs with a request before the faulty file was read whose calls were ONLY step/search/list_files (no map, no read, no run)')
for s in (1, 2, 3):
    c = 0; ex = []
    for r in runs:
        if r['s'] != s: continue
        upto = r['first_faulty'] or r['first_edit']
        only = [k for k, ts in r['reqtools'].items() if k < upto and set(ts) <= {'step', 'search', 'list_files'}]
        if only: c += 1; ex.append((r['fn'], {k: r['reqtools'][k] for k in only}))
    print(f' set-up {s}: {c}/30')
    if s == 3:
        for e in ex: print('   ', e)
