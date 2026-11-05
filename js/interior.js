// Builds the picture of a hand-drawn room: the floor, wall and prop tiles you
// painted for a door, drawn over the map tiles the room occupies.
//
// Nothing here is generated. A room with no tiles painted is simply empty, and the
// room is only ever drawn while the editor's door view is on or a villager is in it.

import { drawTile } from './tiles.js';

// Bottom-to-top order. floor plus the two floor detail layers are the ground of the
// room, then the wall, then props, then the three furniture layers that sit on top
// so chairs, beds and shelves can be stacked without repainting what is underneath.
export const ROOM_LAYERS = [
  'floor', 'floor_02', 'floor_03', 'wall', 'props',
  'furniture_01', 'furniture_02', 'furniture_03',
];

export function buildRoomCanvas({ room, atlas, tileSize, atlasCols }) {
  const T = tileSize;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, room.w * T);
  canvas.height = Math.max(1, room.h * T);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  for (const name of ROOM_LAYERS) {
    const cells = room[name];
    if (!cells) continue;
    for (let y = 0; y < room.h; y++) {
      for (let x = 0; x < room.w; x++) {
        const value = cells[y * room.w + x];
        if (!value) continue;
        drawTile(ctx, atlas, value, x * T, y * T, T, atlasCols);
      }
    }
  }
  return canvas;
}
