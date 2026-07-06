import React, { useCallback, useEffect, useRef, useState } from 'react';
import CardView from './CardView.jsx';
import Log from './Log.jsx';
import { formatValue } from '../deck.js';

// Reine Zahl (ohne Einheit) – für die geschlagenen Werte im Urteil.
const nf = new Intl.NumberFormat('de-CH');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stabile Kennung einer Runde. `lastRound` hat keine ID, aber die oberste Karte
 * jedes Spielers kann in zwei aufeinanderfolgenden Runden nicht erneut oben
 * liegen (sie wandert zum Gewinner oder in den Pot). Damit ist diese Signatur
 * pro Runde eindeutig – reine Neu-Broadcasts (z.B. Verbindungswechsel) mit
 * unverändertem `lastRound` lösen so keine erneute Animation aus.
 */
function roundKeyOf(lr) {
  if (!lr) return null;
  const entries = lr.entries.map((e) => `${e.playerId}:${e.cardId}:${e.value}`).join(',');
  return `${lr.attribute}|${entries}|${lr.winnerId}|${lr.potTaken}`;
}

/**
 * Baut aus dem Server-State (echte Daten, keine Mock-Daten) einen
 * selbst­tragenden Schnappschuss der Runde für die Showdown-Animation.
 */
function buildSnapshot(game, deck, key) {
  const lr = game.lastRound;
  const attr = deck.attributes.find((a) => a.key === lr.attribute);
  if (!attr) return null;

  const nameOf = (id) => (id === game.you ? 'Du' : game.players.find((p) => p.id === id)?.name ?? '???');

  const entries = lr.entries.map((e) => ({
    playerId: e.playerId,
    owner: nameOf(e.playerId),
    card: deck.cardById[e.cardId] ?? null,
    value: e.value,
  }));

  const values = entries.map((e) => e.value);
  const best = attr.higherWins ? Math.max(...values) : Math.min(...values);
  const isTie = lr.winnerId === null;
  const targetId = isTie ? 'pot' : lr.winnerId;

  // Kartenzahlen: der Server liefert bereits die Werte NACH der Runde.
  const finalCounts = {};
  game.players.forEach((p) => { finalCounts[p.id] = p.cardCount; });
  finalCounts.pot = game.potCount;

  // Anzahl Karten, die zum Ziel fliegen (aufgedeckte Karten + ggf. Pot).
  const flyCount = entries.length + (isTie ? 0 : lr.potTaken);
  const initialCounts = { ...finalCounts };
  initialCounts[targetId] = Math.max(0, (finalCounts[targetId] ?? 0) - flyCount);

  // Rangliste: alle Spieler nach Kartenzahl (Führender zuerst), Pott zuletzt.
  const ranking = game.players
    .map((p) => ({ id: p.id, name: nameOf(p.id) }))
    .sort((a, b) => (finalCounts[b.id] ?? 0) - (finalCounts[a.id] ?? 0));
  ranking.push({ id: 'pot', name: 'Pott', pot: true });

  const beatenNums = entries.filter((e) => e.value !== best).map((e) => nf.format(e.value));
  const unit = attr.unit ? ` ${attr.unit}` : '';
  let verdictClass;
  let verdictHead;
  let verdictDetail;
  if (isTie) {
    verdictClass = 'tie';
    verdictHead = 'UNENTSCHIEDEN';
    verdictDetail = `${nf.format(best)}${unit} · ${entries.length} Karten in den Pott`;
  } else if (lr.winnerId === game.you) {
    verdictClass = 'win';
    verdictHead = 'DU GEWINNST';
    verdictDetail = `${nf.format(best)}${unit} schlägt ${beatenNums.join(' · ')}`;
  } else {
    verdictClass = 'lose';
    verdictHead = `${nameOf(lr.winnerId)} gewinnt`;
    verdictDetail = `${nf.format(best)}${unit} schlägt ${beatenNums.join(' · ')}`;
  }

  return {
    key, attr, entries, best, isTie, targetId, flyCount,
    finalCounts, initialCounts, ranking,
    verdictClass, verdictHead, verdictDetail,
  };
}

export default function Supertrumpf({ game, deck, send, roomCode, onLeave }) {
  const myTurn = game.turnId === game.you && game.phase === 'playing';
  const topCard = game.yourTopCard ? deck.cardById[game.yourTopCard] : null;
  const turnPlayer = game.players.find((p) => p.id === game.turnId);

  const [active, setActive] = useState(null); // aktuell animierte Runde (oder null)
  const queueRef = useRef([]); // wartende Runden, falls Updates schneller kommen als die Animation
  const busyRef = useRef(false); // läuft gerade eine Animation?
  const inFlightRef = useRef(false); // eigener Pick gesendet, Server-Antwort ausstehend
  // Die beim Beitreten/Reconnect bereits vorhandene Runde gilt als "gesehen"
  // (wird nicht nachträglich animiert). Nur neue Runden lösen den Showdown aus.
  const seenKeyRef = useRef(roundKeyOf(game.lastRound));

  // Jeder neue Server-State bedeutet: der zuvor gesendete Pick ist verarbeitet.
  useEffect(() => {
    inFlightRef.current = false;
  }, [game]);

  // Neue Runde erkennen und (ggf. verzögert) in die Animations-Warteschlange stellen.
  useEffect(() => {
    const key = roundKeyOf(game.lastRound);
    if (!key || key === seenKeyRef.current) return;
    seenKeyRef.current = key;
    const snap = buildSnapshot(game, deck, key);
    if (!snap) return;
    queueRef.current.push(snap);
    if (!busyRef.current) {
      busyRef.current = true;
      setActive(queueRef.current.shift());
    }
  }, [game, deck]);

  // Ende einer Showdown-Sequenz: nächste Runde starten oder zurück in den Ruhezustand.
  const handleShowdownDone = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    busyRef.current = !!next;
    setActive(next);
  }, []);

  const pick = useCallback(
    (key) => {
      if (!myTurn || busyRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      send({ type: 'pickAttribute', key });
    },
    [myTurn, send],
  );

  return (
    <main className={`table st ${active ? 'st-busy' : ''}`}>
      {/* Schlanker Kopf (nur Mobile sichtbar): Modus + Raumname. */}
      <header className="st-head">
        <div className="st-head-mode">
          <span className="eyebrow">Quartett</span>
          <span className="mode">Supertrumpf</span>
        </div>
        <div className="st-head-room">
          <span className="st-room-label">Raum</span>
          <b>{roomCode}</b>
          {onLeave && (
            <button className="st-leave" onClick={onLeave}>
              Verlassen
            </button>
          )}
        </div>
      </header>

      {/* Mitspieler mit Kartenzahl (nur Desktop – auf Mobile via CSS ausgeblendet). */}
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

      {/* Bühne: Ruhezustand (nur deine Karte). Der Showdown legt sich als
          transientes Overlay darüber. */}
      <div className="st-stage">
        <div className="st-playfield">
          {topCard ? (
            <>
              <div className="st-turn">
                {myTurn
                  ? 'Du bist am Zug – tippe eine Kategorie auf deiner Karte:'
                  : `${turnPlayer?.name ?? '…'} wählt eine Kategorie …`}
              </div>
              <CardView
                deck={deck}
                card={topCard}
                onPickAttribute={myTurn ? pick : undefined}
              />
              <div className="st-pile">Dein Stapel · {game.yourCardCount} Karten</div>
            </>
          ) : (
            <div className="center-note">Du bist ausgeschieden – schau den anderen zu!</div>
          )}
        </div>
      </div>

      <Log entries={game.log} />

      {active && (
        <Showdown key={active.key} snap={active} deck={deck} onDone={handleShowdownDone} />
      )}
    </main>
  );
}

/**
 * Transiente Rundenauflösung. In React.memo gekapselt, damit reguläre
 * Re-Renders des Elternteils (neue Server-States während der Animation) die
 * imperativen Klassen-/Zähler-Änderungen nicht überschreiben. Das `snap`-Objekt
 * bleibt während einer Runde stabil.
 */
const Showdown = React.memo(function Showdown({ snap, deck, onDone }) {
  const attrHeadRef = useRef(null);
  const verdictRef = useRef(null);
  const revealRefs = useRef([]);
  const chipRefs = useRef({});
  const flyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const cards = () => revealRefs.current.slice(0, snap.entries.length).filter(Boolean);

    const applyOutcome = () => {
      cards().forEach((el, i) => {
        const chip = el.querySelector('.chip');
        const isTop = snap.entries[i].value === snap.best;
        if (isTop) {
          chip?.classList.add('win');
          if (!snap.isTie) el.classList.add('winner');
        } else {
          el.classList.add('loser');
          chip?.classList.add('beaten');
        }
      });
    };

    const setCount = (seat, value, deltaText) => {
      const chip = chipRefs.current[seat];
      const rc = chip?.querySelector('.rc');
      if (!rc) return;
      rc.childNodes[0].nodeValue = String(value); // erster Kindknoten = Zahl
      const d = rc.querySelector('.d');
      if (d && deltaText) {
        d.textContent = deltaText;
        d.classList.add('show');
      }
    };

    const fly = async () => {
      const layer = flyRef.current;
      const targetEl = chipRefs.current[snap.targetId];
      if (!layer || !targetEl) return;
      const tr = targetEl.getBoundingClientRect();
      const t = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
      const flights = cards().map((el, i) => {
        const rr = el.getBoundingClientRect();
        const clone = el.cloneNode(true);
        Object.assign(clone.style, {
          position: 'fixed', left: `${rr.left}px`, top: `${rr.top}px`,
          width: `${rr.width}px`, height: `${rr.height}px`, margin: '0', transition: 'none',
        });
        clone.classList.remove('winner', 'loser');
        layer.appendChild(clone);
        el.style.visibility = 'hidden';
        const dx = t.x - (rr.left + rr.width / 2);
        const dy = t.y - (rr.top + rr.height / 2);
        return clone
          .animate(
            reduce
              ? [{ opacity: 1 }, { opacity: 0 }]
              : [
                  { transform: 'translate(0,0) scale(1)', opacity: 1 },
                  {
                    transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 20}px) scale(0.8) rotate(${i % 2 ? 6 : -6}deg)`,
                    opacity: 1, offset: 0.55,
                  },
                  { transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0.1 },
                ],
            { duration: reduce ? 200 : 600, easing: 'cubic-bezier(.5,0,.3,1)', delay: i * 70, fill: 'forwards' },
          )
          .finished.then(() => clone.remove())
          .catch(() => clone.remove());
      });
      await Promise.all(flights);
    };

    async function run() {
      // Reduzierte Bewegung: kein Dealen/Fliegen, nur Endzustand + Urteil.
      if (reduce) {
        attrHeadRef.current?.classList.add('show');
        cards().forEach((el) => {
          el.classList.add('in');
          el.querySelector('.chip')?.classList.remove('hidden');
        });
        applyOutcome();
        cards().forEach((el) => {
          const chip = el.querySelector('.chip');
          if (chip?.classList.contains('beaten')) chip.classList.add('struck');
        });
        verdictRef.current?.classList.add('show');
        chipRefs.current[snap.targetId]?.classList.add('is-winner');
        setCount(snap.targetId, snap.finalCounts[snap.targetId], `+${snap.flyCount}`);
        await wait(1400);
        return;
      }

      // 1. Attribut-Schlagzeile einblenden.
      attrHeadRef.current?.classList.add('show');
      await wait(300);
      if (isCancelled()) return;

      // 2. Beteiligte Karten gestaffelt einblenden.
      for (const el of cards()) {
        if (isCancelled()) return;
        el.classList.add('in');
        await wait(150);
      }
      await wait(220);
      if (isCancelled()) return;

      // 3. Werte-Chips aufpoppen und halten.
      cards().forEach((el) => {
        const chip = el.querySelector('.chip');
        if (!chip) return;
        chip.classList.remove('hidden');
        chip.animate(
          [
            { transform: 'scale(0.6)', opacity: 0 },
            { transform: 'scale(1.12)', opacity: 1, offset: 0.7 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
      });
      await wait(560);
      if (isCancelled()) return;

      // 4. Auflösen: Sieger hebt sich ab, geschlagene Werte werden durchgestrichen.
      applyOutcome();
      await wait(80);
      cards().forEach((el) => {
        const chip = el.querySelector('.chip');
        if (chip?.classList.contains('beaten')) chip.classList.add('struck');
      });

      // 5. Urteilsbanner + Ziel-Chip markieren.
      verdictRef.current?.classList.add('show');
      chipRefs.current[snap.targetId]?.classList.add('is-winner');
      await wait(950);
      if (isCancelled()) return;

      // 6. Karten fliegen zum Gewinner (bzw. in den Pott), Zähler zählt hoch.
      await fly();
      if (isCancelled()) return;
      setCount(snap.targetId, snap.finalCounts[snap.targetId], `+${snap.flyCount}`);
      await wait(650);
    }

    run().finally(() => {
      if (!cancelled) onDone();
    });

    return () => {
      cancelled = true;
    };
  }, [snap, onDone]);

  return (
    <>
      <div className="st-disclosure">
        <div className="st-disclosure-inner">
          <div className="ranking">
            {snap.ranking.map((r) => (
              <div
                key={r.id}
                ref={(el) => {
                  chipRefs.current[r.id] = el;
                }}
                className={`rank-chip ${r.pot ? 'pot' : ''}`}
              >
                <span className="rn">{r.name}</span>
                <span className="rc">
                  {snap.initialCounts[r.id] ?? 0}
                  <span className="d" />
                </span>
              </div>
            ))}
          </div>

          <div className="attr-head" ref={attrHeadRef}>
            <div className="attr-kicker">Verglichen</div>
            <div className="attr-name">{snap.attr.label}</div>
            <div className="attr-dir">
              {snap.attr.higherWins ? '▲ höchster Wert gewinnt' : '▼ tiefster Wert gewinnt'}
            </div>
          </div>

          <div className="reveal">
            {snap.entries.map((e, i) => {
              const img = e.card ? deck.imageUrl(e.card) : null;
              return (
                <div
                  key={e.playerId}
                  ref={(el) => {
                    revealRefs.current[i] = el;
                  }}
                  className="rcard"
                  data-family={e.card?.family}
                >
                  <div className="rcard-head">
                    <span className="rcard-idx">{e.card ? deck.labelById[e.card.id] : ''}</span>
                  </div>
                  {img && <img className="rcard-img" src={img} alt="" draggable={false} />}
                  <div className="rcard-name">
                    {e.owner} · {e.card?.name}
                  </div>
                  <div className="chip hidden">
                    <span className="num">{nf.format(e.value)}</span>
                    {snap.attr.unit && <span className="unit">{snap.attr.unit}</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="verdict">
            <div className={`verdict-inner ${snap.verdictClass}`} ref={verdictRef}>
              <span className="h">{snap.verdictHead}</span>
              <span className="d">{snap.verdictDetail}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="st-fly" ref={flyRef} />
    </>
  );
});
