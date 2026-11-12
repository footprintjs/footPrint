"""Prints transcripts for reading: the model's text, every tool call; record-tool
answers (map/step/why/story) in full, a repeated identical answer as a reference;
other answers by their first line (run_order: its result block).

Usage: python3 -I show.py <batch dir> <transcript name> [...]
"""
import hashlib, json, os, sys

batch = sys.argv[1]
seen = {}
for name in sys.argv[2:]:
    print(f'\n######## {name}')
    for line in open(os.path.join(batch, 'transcripts', name)):
        d = json.loads(line)
        t = d['type']
        if t == 'start':
            print('TASK:', d['task'])
        elif t == 'response':
            u = d['usage']
            for b in d['content']:
                if b['type'] == 'text' and b['text'].strip():
                    print(f'  MODEL: {b["text"].strip()[:600]}')
                if b['type'] == 'thinking' and b.get('thinking'):
                    print(f'  THINK: {b["thinking"][:300]}')
            print(f'  [usage in {u["input_tokens"]} out {u["output_tokens"]}]')
        elif t == 'tool':
            c = d['content']
            inp = json.dumps(d['input'])
            if d['name'] == 'edit_file':
                print(f'  > edit_file {inp[:400]} -> {c[:100]}')
            elif d['name'] in ('map', 'step', 'why', 'story'):
                h = hashlib.sha1(c.encode()).hexdigest()[:8]
                if h in seen:
                    print(f'  > {d["name"]} {inp} -> SAME AS {seen[h]} ({len(c)} chars)')
                else:
                    seen[h] = f'{name}:{d["name"]}:{h}'
                    print(f'  > {d["name"]} {inp} [{h}, {len(c)} chars, err={d["is_error"]}]\n' + '\n'.join('      ' + l for l in c.split('\n')))
            elif d['name'] == 'run_order':
                body = c.split('printed on stdout')[0]
                print(f'  > run_order {inp} -> ' + ' '.join(body.split())[:300])
            elif d['name'] == 'done':
                print(f'  > done {inp[:500]}')
            else:
                first = c.split('\n')[0]
                print(f'  > {d["name"]} {inp[:150]} [{len(c)} chars, err={d["is_error"]}] {first[:160]}')
        elif t == 'score':
            print('SCORE solved', d['solved'], 'wrong', d['wrongFixtures'], 'edited', d['editedFiles'])
