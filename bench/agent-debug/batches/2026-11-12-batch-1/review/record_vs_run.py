"""Do the record tools print the FAULTY run's values? For each set-up 3 transcript,
every `key = number` the record tools (why/step/story) print for a result key
(grandTotal, tax, subtotal, shipping, discount, loyaltyDiscount, status) before the
agent's first edit is compared with the faulty program's own result for that
fixture, taken from run_order answers made before any edit in ANY set-up's
transcript of the same fault, and with the correct value in hidden/expected.json.

Usage: python3 -I record_vs_run.py <batch dir> <bench dir>
"""
import json, os, re, sys
from collections import defaultdict

batch, bench = sys.argv[1], sys.argv[2]
expected = json.load(open(os.path.join(bench, 'hidden', 'expected.json')))
KEYS = ('grandTotal', 'tax', 'subtotal', 'shipping', 'discount', 'loyaltyDiscount', 'status')

faulty = defaultdict(dict)  # (fault, fixture) -> result
for fn in sorted(os.listdir(os.path.join(batch, 'transcripts'))):
    fid = re.match(r'setup\d-(.+)-r\d\.jsonl', fn).group(1)
    edited = False
    for line in open(os.path.join(batch, 'transcripts', fn)):
        d = json.loads(line)
        if d['type'] != 'tool': continue
        if d['name'] == 'edit_file' and not d['is_error']: edited = True
        if d['name'] == 'run_order' and not edited:
            m = re.search(r'result:\n(\{.*?\n\})', d['content'], re.S)
            if m:
                res = json.loads(m.group(1))
                fx = d['input']['fixture'].replace('.json', '').replace('fixtures/', '')
                prev = faulty[(fid, fx)]
                if prev and prev != res: print('NOT DETERMINISTIC', fid, fx)
                faulty[(fid, fx)] = res

checked = agree = 0
disagree = []
for fn in sorted(os.listdir(os.path.join(batch, 'transcripts'))):
    if not fn.startswith('setup3'): continue
    fid = re.match(r'setup\d-(.+)-r\d\.jsonl', fn).group(1)
    edited = False
    for line in open(os.path.join(batch, 'transcripts', fn)):
        d = json.loads(line)
        if d['type'] != 'tool': continue
        if d['name'] == 'edit_file' and not d['is_error']: edited = True
        if d['name'] not in ('why', 'step', 'story') or edited or d['is_error']: continue
        fx = d['input'].get('fixture')
        if not fx: continue
        res = faulty.get((fid, fx))
        if not res:
            print('no faulty run_order result for', fid, fx); continue
        # final values: the record prints intermediate values too (subtotal in the loop), so take the LAST printed value per key
        last = {}
        for m in re.finditer(r'\b(' + '|'.join(KEYS) + r') = ("?[\w.\-]+"?)', d['content']):
            last[m.group(1)] = m.group(2).strip('"')
        for k, v in last.items():
            if k not in res: continue
            checked += 1
            if str(res[k]) == v or (isinstance(res[k], (int, float)) and float(v) == res[k]):
                agree += 1
            else:
                disagree.append((fn, d['name'], k, v, 'faulty run_order:', res[k], 'expected:', expected[fx][k]))
print('record values compared with the faulty run (last value per key per answer):', checked, 'agree', agree)
for x in disagree: print('  ', x)
print('\nfaulty results vs expected, symptom fixtures:')
for (fid, fx), res in sorted(faulty.items()):
    diff = {k: (res[k], expected[fx][k]) for k in res if res[k] != expected[fx][k]}
    print(f'  {fid:22s} {fx:22s} differs from expected in {diff}')

print('\ncorrect-only values (expected != faulty) printed by a record tool before the first edit, as `key = value`:')
hits = 0; looked = 0
for fn in sorted(os.listdir(os.path.join(batch, 'transcripts'))):
    if not fn.startswith('setup3'): continue
    fid = re.match(r'setup\d-(.+)-r\d\.jsonl', fn).group(1)
    edited = False
    for line in open(os.path.join(batch, 'transcripts', fn)):
        d = json.loads(line)
        if d['type'] != 'tool': continue
        if d['name'] == 'edit_file' and not d['is_error']: edited = True
        if d['name'] not in ('why', 'step', 'story', 'map') or edited: continue
        fx = d['input'].get('fixture')
        for (f2, fx2), res in faulty.items():
            if f2 != fid or (fx and fx2 != fx): continue
            for k in KEYS:
                if k in res and res[k] != expected[fx2][k]:
                    looked += 1
                    ev = expected[fx2][k]
                    pat = rf'\b{k} = "?{re.escape(str(ev))}"?(?![\d.])'
                    if re.search(pat, d['content']):
                        hits += 1; print('  HIT', fn, d['name'], k, ev)
print('  pairs looked at:', looked, 'hits:', hits)
