"""List every tool call of one agent transcript and say whether it stayed inside one folder.

Why: the twin of the benchmark must be written blind. The builder was told to work only inside its
folder; this reads its transcript (JSONL) and prints every tool call whose input names a path or runs
a command, marking the ones that reach outside. Usage: python3 -I paths-touched.py <transcript> <folder>
"""
import json, re, sys
transcript, folder = sys.argv[1], sys.argv[2].rstrip('/')
calls = []
for line in open(transcript, encoding='utf-8'):
    try: row = json.loads(line)
    except Exception: continue
    msg = row.get('message') or {}
    if row.get('type') != 'assistant' or not isinstance(msg.get('content'), list): continue
    for part in msg['content']:
        if part.get('type') == 'tool_use': calls.append((part.get('name'), part.get('input') or {}))
outside = 0
by_tool = {}
for name, inp in calls:
    by_tool[name] = by_tool.get(name, 0) + 1
    text = json.dumps(inp)
    ok = True
    why = ''
    if name == 'Bash':
        cmd = inp.get('command', '')
        # every command must begin by entering the folder, and name no other absolute path
        if not cmd.lstrip().startswith('cd ' + folder) and not cmd.lstrip().startswith('cd "' + folder): ok, why = False, 'does not start with cd into the folder'
        for p in re.findall(r'(?<![\w.-])/(?:Users|private|tmp|var|etc|opt|home)[^\s"\';|&)]*', cmd):
            if not p.startswith(folder): ok, why = False, 'names ' + p
        if re.search(r'\.\./|\bcurl\b|\bwget\b|\bgit\s+clone\b|\bnpm\s+(i|install|ci)\b|\bgh\s', cmd): ok, why = False, 'leaves the folder or uses the network'
    else:
        for key in ('file_path', 'path', 'notebook_path'):
            v = inp.get(key)
            if isinstance(v, str) and not v.startswith(folder): ok, why = False, key + ' = ' + v
        if name in ('WebFetch', 'WebSearch', 'Agent', 'Skill', 'ToolSearch'): ok, why = False, 'tool ' + name
        if name in ('Grep', 'Glob') and not isinstance(inp.get('path'), str): ok, why = False, 'search with no path (searches the working directory)'
    if not ok:
        outside += 1
        print('OUTSIDE', name, '|', why, '|', text[:300])
print('tool calls:', len(calls), by_tool)
print('calls reaching outside the folder:', outside)
