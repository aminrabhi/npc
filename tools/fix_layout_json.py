"""Rebuild a layout JSON whose braces got mangled in transit.

Reads the raw text, pulls each top-level array out by bracket matching, and writes a
clean document back. Verifies every layer expands to exactly cols*rows tiles.
"""
import json
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'artifacts/user_layout.json'
s = open(PATH, encoding='utf-8').read()


def grab(key):
    i = s.index(f'"{key}":') + len(key) + 3
    while s[i] in ' \n\r\t':
        i += 1
    start = i
    depth = 0
    while True:
        c = s[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
            if depth == 0:
                i += 1
                break
        i += 1
    return json.loads(s[start:i])


def expand(runs):
    out = []
    for v, c in runs:
        out += [v] * c
    return out


names = ['land', 'paths', 'shadows', 'decoration_01', 'building', 'walls',
         'decoration_02', 'decoration_03']
cols, rows = 47, 28
size = cols * rows
layers = {}
for name in names:
    runs = grab(name)
    grid = expand(runs)
    print(f'{name}: {len(grid)} tiles, {sorted(set(grid))}')
    assert len(grid) == size, f'{name} has {len(grid)} tiles, expected {size}'
    layers[name] = runs

blocked = grab('blocked')
manual = grab('manual')
assert len(expand(blocked)) == size, 'blocked is the wrong length'
assert len(expand(manual)) == size, 'manual is the wrong length'

out = {
    'v': 1, 'tileSize': 16, 'cols': cols, 'rows': rows, 'atlasCols': 64,
    'layers': layers,
    'blocked': blocked,
    'manual': manual,
    'rooms': [],
}
with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(out, f, separators=(',', ':'))
print('rewrote', PATH)
