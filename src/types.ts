// Gemeinsame Typen für Worker und Durable Object.

export type Mode = 'supertrumpf' | 'quartett';

export interface DeckAttribute {
  key: string;      // z.B. "ps"
  label: string;    // z.B. "Leistung"
  unit?: string;    // z.B. "PS"
  higherWins: boolean;
}

export interface Card {
  id: string;
  family: string;   // Familien-Buchstabe, z.B. "A" (im Quartett-Modus exakt 4 Karten pro Familie)
  name: string;
  image?: string;   // Pfad relativ zum Deck-Ordner, z.B. "img/a1.svg"
  values: Record<string, number>;
}

export interface Deck {
  name: string;
  families?: Record<string, string>; // optionale Anzeigenamen, z.B. { "A": "Italienische Legenden" }
  attributes: DeckAttribute[];
  cards: Card[];
}

export interface Player {
  id: string;       // stabile Client-ID (localStorage) -> ermöglicht Reconnect
  name: string;
  connected: boolean;
}

export interface LastRound {
  // Ergebnis der letzten Supertrumpf-Runde, für die Aufdeck-Anzeige im Client.
  attribute: string;
  entries: { playerId: string; cardId: string; value: number }[];
  winnerId: string | null; // null = Unentschieden, Karten wandern in den Pot
  potTaken: number;        // wie viele Pot-Karten der Gewinner zusätzlich bekam
}

export interface LastAsk {
  // Ergebnis der letzten Quartett-Frage, für die Anzeige im Client.
  askerId: string;
  targetId: string;
  cardId: string;
  success: boolean;
}

export interface Game {
  phase: 'lobby' | 'playing' | 'finished';
  mode: Mode;
  deckId: string | null;
  players: Player[];
  adminId: string | null;
  hands: Record<string, string[]>;    // playerId -> Karten-IDs (Index 0 = oberste Karte)
  pot: string[];                      // Supertrumpf: Karten aus unentschiedenen Runden
  turnId: string | null;
  quartets: Record<string, string[]>; // Quartett: playerId -> abgelegte Familien
  lastRound: LastRound | null;
  lastAsk: LastAsk | null;
  log: string[];
  winners: string[];
}

export function newGame(): Game {
  return {
    phase: 'lobby',
    mode: 'supertrumpf',
    deckId: null,
    players: [],
    adminId: null,
    hands: {},
    pot: [],
    turnId: null,
    quartets: {},
    lastRound: null,
    lastAsk: null,
    log: [],
    winners: [],
  };
}
