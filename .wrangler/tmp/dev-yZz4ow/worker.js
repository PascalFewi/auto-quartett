var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/types.ts
function newGame() {
  return {
    phase: "lobby",
    mode: "supertrumpf",
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
    winners: []
  };
}
__name(newGame, "newGame");

// src/room.ts
var Room = class {
  static {
    __name(this, "Room");
  }
  ctx;
  env;
  game;
  deck = null;
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.game = await ctx.storage.get("game") ?? newGame();
      this.deck = await ctx.storage.get("deck") ?? null;
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        phase: this.game.phase,
        playerCount: this.game.players.length
      });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("Not found", { status: 404 });
  }
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    try {
      await this.handle(ws, msg);
    } catch (err) {
      this.send(ws, { type: "error", message: err?.message ?? "Unbekannter Fehler" });
    }
  }
  async webSocketClose(ws) {
    const att = this.attachment(ws);
    if (!att) return;
    const stillConnected = this.ctx.getWebSockets().some((other) => other !== ws && this.attachment(other)?.playerId === att.playerId);
    const player = this.game.players.find((p) => p.id === att.playerId);
    if (player && !stillConnected) {
      player.connected = false;
      await this.persistAndBroadcast();
    }
  }
  // ---------------------------------------------------------------- Routing
  async handle(ws, msg) {
    if (msg.type === "hello") return this.onHello(ws, msg);
    const att = this.attachment(ws);
    if (!att) throw new Error("Bitte zuerst beitreten.");
    const playerId = att.playerId;
    switch (msg.type) {
      case "settings":
        return this.onSettings(playerId, msg);
      case "start":
        return this.onStart(playerId);
      case "pickAttribute":
        return this.onPickAttribute(playerId, msg);
      case "askCard":
        return this.onAskCard(playerId, msg);
      case "restart":
        return this.onRestart(playerId);
      case "leave":
        return this.onLeave(ws, playerId);
      default:
        throw new Error(`Unbekannter Nachrichtentyp: ${msg.type}`);
    }
  }
  // ----------------------------------------------------------- Lobby-Logik
  async onHello(ws, msg) {
    const name = String(msg.name ?? "").trim().slice(0, 20) || "Anonym";
    const requestedId = typeof msg.playerId === "string" ? msg.playerId.slice(0, 64) : null;
    const existing = requestedId ? this.game.players.find((p) => p.id === requestedId) : void 0;
    if (existing) {
      existing.connected = true;
      existing.name = name;
      ws.serializeAttachment({ playerId: existing.id });
    } else {
      if (this.game.phase !== "lobby") {
        this.send(ws, { type: "error", message: "Das Spiel l\xE4uft bereits.", fatal: true });
        ws.close(4e3, "Spiel l\xE4uft bereits");
        return;
      }
      if (this.game.players.length >= 8) {
        this.send(ws, { type: "error", message: "Der Raum ist voll (max. 8).", fatal: true });
        ws.close(4001, "Raum voll");
        return;
      }
      const player = {
        id: requestedId ?? crypto.randomUUID(),
        name,
        connected: true
      };
      this.game.players.push(player);
      if (!this.game.adminId) this.game.adminId = player.id;
      this.log(`${player.name} ist dem Raum beigetreten.`);
      ws.serializeAttachment({ playerId: player.id });
    }
    await this.persistAndBroadcast();
  }
  async onLeave(ws, playerId) {
    if (this.game.phase !== "lobby") throw new Error("W\xE4hrend des Spiels kannst du nicht austreten.");
    const player = this.game.players.find((p) => p.id === playerId);
    this.game.players = this.game.players.filter((p) => p.id !== playerId);
    if (this.game.adminId === playerId) {
      this.game.adminId = this.game.players[0]?.id ?? null;
    }
    if (player) this.log(`${player.name} hat den Raum verlassen.`);
    ws.close(1e3, "Raum verlassen");
    await this.persistAndBroadcast();
  }
  async onSettings(playerId, msg) {
    this.requireAdmin(playerId);
    this.requirePhase("lobby");
    if (msg.mode !== "supertrumpf" && msg.mode !== "quartett") {
      throw new Error("Ung\xFCltiger Spielmodus.");
    }
    this.game.mode = msg.mode;
    this.game.deckId = typeof msg.deckId === "string" ? msg.deckId.replace(/[^a-z0-9-_]/gi, "") : null;
    await this.persistAndBroadcast();
  }
  async onStart(playerId) {
    this.requireAdmin(playerId);
    this.requirePhase("lobby");
    this.game.players = this.game.players.filter((p) => p.connected);
    if (this.game.adminId && !this.game.players.some((p) => p.id === this.game.adminId)) {
      this.game.adminId = this.game.players[0]?.id ?? null;
    }
    if (this.game.players.length < 2) throw new Error("Mindestens 2 Spieler n\xF6tig.");
    if (!this.game.deckId) throw new Error("Bitte zuerst ein Deck w\xE4hlen.");
    this.deck = await this.loadDeck(this.game.deckId);
    this.validateDeck(this.deck, this.game.mode);
    await this.ctx.storage.put("deck", this.deck);
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
    this.game.phase = "playing";
    this.game.turnId = this.game.players[Math.floor(Math.random() * this.game.players.length)].id;
    this.log(`Spiel gestartet: ${this.deck.name} (${this.game.mode === "supertrumpf" ? "Supertrumpf" : "Klassisches Quartett"}).`);
    if (this.game.mode === "quartett") {
      for (const p of this.game.players) this.collectQuartets(p.id);
      this.checkQuartettEnd();
    }
    await this.persistAndBroadcast();
  }
  async onRestart(playerId) {
    this.requireAdmin(playerId);
    const { players, adminId, deckId, mode } = this.game;
    this.game = { ...newGame(), players, adminId, deckId, mode };
    this.log("Zur\xFCck in der Lobby.");
    await this.persistAndBroadcast();
  }
  // ------------------------------------------------------ Supertrumpf-Logik
  async onPickAttribute(playerId, msg) {
    this.requirePhase("playing");
    if (this.game.mode !== "supertrumpf") throw new Error("Falscher Spielmodus.");
    if (this.game.turnId !== playerId) throw new Error("Du bist nicht am Zug.");
    const deck = this.requireDeck();
    const attr = deck.attributes.find((a) => a.key === msg.key);
    if (!attr) throw new Error("Unbekanntes Attribut.");
    const alive = this.game.players.filter((p) => (this.game.hands[p.id]?.length ?? 0) > 0);
    const entries = alive.map((p) => {
      const cardId = this.game.hands[p.id][0];
      const card = this.cardById(cardId);
      return { playerId: p.id, cardId, value: card.values[attr.key] ?? 0 };
    });
    const best = attr.higherWins ? Math.max(...entries.map((e) => e.value)) : Math.min(...entries.map((e) => e.value));
    const topEntries = entries.filter((e) => e.value === best);
    for (const e of entries) this.game.hands[e.playerId].shift();
    const spoils = entries.map((e) => e.cardId);
    const lastRound = {
      attribute: attr.key,
      entries,
      winnerId: null,
      potTaken: 0
    };
    if (topEntries.length === 1) {
      const winnerId = topEntries[0].playerId;
      lastRound.winnerId = winnerId;
      lastRound.potTaken = this.game.pot.length;
      this.game.hands[winnerId].push(...spoils, ...this.game.pot);
      this.game.pot = [];
      this.game.turnId = winnerId;
      this.log(`${this.playerName(winnerId)} gewinnt die Runde mit ${attr.label}.`);
    } else {
      this.game.pot.push(...spoils);
      this.log(`Unentschieden bei ${attr.label} \u2013 ${spoils.length} Karten wandern in den Pot.`);
      if ((this.game.hands[playerId]?.length ?? 0) === 0) {
        this.game.turnId = this.nextWithCards(playerId);
      }
    }
    for (const e of entries) {
      if (this.game.hands[e.playerId].length === 0 && e.playerId !== lastRound.winnerId) {
        this.log(`${this.playerName(e.playerId)} hat keine Karten mehr.`);
      }
    }
    this.game.lastRound = lastRound;
    const withCards = this.game.players.filter((p) => this.game.hands[p.id].length > 0);
    if (withCards.length === 1) {
      this.game.phase = "finished";
      this.game.winners = [withCards[0].id];
      this.log(`${this.playerName(withCards[0].id)} gewinnt das Spiel!`);
    } else if (withCards.length === 0) {
      this.game.phase = "finished";
      this.game.winners = topEntries.map((e) => e.playerId);
      this.log("Unentschieden \u2013 alle Karten sind im Pot gelandet.");
    }
    await this.persistAndBroadcast();
  }
  // --------------------------------------------------- Klassisches Quartett
  async onAskCard(playerId, msg) {
    this.requirePhase("playing");
    if (this.game.mode !== "quartett") throw new Error("Falscher Spielmodus.");
    if (this.game.turnId !== playerId) throw new Error("Du bist nicht am Zug.");
    const targetId = String(msg.targetId ?? "");
    const cardId = String(msg.cardId ?? "");
    if (targetId === playerId) throw new Error("Du kannst dich nicht selbst fragen.");
    const target = this.game.players.find((p) => p.id === targetId);
    if (!target) throw new Error("Unbekannter Spieler.");
    if ((this.game.hands[targetId]?.length ?? 0) === 0) {
      throw new Error(`${target.name} hat keine Karten mehr.`);
    }
    const card = this.cardById(cardId);
    const myHand = this.game.hands[playerId];
    if (myHand.includes(cardId)) throw new Error("Diese Karte hast du selbst.");
    const holdsFamily = myHand.some((id) => this.cardById(id).family === card.family);
    if (!holdsFamily) throw new Error("Du musst selbst eine Karte dieser Familie besitzen.");
    const targetHas = this.game.hands[targetId].includes(cardId);
    this.game.lastAsk = { askerId: playerId, targetId, cardId, success: targetHas };
    if (targetHas) {
      this.game.hands[targetId] = this.game.hands[targetId].filter((id) => id !== cardId);
      myHand.push(cardId);
      this.log(`${this.playerName(playerId)} bekommt \u201E${card.name}\u201C von ${this.playerName(targetId)}.`);
      if (this.game.hands[targetId].length === 0) {
        this.log(`${this.playerName(targetId)} hat keine Karten mehr.`);
      }
      this.collectQuartets(playerId);
      if (this.game.hands[playerId].length === 0) {
        this.game.turnId = this.nextWithCards(playerId);
      }
    } else {
      this.log(`${this.playerName(targetId)} hat \u201E${card.name}\u201C nicht \u2013 ${this.playerName(targetId)} ist am Zug.`);
      this.game.turnId = targetId;
    }
    this.checkQuartettEnd();
    await this.persistAndBroadcast();
  }
  /** Vollständige Familien (4 Karten) aus der Hand nehmen und ablegen. */
  collectQuartets(playerId) {
    let found = true;
    while (found) {
      found = false;
      const hand = this.game.hands[playerId];
      const byFamily = /* @__PURE__ */ new Map();
      for (const id of hand) {
        const fam = this.cardById(id).family;
        byFamily.set(fam, [...byFamily.get(fam) ?? [], id]);
      }
      for (const [family, ids] of byFamily) {
        if (ids.length === 4) {
          this.game.hands[playerId] = hand.filter((id) => !ids.includes(id));
          this.game.quartets[playerId].push(family);
          this.log(`${this.playerName(playerId)} legt das Quartett \u201E${this.familyName(family)}\u201C ab.`);
          found = true;
          break;
        }
      }
    }
  }
  checkQuartettEnd() {
    const deck = this.requireDeck();
    const totalFamilies = new Set(deck.cards.map((c) => c.family)).size;
    const collected = Object.values(this.game.quartets).reduce((s, q) => s + q.length, 0);
    if (collected < totalFamilies) return;
    this.game.phase = "finished";
    const max = Math.max(...this.game.players.map((p) => this.game.quartets[p.id]?.length ?? 0));
    this.game.winners = this.game.players.filter((p) => (this.game.quartets[p.id]?.length ?? 0) === max).map((p) => p.id);
    const names = this.game.winners.map((id) => this.playerName(id)).join(" & ");
    this.log(`Alle Quartette abgelegt \u2013 ${names} gewinnt mit ${max} Quartett(en)!`);
  }
  // -------------------------------------------------------------- Broadcast
  /**
   * Jeder Spieler bekommt eine PERSONALISIERTE Sicht: die eigene Hand komplett,
   * von allen anderen nur die Kartenzahl. So kann niemand per DevTools die
   * Hände der Mitspieler auslesen.
   */
  view(playerId) {
    const g = this.game;
    const isSupertrumpf = g.mode === "supertrumpf";
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
        quartets: g.quartets[p.id] ?? []
      })),
      // Supertrumpf: nur die oberste Karte (wie im echten Spiel).
      // Quartett: die ganze Hand.
      yourHand: isSupertrumpf ? [] : g.hands[playerId] ?? [],
      yourTopCard: isSupertrumpf ? g.hands[playerId]?.[0] ?? null : null,
      yourCardCount: g.hands[playerId]?.length ?? 0,
      potCount: g.pot.length,
      lastRound: g.lastRound,
      lastAsk: g.lastAsk,
      log: g.log.slice(-40),
      winners: g.winners
    };
  }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att) continue;
      this.send(ws, { type: "state", state: this.view(att.playerId) });
    }
  }
  async persistAndBroadcast() {
    await this.ctx.storage.put("game", this.game);
    this.broadcast();
  }
  send(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
    }
  }
  // ---------------------------------------------------------------- Helpers
  attachment(ws) {
    return ws.deserializeAttachment() ?? null;
  }
  requireAdmin(playerId) {
    if (this.game.adminId !== playerId) throw new Error("Nur der Raum-Admin kann das.");
  }
  requirePhase(phase) {
    if (this.game.phase !== phase) throw new Error("In dieser Spielphase nicht m\xF6glich.");
  }
  requireDeck() {
    if (!this.deck) throw new Error("Kein Deck geladen.");
    return this.deck;
  }
  cardById(id) {
    const card = this.requireDeck().cards.find((c) => c.id === id);
    if (!card) throw new Error("Unbekannte Karte.");
    return card;
  }
  playerName(id) {
    return this.game.players.find((p) => p.id === id)?.name ?? "???";
  }
  familyName(family) {
    return this.deck?.families?.[family] ?? `Familie ${family}`;
  }
  /** Nächster Spieler (Sitzreihenfolge) mit mindestens einer Karte. */
  nextWithCards(fromId) {
    const order = this.game.players;
    const start = order.findIndex((p) => p.id === fromId);
    for (let i = 1; i <= order.length; i++) {
      const p = order[(start + i) % order.length];
      if ((this.game.hands[p.id]?.length ?? 0) > 0) return p.id;
    }
    return null;
  }
  /** Deck aus den statischen Assets laden (liegt im Repo unter frontend/public/decks). */
  async loadDeck(deckId) {
    const res = await this.env.ASSETS.fetch(`https://assets.local/decks/${deckId}/deck.json`);
    if (!res.ok) throw new Error(`Deck \u201E${deckId}\u201C nicht gefunden.`);
    return await res.json();
  }
  validateDeck(deck, mode) {
    if (!deck.cards?.length || !deck.attributes?.length) {
      throw new Error("Deck ist unvollst\xE4ndig (cards/attributes fehlen).");
    }
    const ids = new Set(deck.cards.map((c) => c.id));
    if (ids.size !== deck.cards.length) throw new Error("Deck enth\xE4lt doppelte Karten-IDs.");
    if (mode === "quartett") {
      const counts = /* @__PURE__ */ new Map();
      for (const c of deck.cards) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
      for (const [family, n] of counts) {
        if (n !== 4) {
          throw new Error(`Familie \u201E${family}\u201C hat ${n} statt 4 Karten \u2013 f\xFCr klassisches Quartett ungeeignet.`);
        }
      }
    }
  }
  log(message) {
    this.game.log.push(message);
    if (this.game.log.length > 200) this.game.log = this.game.log.slice(-100);
  }
};
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
__name(shuffle, "shuffle");

// src/worker.ts
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeRoomCode(length = 5) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}
__name(makeRoomCode, "makeRoomCode");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      return Response.json({ code: makeRoomCode() });
    }
    const statusMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,8})$/);
    if (statusMatch) {
      const code = statusMatch[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch("https://room/status");
    }
    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-8OZ8jC/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-8OZ8jC/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
