import json, re
from PIL import Image

INT_MIN = -2147483648
TS = 'artifacts'
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'

def load_yy(path):
    raw = open(path, encoding='utf-8').read()
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    return json.loads(raw)

room = load_yy('assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/rooms/Room1/Room1.yy')

def decode(data, w, h, skip_min):
    out = []
    i = 0
    n = len(data)
    while i < n:
        v = data[i]
        if v == INT_MIN:
            if not skip_min:
                out.append(0)
            i += 1
        elif v < 0:
            run = -v
            if i + 1 < n:
                out.extend([data[i+1]] * run)
                i += 2
            else:
                out.extend([0] * run)
                i += 1
        else:
            out.append(v)
            i += 1
    return out

print("layer           WxH          want  raw  INTs  skip  match")
for layer in room['layers']:
    if layer['resourceType'] != 'GMRTileLayer':
        continue
    td = layer.get('tiles')
    if not td or 'TileCompressedData' not in td:
        print(f"{layer['name']:14s} NO TILE DATA")
        continue
    w, h = td['SerialiseWidth'], td['SerialiseHeight']
    data = td['TileCompressedData']
    want = w * h
    ns = data.count(INT_MIN)
    a = decode(data, w, h, False)
    b = decode(data, w, h, True)
    print(f"{layer['name']:14s} {w}x{h}={want:5d} {len(data):5d} {ns:5d} {len(b):5d}  "
          f"{'SKIP-OK' if len(b)==want else 'bad'} / {'noskip-OK' if len(a)==want else 'bad'}")
