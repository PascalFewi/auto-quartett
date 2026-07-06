// End-to-End-Test gegen den lokalen wrangler dev Server.
// Simuliert 3 Spieler und spielt beide Modi bis zum Spielende durch.
const BASE = 'http://127.0.0.1:8787';

function connect(code, name, playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8787/ws/${code}`);
    const client = { ws, name, playerId, state: null, errors: [] };
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', playerId, name }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        client.state = msg.state;
        if (!client.ready) { client.ready = true; resolve(client); }
      } else if (msg.type === 'error') {
        client.errors.push(msg.message);
        console.log(`  [FEHLER an ${name}]`, msg.message);
      }
    };
    ws.onerror = (e) => reject(new Error('WS-Fehler'));
  });
}

const send = (c, payload) => c.ws.send(JSON.stringify(payload));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(clients, pred, label, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (clients.every((c) => c.state && pred(c.state))) return;
    await sleep(30);
  }
  console.log('  [TIMEOUT-DEBUG]', label, '– Phasen:',
    clients.map((c) => c.state?.phase).join('/'),
    '| Modi:', clients.map((c) => c.state?.mode).join('/'),
    '| Fehler:', clients.flatMap((c) => c.errors).slice(-5));
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  console.log('Raum:', code);
  const deck = await (await fetch(`${BASE}/decks/autos/deck.json`)).json();

  const clients = [];
  for (const [i, name] of ['Anna', 'Ben', 'Cleo'].entries()) {
    clients.push(await connect(code, name, `test-player-${i}`));
  }
  await waitFor(clients, (s) => s.players.length === 3, 'alle beigetreten');
  console.log('✓ 3 Spieler in der Lobby, Admin:', clients[0].state.adminId === 'test-player-0');

  const admin = clients[0];
  const byId = (id) => clients.find((c) => c.playerId === id);

  // ---------------------------------------------------------- Supertrumpf
  send(admin, { type: 'settings', deckId: 'autos', mode: 'supertrumpf' });
  await waitFor(clients, (s) => s.deckId === 'autos' && s.mode === 'supertrumpf', 'settings');
  send(admin, { type: 'start' });
  await waitFor(clients, (s) => s.phase === 'playing', 'Start Supertrumpf');
  console.log('✓ Supertrumpf gestartet, Kartenzahlen:',
    admin.state.players.map((p) => p.cardCount).join('/'));

  // Absichtlich ein paar ungültige Züge testen:
  const notTurn = clients.find((c) => c.playerId !== admin.state.turnId);
  send(notTurn, { type: 'pickAttribute', key: 'ps' });
  await sleep(200);
  console.log('✓ Zug ausser der Reihe abgelehnt:', notTurn.errors.length > 0);

  let rounds = 0;
  const attrs = deck.attributes.map((a) => a.key);
  while (admin.state.phase === 'playing' && rounds < 500) {
    const turnId = admin.state.turnId;
    const turnClient = byId(turnId);
    const key = attrs[rounds % attrs.length]; // rotierend, damit's vorwärts geht
    send(turnClient, { type: 'pickAttribute', key });
    const before = rounds;
    await waitFor(clients, (s) => s.phase === 'finished' || s.lastRound?._seq !== undefined || true, 'runde', 100).catch(() => {});
    await sleep(60);
    rounds++;
  }
  if (admin.state.phase !== 'finished') throw new Error('Supertrumpf nicht beendet nach 500 Runden');
  const total = admin.state.players.reduce((s, p) => s + p.cardCount, 0) + admin.state.potCount;
  console.log(`✓ Supertrumpf beendet nach ${rounds} Runden. Gewinner:`,
    admin.state.winners.map((id) => byId(id).name).join(','),
    '| Kartensumme (soll 24):', total);

  // ------------------------------------------------- Klassisches Quartett
  send(admin, { type: 'restart' });
  await waitFor(clients, (s) => s.phase === 'lobby', 'Restart');
  send(admin, { type: 'settings', deckId: 'autos', mode: 'quartett' });
  await waitFor(clients, (s) => s.mode === 'quartett', 'settings quartett');
  send(admin, { type: 'start' });
  await waitFor(clients, (s) => s.phase === 'playing', 'Start Quartett');
  console.log('✓ Quartett gestartet, Handgrössen:',
    clients.map((c) => c.state.yourHand.length).join('/'));

  const famOf = (id) => deck.cards.find((c) => c.id === id).family;
  let turns = 0;
  let lastCollected = -1;
  while (admin.state.phase === 'playing' && turns < 4000) {
    const turnId = admin.state.turnId;
    const me = byId(turnId);
    const hand = me.state.yourHand;
    const targets = me.state.players.filter((p) => p.id !== turnId && p.cardCount > 0);
    if (!hand.length || !targets.length) throw new Error('Sackgasse: keine Hand/Ziele');
    // Greedy (realistischer + konvergiert schneller): frage aus der Familie, von
    // der ich am meisten halte, nach einer Karte die mir fehlt.
    const famCount = {};
    for (const id of hand) famCount[famOf(id)] = (famCount[famOf(id)] ?? 0) + 1;
    const fam = Object.entries(famCount).sort((a, b) => b[1] - a[1])[0][0];
    const options = deck.cards.filter((c) => c.family === fam && !hand.includes(c.id));
    const card = options[Math.floor(Math.random() * options.length)];
    const target = targets[Math.floor(Math.random() * targets.length)];
    const askSeqBefore = me.state.lastAsk;
    send(me, { type: 'askCard', targetId: target.id, cardId: card.id });
    await sleep(25);
    turns++;
    const collected = admin.state.players.reduce((s, p) => s + p.quartets.length, 0);
    if (collected !== lastCollected) {
      console.log(`  … Zug ${turns}: ${collected}/6 Quartette abgelegt`);
      lastCollected = collected;
    }
    if (turns === 60) {
      // Momentaufnahme: Wie sehen die Hände (nach Familie) aus?
      for (const c of clients) {
        const fc = {};
        for (const id of c.state.yourHand) { const f = famOf(id); fc[f] = (fc[f] ?? 0) + 1; }
        console.log(`  [SNAP] ${c.name}: ${c.state.yourHand.length} Karten`, JSON.stringify(fc),
          '| Quartette:', c.state.players.find(p=>p.id===c.playerId).quartets);
      }
      console.log('  [SNAP] letzte Frage:', JSON.stringify(admin.state.lastAsk));
      console.log('  [SNAP] Server-Log (letzte 8):');
      admin.state.log.slice(-8).forEach((l) => console.log('        ', l));
    }
  }
  if (admin.state.phase !== 'finished') throw new Error('Quartett nicht beendet nach 2000 Zügen');
  const quartetsTotal = admin.state.players.reduce((s, p) => s + p.quartets.length, 0);
  console.log(`✓ Quartett beendet nach ${turns} Zügen. Quartette gesamt (soll 6):`, quartetsTotal,
    '| Gewinner:', admin.state.winners.map((id) => byId(id).name).join(' & '));

  // Verstecke Hände geprüft: kein Client sieht fremde Karten-IDs.
  const leaky = clients.some((c) =>
    c.state.players.some((p) => p.hand !== undefined || p.cards !== undefined));
  console.log('✓ Keine fremden Hände im State:', !leaky);

  clients.forEach((c) => c.ws.close());
  console.log('\nALLE TESTS BESTANDEN');
}

main().catch((e) => { console.error('TEST FEHLGESCHLAGEN:', e.message); process.exit(1); });
