import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getPlayerId, wsUrl } from './net.js';
import { fetchDeck } from './deck.js';
import Home from './components/Home.jsx';
import Lobby from './components/Lobby.jsx';
import Supertrumpf from './components/Supertrumpf.jsx';
import Quartett from './components/Quartett.jsx';
import FinishedOverlay from './components/FinishedOverlay.jsx';

export default function App() {
  const [roomCode, setRoomCode] = useState(null);
  const [game, setGame] = useState(null);   // personalisierter Zustand vom Server
  const [deck, setDeck] = useState(null);   // Deck-Daten (Karten, Attribute)
  const [toast, setToast] = useState(null); // kurzlebige Fehlermeldung
  const [dropped, setDropped] = useState(false); // Verbindung verloren?
  const wsRef = useRef(null);
  const nameRef = useRef('');

  const showToast = useCallback((message) => {
    setToast(message);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 4000);
  }, []);

  /** Verbindung zu einem Raum aufbauen und "hello" schicken. */
  const join = useCallback(
    (code, name) => {
      nameRef.current = name;
      const ws = new WebSocket(wsUrl(code));
      wsRef.current = ws;

      ws.onopen = () => {
        setDropped(false);
        ws.send(JSON.stringify({ type: 'hello', playerId: getPlayerId(), name }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'state') {
          setGame(msg.state);
          setRoomCode(code);
          // Raum-Link in die URL schreiben, damit man ihn teilen kann.
          const url = new URL(location.href);
          url.searchParams.set('room', code);
          history.replaceState(null, '', url);
        } else if (msg.type === 'error') {
          showToast(msg.message);
          if (msg.fatal) {
            wsRef.current = null;
            setRoomCode(null);
            setGame(null);
          }
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) setDropped(true);
      };
      ws.onerror = () => showToast('Verbindungsfehler.');
    },
    [showToast],
  );

  const send = useCallback(
    (payload) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      else showToast('Nicht verbunden.');
    },
    [showToast],
  );

  const leaveToHome = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    setRoomCode(null);
    setGame(null);
    setDeck(null);
    setDropped(false);
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }, []);

  // Deck-Daten nachladen, sobald der Server ein Deck kennt.
  useEffect(() => {
    if (!game?.deckId) {
      setDeck(null);
      return;
    }
    let cancelled = false;
    fetchDeck(game.deckId)
      .then((d) => !cancelled && setDeck(d))
      .catch(() => showToast('Deck konnte nicht geladen werden.'));
    return () => {
      cancelled = true;
    };
  }, [game?.deckId, showToast]);

  // ------------------------------------------------------------- Rendering

  let screen;
  if (!game) {
    screen = <Home onJoin={join} showToast={showToast} />;
  } else if (game.phase === 'lobby') {
    screen = <Lobby game={game} roomCode={roomCode} send={send} showToast={showToast} />;
  } else if (game.mode === 'supertrumpf') {
    screen = deck ? <Supertrumpf game={game} deck={deck} send={send} /> : <Loading />;
  } else {
    screen = deck ? <Quartett game={game} deck={deck} send={send} /> : <Loading />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand" onClick={leaveToHome} role="button" tabIndex={0}>
          QUARTETT
        </span>
        {roomCode && game && (
          <span className="room-tag">
            Raum {roomCode}
            <button className="link-btn" onClick={leaveToHome}>
              Verlassen
            </button>
          </span>
        )}
      </header>

      {screen}

      {game?.phase === 'finished' && deck && (
        <FinishedOverlay game={game} send={send} />
      )}

      {dropped && game && (
        <div className="banner warn">
          Verbindung verloren.
          <button onClick={() => join(roomCode, nameRef.current)}>Neu verbinden</button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Loading() {
  return <main className="center-note">Deck wird geladen …</main>;
}
