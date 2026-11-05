import json, re, sys

def load_yy(path):
    raw = open(path, encoding='utf-8').read()
    # GameMaker .yy is JSON with trailing commas
    raw = re.sub(r',(\s*[}\]])', r'\1', raw)
    return json.loads(raw)

ts = load_yy('assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/tilesets/tileset_sunnysideworld/tileset_sunnysideworld.yy')
print("tileWidth", ts['tileWidth'], "tileHeight", ts['tileHeight'], "columns", ts['out_columns'])
print("num autoTileSets:", len(ts['autoTileSets']))
print()
for group in ts['autoTileSets']:
    tiles = group['tiles']
    print(f"{group['name']!r:38s} n={len(tiles):4d}  tiles={tiles}")
