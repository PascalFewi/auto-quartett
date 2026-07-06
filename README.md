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

Landet zunächst auf `https://quartett.<account-subdomain>.workers.dev`.

## Eigene Domain (auto-quartett.ch)

`.ch` verkauft Cloudflare Registrar nicht, die Domain liegt also bei einem
Schweizer Registrar. Ein Worker-**Custom-Domain** setzt aber zwingend eine
**aktive Cloudflare-Zone** voraus – man kann keine Domain am Worker anhängen,
deren DNS Cloudflare nicht verwaltet. Die Domain muss also zuerst als Zone in
den Account, und das geht auf dem Free-Plan nur per Nameserver-Wechsel (das
CNAME-only-„Partial Setup" gibt es erst ab Business).

Ablauf im aktuellen Dashboard:

1. **Zone anlegen:** Auf der Account-Startseite oben rechts **+ Add** →
   **Existing domain** (früher „Add a site") → `auto-quartett.ch` eingeben,
   **Free**-Plan wählen. Beim Scan-Angebot einfach fortfahren.
2. **Nameserver umstellen:** Cloudflare zeigt zwei Nameserver an (z. B.
   `xxx.ns.cloudflare.com`). Diese beim Schweizer Registrar (wo du die Domain
   gekauft hast) als Nameserver eintragen – die bisherigen ersetzen.
   Voraussetzung: dein Registrar erlaubt eigene Nameserver (manche „DNS-Lite"-
   Tarife tun das nicht).
3. **Warten auf Active:** Bis die Zone in Cloudflare den Status **Active** hat,
   dauert es Minuten bis einige Stunden (je nach Registrar). Erst dann geht es
   weiter – vorher schlägt ein Deploy mit Route fehl.
4. **Route scharfschalten:** In `wrangler.jsonc` den `routes`-Block
   einkommentieren (apex + www).
5. **Deployen:** `npm run deploy` – Cloudflare legt DNS-Einträge und
   TLS-Zertifikat automatisch an (`custom_domain: true`). Alternativ ginge das
   auch im Dashboard unter **Worker → Settings → Domains & Routes → Add →
   Custom Domain**, aber der `routes`-Block im Repo ist reproduzierbar und
   damit der bessere Weg.

Danach läuft alles über `https://auto-quartett.ch`. Das berührt komqom nicht:
`auto-quartett.ch` ist eine eigene Zone, komqom eine andere. Solange der
`routes`-Block auskommentiert ist, deployt das Projekt einfach auf
`workers.dev` weiter – praktisch zum Testen, bis die Domain aktiv ist.

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
