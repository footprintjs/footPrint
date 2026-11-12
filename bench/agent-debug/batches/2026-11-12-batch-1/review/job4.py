"""Spread and leave-outs for Job 4, from the transcripts' usage.
Usage: python3 -I job4.py <batch dir> <bench dir>"""
import json, os, sys
b, bench = sys.argv[1], sys.argv[2]
faults = {}
for f in os.listdir(os.path.join(bench, 'faults')):
    if f.endswith('.json'):
        d = json.load(open(os.path.join(bench, 'faults', f))); faults[d['id']] = d
R = []
for fn in os.listdir(os.path.join(b, 'transcripts')):
    L = [json.loads(l) for l in open(os.path.join(b, 'transcripts', fn))]
    tok = sum(d['usage']['input_tokens'] + d['usage']['output_tokens'] for d in L if d['type'] == 'response')
    sc = [d for d in L if d['type'] == 'score'][0]['solved']
    R.append(dict(s=int(fn[5]), f=fn[7:].rsplit('-r', 1)[0], k=int(fn[-7]), tok=tok, ok=sc))
def tps(rs):
    so = sum(r['ok'] for r in rs); return sum(r['tok'] for r in rs) / so if so else float('inf')
G = {'data-flow': [k for k, v in faults.items() if v['class'] == 'data-flow'],
     'decision': [k for k, v in faults.items() if v.get('inDecision')],
     'other4': [k for k, v in faults.items() if v['class'] == 'data-flow' and not v.get('inDecision')],
     'controls': [k for k, v in faults.items() if v['class'] != 'data-flow']}
for g, fs in G.items():
    row = []
    for s in (1, 3):
        per = [tps([r for r in R if r['s'] == s and r['f'] in fs and r['k'] == k]) for k in (1, 2, 3)]
        row.append(f's{s} per repeat ' + ', '.join(f'{x:,.0f}' for x in per) + f' (range {max(per)-min(per):,.0f})')
    a, c = tps([r for r in R if r['s'] == 1 and r['f'] in fs]), tps([r for r in R if r['s'] == 3 and r['f'] in fs])
    print(f'{g:9s}: ' + ' | '.join(row) + f' | pooled s1 {a:,.0f} s3 {c:,.0f} diff {c-a:,.0f} ({100*(1-c/a):.1f}% fewer for s3)')
print('\nleave one fault out, controls and decision groups:')
for g in ('controls', 'decision', 'other4'):
    for f in G[g]:
        fs = [x for x in G[g] if x != f]
        a, c = tps([r for r in R if r['s'] == 1 and r['f'] in fs]), tps([r for r in R if r['s'] == 3 and r['f'] in fs])
        print(f'  {g} without {f:22s}: s1 {a:,.0f} s3 {c:,.0f} -> s3 {100*(1-c/a):.1f}% fewer')
print('\nrank of set-up 3 data-flow runs by tokens (top 5):')
for r in sorted([r for r in R if r['s'] == 3 and r['f'] in G['data-flow']], key=lambda r: -r['tok'])[:5]: print('  ', r)
print('set-up 1 data-flow top 3:')
for r in sorted([r for r in R if r['s'] == 1 and r['f'] in G['data-flow']], key=lambda r: -r['tok'])[:3]: print('  ', r)
