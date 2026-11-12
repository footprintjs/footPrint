"""Small checks behind sentences of the report.
Usage: python3 -I checks.py <batch dir>"""
import json, os, re, sys
from collections import defaultdict
b = sys.argv[1]
T = os.path.join(b, 'transcripts')
def load(fn): return [json.loads(l) for l in open(os.path.join(T, fn))]
tot = defaultdict(int); wc = defaultdict(int)
for fn in os.listdir(T):
    s = int(fn[5]); t = sum(d['usage']['input_tokens'] + d['usage']['output_tokens'] for d in load(fn) if d['type'] == 'response')
    tot[s] += t
    if '-wrong-constant-' in fn: wc[s] += t
for s in (1, 2, 3): print(f'set-up {s}: wrong-constant {wc[s]:,} of {tot[s]:,} = {100*wc[s]/tot[s]:.1f}%')
# why answer of the unsolved run: links, depth, position of tax
why = next(d['content'] for d in load('setup3-wrong-mapper-key-r1.jsonl') if d['type'] == 'tool' and d['name'] == 'why')
links = [l for l in why.split('\n') if re.match(r'\[\d+\] ', l)]
print('why links:', len(links), 'max depth', max(int(l[1:l.index(']')]) for l in links), 'total lines', len(why.split('\n')))
for i, l in enumerate(links, 1):
    if l.split()[1].startswith('tax#'): print(' tax link is number', i, 'at depth', l[1:l.index(']')])
    if l.split()[1].startswith('receive-order#'): print(' receive-order link is number', i)
print('arith:', round(2409.92 * 0.08, 2), round(2409.92 + 192.79, 2), round(9000 - 6000 - 2602.71, 2))
# largest read_file answer in set-up 1, and reads per request in set-up 1
mx = 0; per = []
for fn in os.listdir(T):
    if not fn.startswith('setup1'): continue
    req = 0; cnt = defaultdict(int)
    for d in load(fn):
        if d['type'] == 'request': req = d['n']
        if d['type'] == 'tool' and d['name'] == 'read_file':
            cnt[req] += 1; mx = max(mx, len(d['content']))
    per += list(cnt.values())
print('set-up 1 largest read_file answer chars:', mx, '; read_file calls per request that read: min', min(per), 'max', max(per), 'mean', round(sum(per)/len(per), 1))
o = json.load(open(os.path.join(b, 'order.json')))['plan']
st = [json.loads(l) for l in open(os.path.join(b, 'started.jsonl'))]
rw = [json.loads(l) for l in open(os.path.join(b, 'runs.jsonl'))]
key = lambda x: (x['setup'], x['fault'], x['repeat'])
print('started in plan order:', [key(p) for p in o] == [key(x) for x in st], '; rows in plan order:', [key(p) for p in o] == [key(x) for x in rw])
print('minutes from first to last start:', round((st[-1]['at'] - st[0]['at']) / 60000, 1))
for s in (1, 2, 3):
    idx = [i for i, p in enumerate(o) if p['setup'] == s]
    print(f'set-up {s} mean plan position {sum(idx)/len(idx):.1f}')
# record answers: identical per (fault, tool, input) before any edit? and map across runs
ans = defaultdict(set); maps = set(); mapruns = 0
for fn in os.listdir(T):
    if not fn.startswith('setup'): continue
    s = int(fn[5]); fid = fn[7:].rsplit('-r', 1)[0]; edited = False; sawmap = False
    for d in load(fn):
        if d['type'] != 'tool': continue
        if d['name'] == 'edit_file' and not d['is_error']: edited = True
        if d['name'] == 'map' and not d['input']:
            maps.add((s, d['content'])); sawmap = True
        if d['name'] in ('why', 'step', 'story') and not edited:
            ans[(fid, d['name'], json.dumps(d['input'], sort_keys=True))].add(d['content'])
    mapruns += sawmap and s == 3
print('distinct map() answers by set-up:', sorted({(s, len(c)) for s, c in maps}), '; set-up 3 runs that called map():', mapruns)
print('record questions asked before an edit:', len(ans), '; with more than one distinct answer:', sum(1 for v in ans.values() if len(v) > 1))
from collections import Counter
ed = Counter(); logs = 0
for fn in os.listdir(T):
    n = 0
    for d in load(fn):
        if d['type'] == 'tool' and d['name'] == 'edit_file':
            n += 1
            if 'console.' in json.dumps(d['input']): logs += 1
    ed[n] += 1
print('edit_file calls per run:', dict(ed), '; edits that add console output:', logs)
