// The one character the player has made in the studio.
//
// The baked roster still lives in data/npcs.json. This store is only for the
// character the player created or chose, so a refresh does not lose their look,
// personality or spawn tile before the exported code is baked in.

const STORAGE_KEY = 'aivillage.player.v1';

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPlayerCharacter() {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.character || !parsed.character.id) return null;
    return {
      playerId: parsed.playerId || null,
      character: parsed.character,
    };
  } catch {
    return null;
  }
}

// `playing` false keeps the character in the village as an ordinary villager while
// clearing the flag that gives the keyboard to it.
export function savePlayerCharacter(entry, playing) {
  const storage = safeStorage();
  if (!storage || !entry || !entry.id) return false;
  try {
    const character = JSON.parse(JSON.stringify(entry));
    character.player = true;
    storage.setItem(STORAGE_KEY, JSON.stringify({
      v: 1,
      playerId: playing ? entry.id : null,
      character,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearPlayerCharacter() {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
