import React, { useEffect, useState } from 'react';
import { fetchDeckIndex } from '../deck.js';

export default function Lobby({ game, roomCode, send, showToast }) {
  const isAdmin = game.you === game.adminId;
  const [decks, setDecks] = useState([]);

  useEffect(() => {
    fetchDeckIndex()
      .then(setDecks)
      .catch(() => showToast('Deck-Liste konnte nicht geladen werden.'));
  }, [showToast]);

  // Admin: erste Deck-Auswahl automatisch setzen, falls noch keins gewählt ist.
  useEffect(() => {
    if (isAdmin && !game.deckId && decks.length > 0) {
      send({ type: 'settings', deckId: decks[0].id, mode: game.mode });
    }
  }, [isAdmin, game.deckId, game.mode, decks, send]);

  const shareLink = `${location.origin}/?room=${roomCode}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      showToast('Link kopiert!');
    } catch {
      showToast(shareLink); // Fallback: Link anzeigen
    }
  };

  const selectedDeck = decks.find((d) => d.id === game.deckId);
  const quartettOk = !selectedDeck || selectedDeck.quartettReady !== false;

  return (
    <main className="lobby">
      <section className="panel">
        <h2 className="panel-title">Raum-Code</h2>
        <div className="big-code">{roomCode}</div>
        <button onClick={copyLink}>Einladungslink kopieren</button>
      </section>

      <section className="panel">
        <h2 className="panel-title">Spieler ({game.players.length})</h2>
        <ul className="player-list">
          {game.players.map((p) => (
            <li key={p.id} className={p.connected ? '' : 'offline'}>
              <span className={`dot ${p.connected ? 'on' : 'off'}`} />
              {p.name}
              {p.id === game.adminId && <span className="chip">Admin</span>}
              {p.id === game.you && <span className="chip you">Du</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2 className="panel-title">Einstellungen</h2>
        {isAdmin ? (
          <>
            <label className="field">
              <span>Deck</span>
              <select
                value={game.deckId ?? ''}
                onChange={(e) => send({ type: 'settings', deckId: e.target.value, mode: game.mode })}
              >
                {decks.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.cardCount} Karten)
                  </option>
                ))}
              </select>
            </label>

            <div className="mode-toggle">
              {[
                ['supertrumpf', 'Supertrumpf'],
                ['quartett', 'Klassisches Quartett'],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  className={game.mode === mode ? 'active' : ''}
                  disabled={mode === 'quartett' && !quartettOk}
                  onClick={() => send({ type: 'settings', deckId: game.deckId, mode })}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              className="primary start-btn"
              disabled={game.players.filter((p) => p.connected).length < 2 || !game.deckId}
              onClick={() => send({ type: 'start' })}
            >
              Spiel starten
            </button>
            {game.players.filter((p) => p.connected).length < 2 && (
              <p className="hint">Es braucht mindestens 2 verbundene Spieler.</p>
            )}
          </>
        ) : (
          <p className="hint">
            {game.players.find((p) => p.id === game.adminId)?.name ?? 'Der Admin'} wählt Deck und
            Modus – aktuell: <strong>{selectedDeck?.name ?? '…'}</strong>,{' '}
            <strong>{game.mode === 'supertrumpf' ? 'Supertrumpf' : 'Klassisches Quartett'}</strong>.
            Warte auf den Start …
          </p>
        )}
      </section>
    </main>
  );
}
