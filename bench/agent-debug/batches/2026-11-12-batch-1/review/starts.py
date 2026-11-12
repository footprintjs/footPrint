"""Compares the start line (system text, tool definitions, task) across all 90 transcripts.
Usage: python3 -I starts.py <batch dir>"""
import json, os, sys, hashlib
from collections import defaultdict
b = sys.argv[1]
sys_h = set(); defs = defaultdict(set); tasks = defaultdict(set); names = defaultdict(set)
for fn in sorted(os.listdir(os.path.join(b, 'transcripts'))):
    d = json.loads(open(os.path.join(b, 'transcripts', fn)).readline())
    s = int(fn[5]); fault = fn[7:].rsplit('-r', 1)[0]
    sys_h.add(d['system'])
    names[s].add(tuple(t['name'] for t in d['tools']))
    for t in d['tools']: defs[t['name']].add(json.dumps(t, sort_keys=True))
    tasks[fault].add(d['task'])
print('distinct system texts:', len(sys_h)); print(repr(list(sys_h)[0]))
for s in sorted(names): print('set-up', s, 'tool lists:', names[s])
for n, v in sorted(defs.items()): print('tool', n, 'distinct definitions across set-ups:', len(v), 'chars', [len(x) for x in v])
print('tasks per fault identical across set-ups:', all(len(v) == 1 for v in tasks.values()))
