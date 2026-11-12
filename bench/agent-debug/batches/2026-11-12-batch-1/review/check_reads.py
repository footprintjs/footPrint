"""Checks every read_file / list_files / search answer of all 90 transcripts
against the working copy (program/ + the fault, then the run's own edits, in
order), and searches every tool answer for strings that must never appear.

Usage: python3 -I check_reads.py <batch dir> <bench dir>
Builds the copies in memory from program/MANIFEST.json; imports nothing of the harness.
"""
import json, os, re, sys
from collections import Counter

batch, bench = sys.argv[1], sys.argv[2]
prog = os.path.join(bench, 'program')
manifest = json.load(open(os.path.join(prog, 'MANIFEST.json')))
base = {rel: open(os.path.join(prog, rel), encoding='utf8').read() for rel in manifest}
faults = {}
for f in os.listdir(os.path.join(bench, 'faults')):
    if f.endswith('.json'):
        d = json.load(open(os.path.join(bench, 'faults', f))); faults[d['id']] = d
expected = json.load(open(os.path.join(bench, 'hidden', 'expected.json')))
orders = json.load(open(os.path.join(bench, 'hidden', 'orders.json')))


def bounded(text, limit):
    return text if len(text) <= limit else f'{text[:limit]}\n[cut: the answer was {len(text)} characters; only the first {limit} are shown]'


def read_answer(files, inp):
    rel = inp['path'].strip('/')
    rel = '/'.join(s for s in rel.split('/') if s not in ('', '.'))
    if rel not in files: return None
    lines = files[rel].split('\n')
    start = max(1, inp.get('start_line') or 1)
    end = min(len(lines), inp.get('end_line') or len(lines))
    if start > end: return None
    w = len(str(end))
    body = [f'{str(start + i).rjust(w)}| {t}' for i, t in enumerate(lines[start - 1:end])]
    return bounded('\n'.join([f'{rel}, lines {start}-{end} of {len(lines)}:'] + body), 12000)


stats = Counter()
problems = []
leak_hits = []

# strings that must never appear in a tool answer
never = {}
for fid, f in faults.items():
    never[f'fault id {fid}'] = fid
    never[f'fault kind {fid}'] = f['kind']
for name, o in orders.items():
    if name.startswith('hidden'):
        never[f'hidden fixture name {name}'] = name
        never[f'hidden orderId {name}'] = o['orderId']
        for k in ('grandTotal', 'tax', 'subtotal', 'shipping', 'discount'):
            v = expected[name][k]
            # a bare small integer (50) matches line numbers and prices everywhere; it is listed apart below
            if isinstance(v, (int, float)) and ('.' in str(v) or v >= 1000):
                never[f'hidden expected {name}.{k}'] = str(v)
for word in ('expected.json', 'orders.json', 'hiddenFixtures', 'inDecision', 'stepAddress', 'RULE.md', 'faults/'):
    never[f'harness word {word}'] = word

for fn in sorted(os.listdir(os.path.join(batch, 'transcripts'))):
    m = re.match(r'setup(\d)-(.+)-r(\d)\.jsonl', fn)
    s, fid, k = int(m.group(1)), m.group(2), int(m.group(3))
    f = faults[fid]
    files = dict(base)
    assert files[f['file']].count(f['find']) == 1
    files[f['file']] = files[f['file']].replace(f['find'], f['replace'])
    fixed_file_edited = False
    for line in open(os.path.join(batch, 'transcripts', fn)):
        d = json.loads(line)
        if d['type'] != 'tool': continue
        name, inp, out = d['name'], d['input'], d['content']
        stats[(s, name)] += 1
        # leaks: never-strings in any tool answer
        for label, needle in never.items():
            if needle in out:
                if label.startswith('hidden expected'):
                    # numbers: count only as a whole number token
                    if not re.search(r'(?<![\d.])' + re.escape(needle) + r'(?![\d])', out): continue
                leak_hits.append((fn, name, label, out[max(0, out.find(needle) - 80): out.find(needle) + 80].replace('\n', ' | ')))
        # the original (fix) text in an answer before the faulty file was edited
        orig_lines = [l.strip() for l in f['find'].split('\n') if l.strip() and l.strip() not in f['replace']]
        for ol in orig_lines:
            if ol in out and not fixed_file_edited and name != 'edit_file':
                leak_hits.append((fn, name, 'fix text before the fix', ol))
        if name == 'read_file':
            if d['is_error']:
                stats['read_file error'] += 1
                if read_answer(files, inp) is not None: problems.append((fn, 'read_file error but file exists', inp))
                continue
            exp = read_answer(files, inp)
            if exp != out:
                problems.append((fn, 'read_file differs from copy', inp, out.split('\n')[0]))
            else:
                stats['read_file exact'] += 1
        elif name == 'list_files':
            listed = [l.rsplit(' (', 1)[0] for l in out.split('\n')]
            if sorted(listed) != sorted(files):
                problems.append((fn, 'list_files differs', sorted(set(listed) ^ set(files))))
            else:
                ok = all(f'{rel} ({len(files[rel].split(chr(10)))} lines)' in out.split('\n') for rel in files)
                stats['list_files exact' if ok else 'list_files names only'] += 1
        elif name == 'search' and not d['is_error']:
            bad = 0
            for l in out.split('\n')[1:]:
                mm = re.match(r'(.+?):(\d+): (.*)$', l)
                if not mm:
                    continue
                rel, ln, text = mm.group(1), int(mm.group(2)), mm.group(3)
                actual = files.get(rel, '').split('\n')
                if ln > len(actual) or (actual[ln - 1] if len(actual[ln - 1]) <= 200 else actual[ln - 1][:199] + '…') != text:
                    bad += 1
            if bad: problems.append((fn, 'search lines not in copy', inp, bad))
            else: stats['search lines all in copy'] += 1
        elif name == 'edit_file' and not d['is_error']:
            rel = inp['path']
            assert files[rel].count(inp['find']) == 1, (fn, inp)
            files[rel] = files[rel].replace(inp['find'], inp['replace'], 1)
            if rel == f['file']: fixed_file_edited = True

print('stats:', dict(stats))
print('problems:', len(problems))
for p in problems: print('  ', p)
print('never-strings checked:', len(never), sorted(never.values()))
print('hits:', len(leak_hits))
for h in leak_hits: print('  ', h)
