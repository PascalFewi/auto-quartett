import type { Env } from './worker';
import { newGame } from './types';
import type { Card, Deck, Game, LastRound, Mode, Player } from './types';

// Nachrichtenformat Client -> Server (alles JSON über den WebSocket):
//   { type: "hello", playerId?, name }            beitreten / reconnecten
//   { type: "settings", deckId, mode }            nur Admin, nur Lobby
//   { type: "start" }                             nur Admin, nur Lobby
//   { type: "pickAttribute", key }                Supertrumpf, nur wer am Zug ist
//   { type: "askCard", targetId, cardId }         Quartett, nur wer am Zug ist
//   { type: "restart" }                           nur Admin -> zurück in die Lobby
//   { type: "leave" }                             Lobby verlassen
//
// Server -> Client:
//   { type: "state", state }                      personalisierter Spielzustand
//   { type: "error", message }                    Validierungsfehler

interface Attachment {
  playerId: string;
}

export class Room {
  private ctx: DurableObjectState;
  private env: Env;
  private game!: Game;
  private deck: Deck | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // Zustand aus dem Storage laden, bevor Nachrichten verarbeitet werden.
    // Nötig, weil das Object nach Hibernation/Neustart frisch konstruiert wird.
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get<Game>('game')) ?? newGame();
      this.deck = (await ctx.storage.get<Deck>('deck')) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return Response.json({
        phase: this.game.phase,
        playerCount: this.game.players.length,
      });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      // Hibernation-API: Der Socket bleibt offen, auch wenn das Object
      // zwischendurch aus dem Speicher fällt -> spart Free-Tier-Kontingent.
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    try {
      await this.handle(ws, msg);
    } catch (err: any) {
      this.send(ws, { type: 'error', message: err?.message ?? 'Unbekannter Fehler' });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = this.attachment(ws);
    if (!att) return;
    // Erst als getrennt markieren, wenn KEIN anderer Socket desselben
    // Spielers mehr offen ist (z.B. zwei Tabs).
    const stillConnected = this.ctx
      .getWebSockets()
      .some((other) => other !== ws && this.attachment(other)?.playerId === att.playerId);
    const player = this.game.players.find((p) => p.id === att.playerId);
    if (player && !stillConnected) {
      player.connected = false;
      await this.persistAndBroadcast();
    }
  }

  // ---------------------------------------------------------------- Routing

  private async handle(ws: WebSocket, msg: any): Promise<void> {
    if (msg.type === 'hello') return this.onHello(ws, msg);

    const att = this.attachment(ws);
    if (!att) throw new Error('Bitte zuerst beitreten.');
    const playerId = att.playerId;

    switch (msg.type) {
      case 'settings':
        return this.onSettings(playerId, msg);
      case 'start':
        return this.onStart(playerId);
      case 'pickAttribute':
        return this.onPickAttribute(playerId, msg);
      case 'askCard':
        return this.onAskCard(playerId, msg);
      case 'restart':
        return this.onRestart(playerId);
      case 'leave':
        return this.onLeave(ws, playerId);
      default:
        throw new Error(`Unbekannter Nachrichtentyp: ${msg.type}`);
    }
  }

  // ----------------------------------------------------------- Lobby-Logik

  private async onHello(ws: WebSocket, msg: any): Promise<void> {
    const name = String(msg.name ?? '').trim().slice(0, 20) || 'Anonym';
    const requestedId = typeof msg.playerId === 'string' ? msg.playerId.slice(0, 64) : null;

    const existing = requestedId
      ? this.game.players.find((p) => p.id === requestedId)
      : undefined;

    if (existing) {
      // Reconnect: gleicher Spieler, neue Verbindung.
      existing.connected = true;
      existing.name = name;
      ws.serializeAttachment({ playerId: existing.id } satisfies Attachment);
    } else {
      if (this.game.phase !== 'lobby') {
        this.send(ws, { type: 'error', message: 'Das Spiel läuft bereits.', fatal: true });
        ws.close(4000, 'Spiel läuft bereits');
        return;
      }
      if (this.game.players.length >= 8) {
        this.send(ws, { type: 'error', message: 'Der Raum ist voll (max. 8).', fatal: true });
        ws.close(4001, 'Raum voll');
        return;
      }
      const player: Player = {
        id: requestedId ?? crypto.randomUUID(),
        name,
        connected: true,
      };
      this.game.players.push(player);
      if (!this.game.adminId) this.game.adminId = player.id;
      this.log(`${player.name} ist dem Raum beigetreten.`);
      ws.serializeAttachment({ playerId: player.id } satisfies Attachment);
    }

    await this.persistAndBroadcast();
  }

  private async onLeave(ws: WebSocket, playerId: string): Promise<void> {
    if (this.game.phase !== 'lobby') throw new Error('Während des Spiels kannst du nicht austreten.');
    const player = this.game.players.find((p) => p.id === playerId);
    this.game.players = this.game.players.filter((p) => p.id !== playerId);
    if (this.game.adminId === playerId) {
      this.game.adminId = this.game.players[0]?.id ?? null;
    }
    if (player) this.log(`${player.name} hat den Raum verlassen.`);
    ws.close(1000, 'Raum verlassen');
    await this.persistAndBroadcast();
  }

  private async onSettings(playerId: string, msg: any): Promise<void> {
    this.requireAdmin(playerId);
    this.requirePhase('lobby');
    if (msg.mode !== 'supertrumpf' && msg.mode !== 'quartett') {
      throw new Error('Ungültiger Spielmodus.');
    }
    this.game.mode = msg.mode as Mode;
    this.game.deckId = typeof msg.deckId === 'string' ? msg.deckId.replace(/[^a-z0-9-_]/gi, '') : null;
    await this.persistAndBroadcast();
  }

  private async onStart(playerId: string): Promise<void> {
    this.requireAdmin(playerId);
    this.requirePhase('lobby');

    // Getrennte Lobby-Spieler fliegen beim Start raus, damit keine "Geister" mitspielen.
    this.game.players = this.game.players.filter((p) => p.connected);
    if (this.game.adminId && !this.game.players.some((p) => p.id === this.game.adminId)) {
      this.game.adminId = this.game.players[0]?.id ?? null;
    }
    if (this.game.players.length < 2) throw new Error('Mindestens 2 Spieler nötig.');
    if (!this.game.deckId) throw new Error('Bitte zuerst ein Deck wählen.');

    this.deck = await this.loadDeck(this.game.deckId);
    this.validateDeck(this.deck, this.game.mode);
    await this.ctx.storage.put('deck', this.deck);

    // Karten mischen und reihum austeilen.
    const shuffled = shuffle(this.deck.cards.map((c) => c.id));
    this.game.hands = {};
    this.game.quartets = {};
    for (const p of this.game.players) {
      this.game.hands[p.id] = [];
      this.game.quartets[p.id] = [];
    }
    shuffled.forEach((cardId, i) => {
      const p = this.game.players[i % this.game.players.length];
      this.game.hands[p.id].push(cardId);
    });

    this.game.pot = [];
    this.game.lastRound = null;
    this.game.lastAsk = null;
    this.game.winners = [];
    this.game.phase = 'playing';
    this.game.turnId = this.game.players[Math.floor(Math.random() * this.game.players.length)].id;
    this.log(`Spiel gestartet: ${this.deck.name} (${this.game.mode === 'supertrumpf' ? 'Supertrumpf' : 'Klassisches Quartett'}).`);

    if (this.game.mode === 'quartett') {
      // Falls jemand direkt beim Austeilen ein komplettes Quartett bekommt.
      for (const p of this.game.players) this.collectQuartets(p.id);
      this.checkQuartettEnd();
    }

    await this.persistAndBroadcast();
  }

  private async onRestart(playerId: string): Promise<void> {
    this.requireAdmin(playerId);
    // Zurück in die Lobby, Spieler und Einstellungen bleiben erhalten.
    const { players, adminId, deckId, mode } = this.game;
    this.game = { ...newGame(), players, adminId, deckId, mode };
    this.log('Zurück in der Lobby.');
    await this.persistAndBroadcast();
  }

  // ------------------------------------------------------ Supertrumpf-Logik

  private async onPickAttribute(playerId: string, msg: any): Promise<void> {
    this.requirePhase('playing');
    if (this.game.mode !== 'supertrumpf') throw new Error('Falscher Spielmodus.');
    if (this.game.turnId !== playerId) throw new Error('Du bist nicht am Zug.');
    const deck = this.requireDeck();
    const attr = deck.attributes.find((a) => a.key === msg.key);
    if (!attr) throw new Error('Unbekanntes Attribut.');

    // Oberste Karte jedes Spielers, der noch Karten hat, wird verglichen.
    const alive = this.game.players.filter((p) => (this.game.hands[p.id]?.length ?? 0) > 0);
    const entries = alive.map((p) => {
      const cardId = this.game.hands[p.id][0];
      const card = this.cardById(cardId);
      return { playerId: p.id, cardId, value: card.values[attr.key] ?? 0 };
    });

    const best = attr.higherWins
      ? Math.max(...entries.map((e) => e.value))
      : Math.min(...entries.map((e) => e.value));
    const topEntries = entries.filter((e) => e.value === best);

    // Oberste Karten von allen Stapeln nehmen.
    for (const e of entries) this.game.hands[e.playerId].shift();
    const spoils = entries.map((e) => e.cardId);

    const lastRound: LastRound = {
      attribute: attr.key,
      entries,
      winnerId: null,
      potTaken: 0,
    };

    if (topEntries.length === 1) {
      // Eindeutiger Sieger: bekommt alle aufgedeckten Karten + Pot unter seinen Stapel.
      const winnerId = topEntries[0].playerId;
      lastRound.winnerId = winnerId;
      lastRound.potTaken = this.game.pot.length;
      this.game.hands[winnerId].push(...spoils, ...this.game.pot);
      this.game.pot = [];
      this.game.turnId = winnerId;
      this.log(`${this.playerName(winnerId)} gewinnt die Runde mit ${attr.label}.`);
    } else {
      // Unentschieden: Karten in den Pot, derselbe Spieler wählt erneut.
      this.game.pot.push(...spoils);
      this.log(`Unentschieden bei ${attr.label} – ${spoils.length} Karten wandern in den Pot.`);
      if ((this.game.hands[playerId]?.length ?? 0) === 0) {
        // Der aktive Spieler hat durch das Unentschieden seine letzte Karte verloren.
        this.game.turnId = this.nextWithCards(playerId);
      }
    }

    // Ausgeschiedene Spieler melden.
    for (const e of entries) {
      if (this.game.hands[e.playerId].length === 0 && e.playerId !== lastRound.winnerId) {
        this.log(`${this.playerName(e.playerId)} hat keine Karten mehr.`);
      }
    }

    this.game.lastRound = lastRound;

    // Spielende prüfen.
    const withCards = this.game.players.filter((p) => this.game.hands[p.id].length > 0);
    if (withCards.length === 1) {
      this.game.phase = 'finished';
      this.game.winners = [withCards[0].id];
      this.log(`${this.playerName(withCards[0].id)} gewinnt das Spiel!`);
    } else if (withCards.length === 0) {
      // Extremfall: alle restlichen Karten sind im Pot gelandet -> Unentschieden
      // zwischen den zuletzt Beteiligten.
      this.game.phase = 'finished';
      this.game.winners = topEntries.map((e) => e.playerId);
      this.log('Unentschieden – alle Karten sind im Pot gelandet.');
    }

    await this.persistAndBroadcast();
  }

  // --------------------------------------------------- Klassisches Quartett

  private async onAskCard(playerId: string, msg: any): Promise<void> {
    this.requirePhase('playing');
    if (this.game.mode !== 'quartett') throw new Error('Falscher Spielmodus.');
    if (this.game.turnId !== playerId) throw new Error('Du bist nicht am Zug.');

    const targetId = String(msg.targetId ?? '');
    const cardId = String(msg.cardId ?? '');
    if (targetId === playerId) throw new Error('Du kannst dich nicht selbst fragen.');
    const target = this.game.players.find((p) => p.id === targetId);
    if (!target) throw new Error('Unbekannter Spieler.');
    if ((this.game.hands[targetId]?.length ?? 0) === 0) {
      throw new Error(`${target.name} hat keine Karten mehr.`);
    }

    const card = this.cardById(cardId);
    const myHand = this.game.hands[playerId];
    if (myHand.includes(cardId)) throw new Error('Diese Karte hast du selbst.');
    const holdsFamily = myHand.some((id) => this.cardById(id).family === card.family);
    if (!holdsFamily) throw new Error('Du musst selbst eine Karte dieser Familie besitzen.');

    const targetHas = this.game.hands[targetId].includes(cardId);
    this.game.lastAsk = { askerId: playerId, targetId, cardId, success: targetHas };

    if (targetHas) {
      // Karte wechselt den Besitzer, der Frager darf weiterfragen.
      this.game.hands[targetId] = this.game.hands[targetId].filter((id) => id !== cardId);
      myHand.push(cardId);
      this.log(`${this.playerName(playerId)} bekommt „${card.name}“ von ${this.playerName(targetId)}.`);
      if (this.game.hands[targetId].length === 0) {
        this.log(`${this.playerName(targetId)} hat keine Karten mehr.`);
      }
      this.collectQuartets(playerId);
      // Hat der Frager durch abgelegte Quartette keine Karten mehr, geht der Zug weiter.
      if (this.game.hands[playerId].length === 0) {
        this.game.turnId = this.nextWithCards(playerId);
      }
    } else {
      this.log(`${this.playerName(targetId)} hat „${card.name}“ nicht – ${this.playerName(targetId)} ist am Zug.`);
      this.game.turnId = targetId;
    }

    this.checkQuartettEnd();
    await this.persistAndBroadcast();
  }

  /** Vollständige Familien (4 Karten) aus der Hand nehmen und ablegen. */
  private collectQuartets(playerId: string): void {
    let found = true;
    while (found) {
      found = false;
      // WICHTIG: die Hand-Referenz in JEDER Iteration frisch lesen. Nach dem
      // Ablegen wird this.game.hands[playerId] durch ein neues (gefiltertes)
      // Array ersetzt – eine vor der Schleife gecachte Referenz würde weiter
      // die alten Karten sehen und dieselbe Familie endlos ablegen.
      const hand = this.game.hands[playerId];
      const byFamily = new Map<string, string[]>();
      for (const id of hand) {
        const fam = this.cardById(id).family;
        byFamily.set(fam, [...(byFamily.get(fam) ?? []), id]);
      }
      for (const [family, ids] of byFamily) {
        if (ids.length === 4) {
          this.game.hands[playerId] = hand.filter((id) => !ids.includes(id));
          this.game.quartets[playerId].push(family);
          this.log(`${this.playerName(playerId)} legt das Quartett „${this.familyName(family)}“ ab.`);
          found = true;
          break; // hand hat sich geändert -> neu gruppieren
        }
      }
    }
  }

  private checkQuartettEnd(): void {
    const deck = this.requireDeck();
    const totalFamilies = new Set(deck.cards.map((c) => c.family)).size;
    const collected = Object.values(this.game.quartets).reduce((s, q) => s + q.length, 0);
    if (collected < totalFamilies) return;

    this.game.phase = 'finished';
    const max = Math.max(...this.game.players.map((p) => this.game.quartets[p.id]?.length ?? 0));
    this.game.winners = this.game.players
      .filter((p) => (this.game.quartets[p.id]?.length ?? 0) === max)
      .map((p) => p.id);
    const names = this.game.winners.map((id) => this.playerName(id)).join(' & ');
    this.log(`Alle Quartette abgelegt – ${names} gewinnt mit ${max} Quartett(en)!`);
  }

  // -------------------------------------------------------------- Broadcast

  /**
   * Jeder Spieler bekommt eine PERSONALISIERTE Sicht: die eigene Hand komplett,
   * von allen anderen nur die Kartenzahl. So kann niemand per DevTools die
   * Hände der Mitspieler auslesen.
   */
  private view(playerId: string) {
    const g = this.game;
    const isSupertrumpf = g.mode === 'supertrumpf';
    return {
      you: playerId,
      phase: g.phase,
      mode: g.mode,
      deckId: g.deckId,
      adminId: g.adminId,
      turnId: g.turnId,
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        cardCount: g.hands[p.id]?.length ?? 0,
        quartets: g.quartets[p.id] ?? [],
      })),
      // Supertrumpf: nur die oberste Karte (wie im echten Spiel).
      // Quartett: die ganze Hand.
      yourHand: isSupertrumpf ? [] : (g.hands[playerId] ?? []),
      yourTopCard: isSupertrumpf ? (g.hands[playerId]?.[0] ?? null) : null,
      yourCardCount: g.hands[playerId]?.length ?? 0,
      potCount: g.pot.length,
      lastRound: g.lastRound,
      lastAsk: g.lastAsk,
      log: g.log.slice(-40),
      winners: g.winners,
    };
  }

  private broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att) continue;
      this.send(ws, { type: 'state', state: this.view(att.playerId) });
    }
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.ctx.storage.put('game', this.game);
    this.broadcast();
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Socket bereits geschlossen -> ignorieren.
    }
  }

  // ---------------------------------------------------------------- Helpers

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private requireAdmin(playerId: string): void {
    if (this.game.adminId !== playerId) throw new Error('Nur der Raum-Admin kann das.');
  }

  private requirePhase(phase: Game['phase']): void {
    if (this.game.phase !== phase) throw new Error('In dieser Spielphase nicht möglich.');
  }

  private requireDeck(): Deck {
    if (!this.deck) throw new Error('Kein Deck geladen.');
    return this.deck;
  }

  private cardById(id: string): Card {
    const card = this.requireDeck().cards.find((c) => c.id === id);
    if (!card) throw new Error('Unbekannte Karte.');
    return card;
  }

  private playerName(id: string): string {
    return this.game.players.find((p) => p.id === id)?.name ?? '???';
  }

  private familyName(family: string): string {
    return this.deck?.families?.[family] ?? `Familie ${family}`;
  }

  /** Nächster Spieler (Sitzreihenfolge) mit mindestens einer Karte. */
  private nextWithCards(fromId: string): string | null {
    const order = this.game.players;
    const start = order.findIndex((p) => p.id === fromId);
    for (let i = 1; i <= order.length; i++) {
      const p = order[(start + i) % order.length];
      if ((this.game.hands[p.id]?.length ?? 0) > 0) return p.id;
    }
    return null;
  }

  /** Deck aus den statischen Assets laden (liegt im Repo unter frontend/public/decks). */
  private async loadDeck(deckId: string): Promise<Deck> {
    const res = await this.env.ASSETS.fetch(`https://assets.local/decks/${deckId}/deck.json`);
    if (!res.ok) throw new Error(`Deck „${deckId}“ nicht gefunden.`);
    return (await res.json()) as Deck;
  }

  private validateDeck(deck: Deck, mode: Mode): void {
    if (!deck.cards?.length || !deck.attributes?.length) {
      throw new Error('Deck ist unvollständig (cards/attributes fehlen).');
    }
    const ids = new Set(deck.cards.map((c) => c.id));
    if (ids.size !== deck.cards.length) throw new Error('Deck enthält doppelte Karten-IDs.');
    if (mode === 'quartett') {
      const counts = new Map<string, number>();
      for (const c of deck.cards) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
      for (const [family, n] of counts) {
        if (n !== 4) {
          throw new Error(`Familie „${family}“ hat ${n} statt 4 Karten – für klassisches Quartett ungeeignet.`);
        }
      }
    }
  }

  private log(message: string): void {
    this.game.log.push(message);
    if (this.game.log.length > 200) this.game.log = this.game.log.slice(-100);
  }
}

function shuffle<T>(arr: T[]): T[] {
  // Fisher-Yates mit crypto-Zufall.
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
