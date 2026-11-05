"""Build data/homes.json (rooms, beds, NPC assignments) from the baked layout.

Run after any layout change: python3 tools/make_homes.py
Rooms come from data/village.json's doorways, beds are two open floor tiles per room
far from the door, and every villager in data/npcs.json gets one room and one bed.
"""
import json

village = json.load(open('data/village.json', encoding='utf-8'))
npcs = json.load(open('data/npcs.json', encoding='utf-8'))['npcs']
cols, rows = village['cols'], village['rows']
size = cols * rows


def expand(runs):
    out = []
    for value, count in runs:
        out.extend([value] * count)
    return (out + [0] * size)[:size]


manual = expand(village['manual'])

rooms = []
beds = []
for index, room in enumerate(village.get('rooms', [])):
    x, y, w, h = room['x'], room['y'], room['w'], room['h']
    door = room['door']
    rooms.append({'id': 'room_%d' % index, 'house': 'house_%d' % index, 'index': index,
                  'door': door, 'x': x, 'y': y, 'w': w, 'h': h})

    # a painted map box under a house is furniture indoors, so it is not a bed tile
    open_tiles = []
    for ty in range(y + 1, y + h - 1):
        for tx in range(x + 1, x + w - 1):
            if tx == door[0] and ty == door[1]:
                continue
            if manual[ty * cols + tx] in (1, 3, 4):
                continue
            open_tiles.append((tx, ty))
    cx, cy = x + w / 2, y + h / 2
    open_tiles.sort(key=lambda t: -((t[0] + 0.5 - cx) ** 2 + (t[1] + 0.5 - cy) ** 2))
    picks = []
    for tile in open_tiles:
        if all(abs(tile[0] - other[0]) + abs(tile[1] - other[1]) > 2 for other in picks):
            picks.append(tile)
        if len(picks) == 2:
            break
    for i, tile in enumerate(picks):
        beds.append({'id': 'bed_%d%s' % (index, 'ab'[i]), 'room': index,
                     'tile': [tile[0], tile[1]], 'stand': [tile[0] + 0.5, tile[1] + 0.5],
                     'facing': 1 if i == 0 else -1})

assignments = {}
for i, npc in enumerate(npcs):
    if not rooms:
        continue
    room = rooms[i % len(rooms)]
    options = [b for b in beds if b['room'] == room['index']]
    bed = options[(i // len(rooms)) % len(options)] if options else None
    assignments[npc['id']] = {'room': room['index'], 'bed': bed['id'] if bed else None}

out = {'v': 1, 'rooms': rooms, 'beds': beds, 'assignments': assignments}
json.dump(out, open('data/homes.json', 'w', encoding='utf-8'), indent=2)
print('rooms:', len(rooms), 'beds:', len(beds), 'assignments:', len(assignments))
for bed in beds:
    print(' ', bed['id'], 'room', bed['room'], 'tile', bed['tile'])
