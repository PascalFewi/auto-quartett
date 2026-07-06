// Decks liegen als statische Dateien unter /decks/<id>/ – der Client lädt
// sie direkt. Die Kartenliste ist öffentliches Wissen (wie beim echten
// Quartett), geheim ist nur, WER welche Karte hält.

const deckCache = new Map();

export async function fetchDeckIndex() {
  const res = await fetch('/decks/index.json');
  if (!res.ok) throw new Error('Deck-Liste nicht gefunden.');
  return res.json();
}

export async function fetchDeck(deckId) {
  if (deckCache.has(deckId)) return deckCache.get(deckId);
  const res = await fetch(`/decks/${deckId}/deck.json`);
  if (!res.ok) throw new Error(`Deck „${deckId}“ nicht gefunden.`);
  const deck = await res.json();

  // Abgeleitete Nachschlage-Strukturen einmalig aufbauen:
  deck.cardById = Object.fromEntries(deck.cards.map((c) => [c.id, c]));
  // Eck-Index wie auf echten Quartettkarten: "A1", "A2", ... in Deck-Reihenfolge.
  const counters = {};
  deck.labelById = {};
  for (const c of deck.cards) {
    counters[c.family] = (counters[c.family] ?? 0) + 1;
    deck.labelById[c.id] = `${c.family}${counters[c.family]}`;
  }
  deck.familiesList = [...new Set(deck.cards.map((c) => c.family))];
  deck.familyName = (f) => deck.families?.[f] ?? `Familie ${f}`;
  deck.imageUrl = (card) => (card.image ? `/decks/${deckId}/${card.image}` : null);

  deckCache.set(deckId, deck);
  return deck;
}

/** Formatiert einen Attributwert inkl. Einheit, z.B. "478 PS". */
export function formatValue(attr, value) {
  const num = new Intl.NumberFormat('de-CH').format(value);
  return attr.unit ? `${num} ${attr.unit}` : num;
}
