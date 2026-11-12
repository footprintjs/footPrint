# Where do the tokens of each set-up go? Reads the batch's transcripts only.
import json, os, sys, statistics as st
from collections import defaultdict
B = sys.argv[1]
runs = [json.loads(l) for l in open(os.path.join(B, 'runs.jsonl'))]
DATA = ['wrong-key-read','wrong-rule','missing-write','wrong-default-branch','swapped-key-in-fork','wrong-mapper-key','loop-stops-early']
CTRL = ['wrong-constant','rounding-misplaced','wrong-threshold']
def tr(r):
    p = os.path.join(B, 'transcripts', f"setup{r['setup']}-{r['fault']}-r{r['repeat']}.jsonl")
    return [json.loads(l) for l in open(p)]
rows = []
for r in runs:
    ev = tr(r)
    resp = [e for e in ev if e['type'] == 'response']
    first_in = resp[0]['usage']['input_tokens']
    # request index (1-based) of the response that issued the first edit_file
    first_edit = None; tok_to_edit = 0; cum = 0
    for i, e in enumerate(resp, 1):
        cum += e['usage']['input_tokens'] + e['usage']['output_tokens']
        if first_edit is None and any(b.get('type') == 'tool_use' and b.get('name') == 'edit_file' for b in e['content']):
            first_edit = i; tok_to_edit = cum
    tools = [e for e in ev if e['type'] == 'tool']
    chars = defaultdict(int); calls = defaultdict(int)
    for t in tools:
        c = t['content']; s = c if isinstance(c, str) else ''.join(b.get('text', '') for b in c if isinstance(b, dict))
        chars[t['name']] += len(s); calls[t['name']] += 1
    rows.append(dict(setup=r['setup'], fault=r['fault'], rep=r['repeat'], solved=r['solved'], req=len(resp), first_in=first_in,
                     total=sum(e['usage']['input_tokens'] + e['usage']['output_tokens'] for e in resp),
                     out=sum(e['usage']['output_tokens'] for e in resp), first_edit=first_edit, tok_to_edit=tok_to_edit,
                     after_edit=cum - tok_to_edit if first_edit else None, chars=dict(chars), calls=dict(calls),
                     errors=sum(1 for t in tools if t.get('is_error'))))
def mean(xs): xs = [x for x in xs if x is not None]; return round(st.mean(xs)) if xs else None
print('first request input tokens (system + tools + task), by set-up:')
for s in (1, 2, 3):
    xs = sorted(set(r['first_in'] for r in rows if r['setup'] == s)); print(' set-up', s, 'min', xs[0], 'max', xs[-1])
print('\nper set-up, data-flow seven: mean requests, mean request of first edit, mean tokens up to first edit, mean tokens after it, mean total, mean output')
for group, name in ((DATA, 'data-flow'), (CTRL, 'controls')):
    for s in (1, 2, 3):
        rs = [r for r in rows if r['setup'] == s and r['fault'] in group]
        print(f" {name:9} set-up {s}: runs {len(rs)} req {st.mean(r['req'] for r in rs):.1f} firstEdit@ {st.mean(r['first_edit'] for r in rs if r['first_edit']):.1f} toEdit {mean([r['tok_to_edit'] for r in rs if r['first_edit']])} after {mean([r['after_edit'] for r in rs])} total {mean([r['total'] for r in rs])} out {mean([r['out'] for r in rs])} toolErrors {sum(r['errors'] for r in rs)}")
print('\ntool calls and answer characters per run (mean), by set-up, all 30 runs:')
for s in (1, 2, 3):
    rs = [r for r in rows if r['setup'] == s]; names = sorted(set(n for r in rs for n in r['calls']))
    print(' set-up', s, ' '.join(f"{n}:{sum(r['calls'].get(n,0) for r in rs)/len(rs):.1f}x/{round(sum(r['chars'].get(n,0) for r in rs)/len(rs))}ch" for n in names))
print('\nevery run: setup fault rep solved req firstEdit@ toEdit total')
for r in sorted(rows, key=lambda r: (r['fault'], r['setup'], r['rep'])):
    print(f" {r['setup']} {r['fault']:22} r{r['rep']} {'ok ' if r['solved'] else 'NO '} req {r['req']:2} edit@ {r['first_edit']} toEdit {r['tok_to_edit']:6} total {r['total']:6} err {r['errors']} {r['calls']}")
