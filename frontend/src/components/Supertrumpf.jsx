import React from 'react';
import CardView from './CardView.jsx';
import Log from './Log.jsx';
import { formatValue } from '../deck.js';

export default function Supertrumpf({ game, deck, send }) {
  const myTurn = game.turnId === game.you && game.phase === 'playing';
  const topCard = game.yourTopCard ? deck.cardById[game.yourTopCard] : null;
  const turnPlayer = game.players.find((p) => p.id === game.turnId);
  const lastAttr = game.lastRound
    ? deck.attributes.find((a) => a.key === game.lastRound.attribute)
    : null;

  return (
    <main className="table">
      {/* Mitspieler mit Kartenzahl */}
      <section className="opponents">
        {game.players.map((p) => (
          <div
            key={p.id}
            className={`seat ${p.id === game.turnId ? 'turn' : ''} ${
              p.cardCount === 0 ? 'out' : ''
            } ${p.connected ? '' : 'offline'}`}
          >
            <span className="seat-name">
              {p.name}
              {p.id === game.you ? ' (du)' : ''}
            </span>
            <span className="seat-cards">{p.cardCount} Karten</span>
          </div>
        ))}
      </section>

      {/* Rundenergebnis: alle aufgedeckten Karten der letzten Runde */}
      <section className="round-area">
        {game.potCount > 0 && <div className="pot">Pot: {game.potCount} Karten</div>}
        {game.lastRound && lastAttr && (
          <div className="reveal">
            <div className="reveal-title">
              Verglichen: <strong>{lastAttr.label}</strong>
              {game.lastRound.winnerId === null && ' – Unentschieden!'}
            </div>
            <div className="reveal-cards">
              {game.lastRound.entries.map((e) => (
                <div
                  key={e.playerId}
                  className={`reveal-entry ${
                    e.playerId === game.lastRound.winnerId ? 'winner' : ''
                  }`}
                >
                  <CardView deck={deck} card={deck.cardById[e.cardId]} small highlightKey={lastAttr.key} />
                  <div className="reveal-owner">
                    {game.players.find((p) => p.id === e.playerId)?.name}:{' '}
                    {formatValue(lastAttr, e.value)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Eigene Karte */}
      <section className="my-area">
        {topCard ? (
          <>
            <div className="turn-note">
              {myTurn
                ? 'Du bist am Zug – wähle eine Kategorie auf deiner Karte:'
                : `${turnPlayer?.name ?? '…'} wählt eine Kategorie …`}
            </div>
            <CardView
              deck={deck}
              card={topCard}
              onPickAttribute={myTurn ? (key) => send({ type: 'pickAttribute', key }) : undefined}
            />
            <div className="hint">Dein Stapel: {game.yourCardCount} Karten</div>
          </>
        ) : (
          <div className="center-note">Du bist ausgeschieden – schau den anderen zu!</div>
        )}
      </section>

      <Log entries={game.log} />
    </main>
  );
}
