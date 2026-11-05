"""Look for interior building blocks: a seamless flat floor tile in the atlas and
the pack's furniture sprites. Writes a contact sheet for visual selection."""
import os
from PIL import Image, ImageDraw

T = 16
COLS = 64
ATLAS = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Assets/Tileset/spr_tileset_sunnysideworld_16px.png'
SPRITES = 'assets_pack/Sunnyside_World_ASSET_PACK_V2.1/Sunnyside_World_Gamemaker/sprites'

atlas = Image.open(ATLAS).convert('RGBA')
rows = atlas.height // T


def stats(tile):
    px = list(tile.getdata())
    if any(p[3] < 250 for p in px):
        return None
    r = sum(p[0] for p in px) / len(px)
    g = sum(p[1] for p in px) / len(px)
    b = sum(p[2] for p in px) / len(px)
    var = sum((p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 for p in px) / len(px)
    # wrap continuity: does the left edge continue into the right edge?
    le = [px[y * T] for y in range(T)]
    re_ = [px[y * T + T - 1] for y in range(T)]
    te = [px[x] for x in range(T)]
    be = [px[(T - 1) * T + x] for x in range(T)]
    seam_lr = sum(abs(a[0] - c[0]) + abs(a[1] - c[1]) + abs(a[2] - c[2])
                  for a, c in zip(le, re_)) / T
    seam_tb = sum(abs(a[0] - c[0]) + abs(a[1] - c[1]) + abs(a[2] - c[2])
                  for a, c in zip(te, be)) / T
    return r, g, b, var, seam_lr, seam_tb


candidates = []
for i in range(COLS * rows):
    col, row = i % COLS, i // COLS
    tile = atlas.crop((col * T, row * T, col * T + T, row * T + T))
    s = stats(tile)
    if not s:
        continue
    r, g, b, var, lr, tb = s
    wood = r > 110 and r > b + 30 and g > b and g < r
    if not wood:
        continue
    if var > 2200 or lr > 26 or tb > 26:
        continue
    candidates.append((var + lr * 12 + tb * 12, i, (int(r), int(g), int(b)), var, lr, tb))

candidates.sort()
print(f'{len(candidates)} wood-like flat seamless tiles')
for c in candidates[:10]:
    print(f'  #{c[1]:4d} rgb={c[2]} var={c[3]:.0f} seamLR={c[4]:.1f} seamTB={c[5]:.1f}')

picked = [c[1] for c in candidates[:8]]

furniture = ['spr_deco_chair_01', 'spr_deco_rug_01', 'spr_deco_sidetable_01',
             'spr_deco_chest_01_closed', 'spr_deco_chest_02_closed',
             'spr_deco_sword_floor']

items = []
for name in furniture:
    path = os.path.join(SPRITES, name, '*.png')
    import glob
    hit = glob.glob(path)
    if not hit:
        print('missing sprite', name)
        continue
    img = Image.open(hit[0]).convert('RGBA')
    items.append((name, hit[0], img))
    print(f'{name}: {img.size}')

# --- contact sheet: floor candidates as 4x4 repeats, then furniture
SCALE = 3
cell = T * 4 * SCALE
cols = 4
rows_sheet = (len(picked) + cols - 1) // cols
furn_h = max([im.height for _, _, im in items] + [16]) * 3 + 40
sheet = Image.new('RGBA', (cols * (cell + 12) + 12, rows_sheet * (cell + 34) + 12 + furn_h), (24, 20, 40, 255))
draw = ImageDraw.Draw(sheet)

for idx, tile_index in enumerate(picked):
    col, row = tile_index % COLS, tile_index // COLS
    tile = atlas.crop((col * T, row * T, col * T + T, row * T + T))
    block = Image.new('RGBA', (T * 4, T * 4))
    for y in range(4):
        for x in range(4):
            block.paste(tile, (x * T, y * T))
    block = block.resize((cell, cell), Image.NEAREST)
    x = 12 + (idx % cols) * (cell + 12)
    y = 12 + (idx // cols) * (cell + 34)
    sheet.paste(block, (x, y))
    draw.text((x + 3, y + cell + 6), f'#{tile_index}', fill=(255, 235, 170, 255))

y0 = 12 + rows_sheet * (cell + 34) + 6
x = 12
for name, _path, img in items:
    scaled = img.resize((img.width * 3, img.height * 3), Image.NEAREST)
    if x + scaled.width > sheet.width:
        x = 12
        y0 += furn_h
    sheet.paste(scaled, (x, y0), scaled)
    draw.text((x, y0 + scaled.height + 4), name.replace('spr_deco_', ''), fill=(160, 220, 255, 255))
    x += max(scaled.width, 90) + 16

os.makedirs('artifacts', exist_ok=True)
sheet.convert('RGB').save('artifacts/interior_assets.png')
print('wrote artifacts/interior_assets.png', sheet.size)
