# Tokens per solved task by fault and set-up, and set-up 3 against set-up 1, from runs.jsonl.
import json, sys, os
from collections import defaultdict
rows = [json.loads(l) for l in open(os.path.join(sys.argv[1], 'runs.jsonl'))]
tok = defaultdict(int); solved = defaultdict(int); n = defaultdict(int)
for r in rows:
    k = (r['fault'], r['setup']); tok[k] += r['inputTokens'] + r['outputTokens']; solved[k] += 1 if r['solved'] else 0; n[k] += 1
faults = sorted(set(r['fault'] for r in rows))
print('fault, set-up 1, set-up 2, set-up 3 (tokens per solved task; solved of runs), set-up 3 against set-up 1')
for f in faults:
    per = {s: tok[(f, s)] / solved[(f, s)] for s in (1, 2, 3)}
    print(f"{f:22} " + ' '.join(f"{round(per[s]):7} ({solved[(f,s)]}/{n[(f,s)]})" for s in (1, 2, 3)) + f"   {100 * (per[3] - per[1]) / per[1]:+.1f}%")
allr = {s: [r for r in rows if r['setup'] == s] for s in (1, 2, 3)}
for s in (1, 2, 3):
    rs = allr[s]; t = sum(r['inputTokens'] + r['outputTokens'] for r in rs); sv = sum(1 for r in rs if r['solved'])
    print(f"all ten faults, set-up {s}: solved {sv} of {len(rs)}, tokens {t}, per solved task {round(t / sv)}, mean requests {sum(r['requests'] for r in rs)/len(rs):.2f}, mean final context {round(sum(r['finalContextTokens'] for r in rs)/len(rs))}")
spend = sum(r['inputTokens'] for r in rows) * 0.10 / 1e6 + sum(r['outputTokens'] for r in rows) * 0.50 / 1e6
print('spend at the rule\'s prices:', round(spend, 4))
