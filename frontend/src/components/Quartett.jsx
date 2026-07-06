import React, { useEffect, useState } from 'react';
import CardView from './CardView.jsx';
import Log from './Log.jsx';

export default function Quartett({ game, deck, send }) {
  const myTurn = game.turnId === game.you && game.phase === 'playing';
  const turnPlayer = game.players.find((p) => p.id === game.turnId);
  const myHand = game.yourHand.map((id) => deck.cardById[id]);

  // Frage-Assistent: Ziel -> Familie -> Karte
  const [targetId, setTargetId] = useState(null);
  const [family, setFamily] = useState(null);

  // Auswahl zurücksetzen, sobald sich der Zug ändert.
  useEffect(() => {
    setTargetId(null);
    setFamily(null);
  }, [game.turnId, game.yourHand.length]);

  // Familien, aus denen ich fragen DARF (ich halte selbst mind. eine Karte).
  const myFamilies = [...new Set(myHand.map((c) => c.family))];
  // Karten der gewählten Familie, die ich NICHT selbst habe.
  const askableCards = family
    ? deck.cards.filter((c) => c.family === family && !game.yourHand.includes(c.id))
    : [];
  const targets = game.players.filter((p) => p.id !== game.you && p.cardCount > 0);

  const lastAskText = game.lastAsk
    ? (() => {
        const asker = game.players.find((p) => p.id === game.lastAsk.askerId)?.name;
        const target = game.players.find((p) => p.id === game.lastAsk.targetId)?.name;
        const card = deck.cardById[game.lastAsk.cardId]?.name;
        return game.lastAsk.success
          ? `${asker} hat „${card}“ von ${target} bekommen.`
          : `${target} hatte „${card}“ nicht – ${target} ist am Zug.`;
      })()
    : null;

  return (
    <main className="table">
      {/* Mitspieler: Kartenzahl + gesammelte Quartette */}
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
            <span className="seat-quartets">
              {p.quartets.map((f) => (
                <span key={f} className="family-chip" data-family={f} title={deck.familyName(f)}>
                  {f}
                </span>
              ))}
            </span>
          </div>
        ))}
      </section>

      {lastAskText && <div className="banner">{lastAskText}</div>}

      {/* Frage-Assistent */}
      <section className="ask-panel">
        {myTurn ? (
          <>
            <div className="turn-note">Du bist am Zug. Wen willst du fragen?</div>
            <div className="pick-row">
              {targets.map((p) => (
                <button
                  key={p.id}
                  className={targetId === p.id ? 'active' : ''}
                  onClick={() => setTargetId(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>

            {targetId && (
              <>
                <div className="turn-note">Aus welcher Familie? (nur Familien, die du selbst hältst)</div>
                <div className="pick-row">
                  {myFamilies.map((f) => (
                    <button
                      key={f}
                      className={`family-btn ${family === f ? 'active' : ''}`}
                      data-family={f}
                      onClick={() => setFamily(f)}
                    >
                      {f} · {deck.familyName(f)}
                    </button>
                  ))}
                </div>
              </>
            )}

            {targetId && family && (
              <>
                <div className="turn-note">Welche Karte?</div>
                <div className="pick-row">
                  {askableCards.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => send({ type: 'askCard', targetId, cardId: c.id })}
                    >
                      {deck.labelById[c.id]} · {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <div className="turn-note">
            {game.yourCardCount === 0
              ? 'Du hast keine Karten mehr – deine Quartette zählen am Ende trotzdem.'
              : `${turnPlayer?.name ?? '…'} überlegt, wen er fragt …`}
          </div>
        )}
      </section>

      {/* Eigene Hand, nach Familien gruppiert */}
      <section className="my-area">
        <div className="hint">Deine Hand ({myHand.length} Karten)</div>
        <div className="hand">
          {deck.familiesList
            .filter((f) => myHand.some((c) => c.family === f))
            .map((f) => (
              <div key={f} className="hand-group">
                {myHand
                  .filter((c) => c.family === f)
                  .map((c) => (
                    <CardView key={c.id} deck={deck} card={c} small />
                  ))}
              </div>
            ))}
        </div>
      </section>

      <Log entries={game.log} />
    </main>
  );
}
