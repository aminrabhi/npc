// Keeping villagers off the village.
//
// The prompt already forbids it, and allam-2-7b still drifts back within a few turns:
// the profile it is given mentions the village, the conversation history mentions the
// village, and the subject drifts there on its own. A rule that only exists in the
// prompt is a request, not a guarantee, so the words themselves are checked after
// generation and a line that still talks about the village is sent back once.
//
// The list is deliberately about *village life* - places, people and local business -
// not about the world. A trip to a city market, a piece of music, money, family or the
// past is all still allowed; "the market" on its own is punished because in this
// village it is the same three stalls every day.

export const VILLAGE_TERMS = [
  'village',
  'villages',
  'villager',
  'villagers',
  'town',
  'towns',
  'townsfolk',
  'hamlet',
  'settlement',
  'neighbourhood',
  'neighborhood',
  'neighbour',
  'neighbours',
  'neighbor',
  'neighbors',
  'the square',
  'town square',
  'village square',
  'the well',
  'the mill',
  'the bakery',
  'the butcher',
  'the market',
  'marketplace',
  'the harvest',
  'the mayor',
  'the council',
  'gossip',
  'gossiping',
  'everyone here',
  'everyone round here',
  'everyone around here',
  'people here',
  'folk here',
  'round here',
  'around here',
  'local folk',
  'the locals',
  'this place',
  'our little',
];

function escapeTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATTERN = new RegExp(`\\b(?:${VILLAGE_TERMS.map(escapeTerm).join('|')})\\b`, 'i');

// Which village word gave the line away, or '' when the line is clean. Returning the
// term rather than a boolean is what lets the logs say why a line was rejected.
export function villageTerm(text) {
  const value = typeof text === 'string' ? text : '';
  const match = value.match(PATTERN);
  return match ? match[0].toLowerCase() : '';
}

export function talksAboutVillage(text) {
  return villageTerm(text) !== '';
}

// Drop only the sentences that strayed, so a good second sentence still gets spoken.
// A line that is village talk all the way through comes back empty and the caller
// retries; nothing here invents wording.
export function stripVillageTalk(text) {
  const value = typeof text === 'string' ? text : '';
  const parts = value.match(/[^.!?…]+[.!?…]*/g) || [];
  const kept = parts
    .filter((part) => part.trim() && !talksAboutVillage(part))
    .map((part) => part.trim())
    .join(' ');
  return kept.trim();
}
