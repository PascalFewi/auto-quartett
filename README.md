# Quartett online

Supertrumpf (Top Trumps) und klassisches Quartett mit Freunden im Browser.
Läuft komplett gratis auf Cloudflare Workers (Free Plan): ein Worker, ein
Durable Object pro Spielraum, Frontend und Decks als statische Assets.

## Setup

```bash
npm install
npx wrangler login   # einmalig, öffnet den Browser
```

## Entwickeln (zwei Terminals)

```bash
npm run dev:worker   # Terminal 1: wrangler dev auf Port 8787
npm run dev:web      # Terminal 2: Vite auf Port 5173 (proxied /api und /ws)
```

Dann http://localhost:5173 öffnen. Zum Testen mit "mehreren Spielern" einfach
ein zweites Browserfenster im Privatmodus öffnen (eigener localStorage =
eigene Spieler-ID).

Alternativ ohne Hot Reload: `npm run preview` (baut das Frontend und serviert
alles über wrangler auf Port 8787).

## Deployen

```bash
npm run deploy
```

Live auf `https://auto-quartett.ch`. Die `workers.dev`-URL
(`https://quartett.<account-subdomain>.workers.dev`) bleibt zusätzlich als
Test-Adresse aktiv.

## Eigene Decks

Ein Deck ist ein Ordner unter `frontend/public/decks/<deck-id>/`:

```
frontend/public/decks/
├── index.json            # Liste aller Decks (für die Lobby-Auswahl)
└── mein-deck/
    ├── deck.json
    └── img/*.jpg|png|svg
```

`deck.json`:

```json
{
  "name": "Mein Deck",
  "families": { "A": "Anzeigename für Familie A" },
  "attributes": [
    { "key": "ps", "label": "Leistung", "unit": "PS", "higherWins": true }
  ],
  "cards": [
    {
      "id": "a1",
      "family": "A",
      "name": "Kartenname",
      "image": "img/a1.jpg",
      "values": { "ps": 478 }
    }
  ]
}
```

Regeln:

- **Klassisches Quartett** braucht exakt **4 Karten pro Familie** (der Server
  validiert das beim Start). Für reinen Supertrumpf-Betrieb sind beliebige
  Familiengrössen ok – dann in `index.json` `"quartettReady": false` setzen,
  damit der Modus in der Lobby deaktiviert wird.
- Bilder vor dem Einchecken auf ~800px Breite verkleinern (Ladezeit).
- Neuer Eintrag in `index.json` nicht vergessen, dann `npm run deploy`.

## Architektur in einem Absatz

`src/worker.ts` vergibt Raum-Codes und leitet WebSocket-Verbindungen an das
Durable Object des Raums (`src/room.ts`) weiter – `idFromName(code)` mappt
jeden Code deterministisch auf genau eine Object-Instanz. Das Room-Object hält
den kompletten Spielzustand, validiert jeden Zug serverseitig und broadcastet
nach jeder Änderung eine **personalisierte** Sicht an alle Spieler (eigene
Hand komplett, von anderen nur Kartenzahlen – niemand kann per DevTools
fremde Hände lesen). Der Zustand wird nach jedem Zug in den Object-Storage
geschrieben und überlebt so Hibernation und Neustarts; Spieler reconnecten
über eine stabile ID im localStorage.
