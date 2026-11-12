"""Recompute batch-1's numbers from the TRANSCRIPTS, without the harness.

Usage: python3 -I numbers.py <batch dir> <bench dir>
Prints: row-by-row comparison with runs.jsonl, plan coverage, headline and
robustness tables, the Go test, spend, spread across repeats, new vs re-sent
tokens per set-up, tool errors and answers at their limit, namedFaultyStep.
"""
import json, os, re, sys
from collections import Counter, defaultdict

batch, bench = sys.argv[1], sys.argv[2]
faults = {}
for f in os.listdir(os.path.join(bench, 'faults')):
    if f.endswith('.json'):
        d = json.load(open(os.path.join(bench, 'faults', f)))
        faults[d['id']] = d
DATAFLOW = sorted(k for k, v in faults.items() if v['class'] == 'data-flow')
DECISION = sorted(k for k, v in faults.items() if v.get('inDecision'))
OTHER4 = sorted(set(DATAFLOW) - set(DECISION))
CONTROLS = sorted(k for k, v in faults.items() if v['class'] == 'inside-step')
LIMITS = {'list_files': 4000, 'read_file': 12000, 'search': 4000, 'run_order': 6000, 'run_tests': 4000,
          'edit_file': 1000, 'done': 200, 'map': 4000, 'step': 4000, 'why': 6000, 'story': 8000}

order = json.load(open(os.path.join(batch, 'order.json')))
plan = Counter((p['setup'], p['fault'], p['repeat']) for p in order['plan'])
rows = [json.loads(l) for l in open(os.path.join(batch, 'runs.jsonl')) if l.strip()]
started = [json.loads(l) for l in open(os.path.join(batch, 'started.jsonl')) if l.strip()]
rowkeys = Counter((r['setup'], r['fault'], r['repeat']) for r in rows)
startkeys = Counter((r['setup'], r['fault'], r['repeat']) for r in started)
tfiles = sorted(os.listdir(os.path.join(batch, 'transcripts')))
print('== plan coverage')
print(' plan entries', sum(plan.values()), 'distinct', len(plan), 'max multiplicity', max(plan.values()))
print(' rows', len(rows), 'distinct', len(rowkeys), 'twice', [k for k, c in rowkeys.items() if c > 1])
print(' missing from rows', sorted(set(plan) - set(rowkeys)), 'unplanned rows', sorted(set(rowkeys) - set(plan)))
print(' started', len(started), 'same set as plan', set(startkeys) == set(plan))
print(' transcript files', len(tfiles))
print(' full grid 3x10x3 equals plan', set(plan) == {(s, f, k) for s in (1, 2, 3) for f in faults for k in (1, 2, 3)})
print(' seed', order.get('seed'), 'commit', order.get('code'), 'versions', order.get('versions'))
print(' stopReasons', Counter(r['stopReason'] for r in rows))


def parse(path):
    t = dict(responses=[], tools=[], start=None, end=None, score=None, retries=0, requests_logged=0, order=[])
    for line in open(path):
        d = json.loads(line)
        ty = d['type']
        t['order'].append(ty)
        if ty == 'start': t['start'] = d
        elif ty == 'request': t['requests_logged'] += 1
        elif ty == 'response': t['responses'].append(d)
        elif ty == 'tool': t['tools'].append(d)
        elif ty == 'end': t['end'] = d
        elif ty == 'score': t['score'] = d
        elif ty == 'retry': t['retries'] += 1
    return t


T = {}
diffs = []
for r in rows:
    t = parse(os.path.join(batch, r['transcript']))
    T[(r['setup'], r['fault'], r['repeat'])] = t
    us = [x.get('usage') or {} for x in t['responses']]
    inp = sum(u.get('input_tokens', 0) for u in us)
    out = sum(u.get('output_tokens', 0) for u in us)
    think = sum((u.get('output_tokens_details') or {}).get('thinking_tokens', 0) for u in us)
    missing_usage = sum(1 for x in t['responses'] if not x.get('usage') or 'input_tokens' not in x['usage'])
    cache = sum(u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0) for u in us)
    tc = Counter(x['name'] for x in t['tools'])
    errs = sum(1 for x in t['tools'] if x['is_error'])
    rfc = sum(len(x['content']) for x in t['tools'] if x['name'] == 'read_file' and not x['is_error'])
    final = (us[-1].get('input_tokens', 0) + us[-1].get('output_tokens', 0)) if us else 0
    largest = max((u.get('input_tokens', 0) for u in us), default=0)
    edits = sum(1 for x in t['tools'] if x['name'] == 'edit_file' and not x['is_error'])
    mine = dict(inputTokens=inp, outputTokens=out, thinkingTokens=think, requests=len(t['responses']), toolCalls=dict(tc),
                toolErrors=errs, readFileChars=rfc, finalContextTokens=final, largestRequestTokens=largest, edits=edits,
                solved=t['score']['solved'] if t['score'] else None, stopReason=t['end']['stopReason'] if t['end'] else None,
                retries=t['retries'])
    r['_mine'] = mine
    r['_missing_usage'] = missing_usage
    r['_cache'] = cache
    for k, v in mine.items():
        if r.get(k) != v:
            diffs.append((r['transcript'], k, r.get(k), v))
    if t['end'] and t['end'].get('inputTokens') != inp:
        diffs.append((r['transcript'], 'end-line inputTokens', t['end'].get('inputTokens'), inp))
print('\n== transcript vs runs.jsonl')
print(' fields compared per row:', list(rows[0]['_mine'].keys()))
print(' differences:', len(diffs))
for d in diffs: print('  ', d)
print(' responses without usage:', sum(r['_missing_usage'] for r in rows), ' any cache tokens:', sum(r['_cache'] for r in rows))
print(' logged request lines == responses in every run:', all(T[k]['requests_logged'] == len(T[k]['responses']) for k in T))
print(' retries total:', sum(r['_mine']['retries'] for r in rows))
print(' stop_reason of responses:', Counter(x['stop_reason'] for t in T.values() for x in t['responses']))
maxout = max(u['usage']['output_tokens'] for t in T.values() for u in t['responses'])
print(' largest single response output tokens:', maxout)

finished = [r for r in rows if r['_mine']['stopReason'] not in ('error', 'interrupted')]
print(' error/interrupted runs:', len(rows) - len(finished))


def tot(r): return r['_mine']['inputTokens'] + r['_mine']['outputTokens']


def head(rs):
    n = len(rs); s = sum(1 for r in rs if r['_mine']['solved']); tk = sum(tot(r) for r in rs)
    return n, s, tk, (tk / s if s else float('inf'))


def fmt(h):
    n, s, tk, tps = h
    return f'{s}/{n} ({100*s/n:.0f}%) tokens {tk:,} per-solved {tps:,.0f}'


def sel(setup, fs, rs=finished): return [r for r in rs if r['setup'] == setup and r['fault'] in fs]


print('\n== headline (finished runs)')
for name, fs in (('7 data-flow', DATAFLOW), ('3 decision', DECISION), ('4 other', OTHER4), ('3 controls', CONTROLS)):
    for s in (1, 2, 3):
        h = head(sel(s, fs))
        reqs = [r['_mine']['requests'] for r in sel(s, fs)]
        print(f' {name:12s} set-up {s}: {fmt(h)}  mean req {sum(reqs)/len(reqs):.2f}')
    h1, h3 = head(sel(1, fs)), head(sel(3, fs))
    print(f'   set-up 3 fewer tokens per solved than set-up 1: {100*(1-h3[3]/h1[3]):.1f}%')


def go_row(r1, r3, margin):
    h1, h3 = head(r1), head(r3)
    share_ok = h3[1] / h3[0] >= h1[1] / h1[0]
    cheaper = 1 - h3[3] / h1[3]
    return share_ok, cheaper, cheaper >= margin and share_ok, h1, h3


print('\n== Go test (data-flow seven)')
ok, ch, holds, h1, h3 = go_row(sel(1, DATAFLOW), sel(3, DATAFLOW), 0.25)
print(f' all seven: share ok {ok}, set-up 3 fewer tokens {100*ch:.1f}% (needs 25%) -> {holds}')
for f in DATAFLOW:
    fs = [x for x in DATAFLOW if x != f]
    ok, ch, holds, h1, h3 = go_row(sel(1, fs), sel(3, fs), 0.15)
    print(f' leave out {f:22s}: s1 {fmt(h1)} | s3 {fmt(h3)} | fewer {100*ch:.1f}% share ok {ok} holds {holds}')
drop = {}
for s in (1, 3):
    rs = sel(s, DATAFLOW)
    m = max(rs, key=tot); drop[s] = [r for r in rs if r is not m]
    print(f' most expensive data-flow run of set-up {s}: {m["transcript"]} {tot(m):,}')
ok, ch, holds, h1, h3 = go_row(drop[1], drop[3], 0.15)
print(f' leave out each set-up\'s most expensive: s1 {fmt(h1)} | s3 {fmt(h3)} | fewer {100*ch:.1f}% share ok {ok} holds {holds}')
s2 = sel(2, DATAFLOW); m2 = max(s2, key=tot)
print(f' (set-up 2 most expensive data-flow: {m2["transcript"]} {tot(m2):,}; without it {fmt(head([r for r in s2 if r is not m2]))})')

print('\n== every fault by itself (finished)')
for f in sorted(faults):
    line = []
    for s in (1, 2, 3):
        rs = sel(s, [f]); n, so, tk, tps = head(rs)
        line.append(f's{s} {so}/{n} {tps:>9,.0f} [{", ".join(f"{tot(r):,}" for r in sorted(rs, key=lambda r: r["repeat"]))}]')
    print(f' {f:22s} ' + ' | '.join(line))

print('\n== spend at RULE prices (0.10 in, 0.50 out per million)')
ti = sum(r['_mine']['inputTokens'] for r in rows); to = sum(r['_mine']['outputTokens'] for r in rows)
print(f' input {ti:,} output {to:,} spend ${ti*0.10/1e6 + to*0.50/1e6:.4f}')
for s in (1, 2, 3):
    rs = [r for r in rows if r['setup'] == s]
    a = sum(r['_mine']['inputTokens'] for r in rs); b = sum(r['_mine']['outputTokens'] for r in rs)
    print(f'  set-up {s}: input {a:,} output {b:,} spend ${a*0.10/1e6 + b*0.50/1e6:.4f}')

print('\n== spread: the headline per repeat index (data-flow seven), and per-cell range')
for s in (1, 2, 3):
    parts = []
    for k in (1, 2, 3):
        rs = [r for r in sel(s, DATAFLOW) if r['repeat'] == k]
        parts.append(f'r{k}: {fmt(head(rs))}')
    print(f' set-up {s}: ' + ' | '.join(parts))
for s in (1, 2, 3):
    for name, fs in (('data-flow', DATAFLOW), ('controls', CONTROLS)):
        ratios = []
        for f in fs:
            v = [tot(r) for r in sel(s, [f])]
            ratios.append(max(v) / min(v))
        print(f' set-up {s} {name}: per-cell max/min ratio, min {min(ratios):.2f} median {sorted(ratios)[len(ratios)//2]:.2f} max {max(ratios):.2f}')
# pairwise: for each data-flow fault, s3 mean vs s1 mean and whether ranges overlap
print(' per fault (data-flow + controls): s1 range, s3 range, overlap?')
for f in DATAFLOW + CONTROLS:
    a = [tot(r) for r in sel(1, [f])]; b = [tot(r) for r in sel(3, [f])]
    print(f'  {f:22s} s1 {min(a):>7,}-{max(a):>7,} mean {sum(a)/3:>8,.0f} | s3 {min(b):>7,}-{max(b):>7,} mean {sum(b)/3:>8,.0f} | overlap {not (max(a) < min(b) or max(b) < min(a))}')

print('\n== tool errors and answers at the limit, by set-up and tool')
errs = defaultdict(Counter); cut = defaultdict(Counter); calls = defaultdict(Counter); near = defaultdict(Counter)
for (s, f, k), t in T.items():
    for x in t['tools']:
        calls[s][x['name']] += 1
        if x['is_error']: errs[s][x['name']] += 1
        if '\n[cut: the answer was' in x['content']: cut[s][x['name']] += 1
        if len(x['content']) >= 0.9 * LIMITS[x['name']]: near[s][x['name']] += 1
        if 'characters cut from the middle' in x['content']: near[s][x['name'] + '(middle-cut)'] += 1
for s in (1, 2, 3):
    print(f' set-up {s}: calls {dict(calls[s])}\n   is_error {dict(errs[s])}\n   cut at limit {dict(cut[s])}\n   >=90% of limit {dict(near[s])}')
print(' every is_error answer:')
for (s, f, k), t in sorted(T.items()):
    for x in t['tools']:
        if x['is_error']: print(f'  setup{s}-{f}-r{k} {x["name"]} {json.dumps(x["input"])[:120]} -> {x["content"][:200]!r}')
print(' fixtures asked of record tools and run_order (symptom fixture or other):')
fx = Counter()
for (s, f, k), t in T.items():
    for x in t['tools']:
        if x['name'] in ('step', 'why', 'story', 'run_order') and isinstance(x['input'], dict) and 'fixture' in x['input']:
            fx[(s, x['name'], x['input']['fixture'].replace('.json', '').replace('fixtures/', '') == faults[f]['symptom']['fixture'])] += 1
for k, v in sorted(fx.items()): print(f'  set-up {k[0]} {k[1]} symptom-fixture={k[2]}: {v}')

print('\n== new vs re-sent tokens (per run, summed by set-up; caching cost weighs these)')
for name, fs in (('all 10', sorted(faults)), ('7 data-flow', DATAFLOW), ('3 controls', CONTROLS)):
    for s in (1, 2, 3):
        first = newin = resent = outp = shrink = 0
        rs = sel(s, fs)
        for r in rs:
            us = [x['usage'] for x in T[(r['setup'], r['fault'], r['repeat'])]['responses']]
            for i, u in enumerate(us):
                outp += u['output_tokens']
                if i == 0:
                    first += u['input_tokens']; continue
                prev = us[i - 1]['input_tokens'] + us[i - 1]['output_tokens']
                re_ = min(prev, u['input_tokens'])
                if u['input_tokens'] < prev: shrink += 1
                resent += re_; newin += u['input_tokens'] - re_
        n = len(rs)
        print(f' {name:11s} set-up {s}: per run mean: first-request input {first/n:,.0f}, new input later {newin/n:,.0f}, output {outp/n:,.0f}, re-sent {resent/n:,.0f}; new total (first+new+out) {(first+newin+outp)/n:,.0f}; requests where input < prev input+output: {shrink}')
    # per-solved versions
    for s in (1, 2, 3):
        rs = sel(s, fs); sol = sum(1 for r in rs if r['_mine']['solved'])
        newsum = 0; resum = 0
        for r in rs:
            us = [x['usage'] for x in T[(r['setup'], r['fault'], r['repeat'])]['responses']]
            for i, u in enumerate(us):
                newsum += u['output_tokens']
                if i == 0: newsum += u['input_tokens']; continue
                prev = us[i - 1]['input_tokens'] + us[i - 1]['output_tokens']
                re_ = min(prev, u['input_tokens']); resum += re_; newsum += u['input_tokens'] - re_
        print(f'   {name} set-up {s}: per solved task: new {newsum/sol:,.0f}, re-sent {resum/sol:,.0f}')

print('\n== first-request input by set-up')
for s in (1, 2, 3):
    v = [T[k]['responses'][0]['usage']['input_tokens'] for k in T if k[0] == s]
    print(f' set-up {s}: min {min(v)} max {max(v)} mean {sum(v)/len(v):.0f}')

print('\n== read_file calls/chars, requests by set-up (all 30)')
for s in (1, 2, 3):
    rs = [r for r in rows if r['setup'] == s]
    print(f' set-up {s}: read_file calls/run {sum(r["_mine"]["toolCalls"].get("read_file",0) for r in rs)/30:.1f}, chars/run {sum(r["_mine"]["readFileChars"] for r in rs)/30:,.0f}, requests/run {sum(r["_mine"]["requests"] for r in rs)/30:.2f}, solved {sum(1 for r in rs if r["_mine"]["solved"])}/30')

print('\n== namedFaultyStep: whole-word test (score.mjs namesStep) vs which steps the summary names')
steps = set()
for root, ds, fs_ in os.walk(os.path.join(bench, 'program', 'src', 'steps')):
    for d in ds: steps.add(d)
steps |= {'tax', 'find-rate', 'compute-tax'}


def names(summary, addr):
    return re.search(r'(^|[^A-Za-z0-9-])' + re.escape(addr) + r'($|[^A-Za-z0-9-])', summary, re.I) is not None


bad = []
for r in sorted(rows, key=lambda r: (r['fault'], r['setup'], r['repeat'])):
    f = faults[r['fault']]
    summ = r.get('doneSummary') or ''
    named = sorted(a for a in steps if names(summ, a))
    mine = names(summ, f['stepAddress'])
    if mine != r['namedFaultyStep']: print(' MISMATCH with row', r['transcript'])
    if mine and (len(named) > 1 or not r['editedFaultyFile']):
        bad.append((r['transcript'], f['stepAddress'], named, r['editedFiles'], summ))
print(' rows where the faulty address matches but other steps are named too or the faulty file was not edited:', len(bad))
for b in bad: print('  ', b[0], '| faulty', b[1], '| named', b[2], '| edited', b[3], '\n     ', b[4])
print(' namedFaultyStep true:', sum(r['namedFaultyStep'] for r in rows), ' editedFaultyFile true:', sum(r['editedFaultyFile'] for r in rows), ' solved:', sum(r['_mine']['solved'] for r in rows))
