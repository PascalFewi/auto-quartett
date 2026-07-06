import React, { useState } from 'react';
import { createRoom, roomStatus, getSavedName, saveName } from '../net.js';

export default function Home({ onJoin, showToast }) {
  const [name, setName] = useState(getSavedName());
  // Raum-Code aus Share-Link (?room=XXXXX) vorbefüllen.
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '',
  );
  const [busy, setBusy] = useState(false);

  const requireName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('Bitte zuerst einen Namen eingeben.');
      return null;
    }
    saveName(trimmed);
    return trimmed;
  };

  const handleCreate = async () => {
    const n = requireName();
    if (!n) return;
    setBusy(true);
    try {
      const newCode = await createRoom();
      onJoin(newCode, n);
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    const n = requireName();
    if (!n) return;
    const c = code.trim().toUpperCase();
    if (c.length < 4) {
      showToast('Bitte einen gültigen Raum-Code eingeben.');
      return;
    }
    setBusy(true);
    try {
      // Kurzer Check, ob der Raum existiert bzw. noch offen ist.
      const status = await roomStatus(c);
      if (status.phase !== 'lobby' && status.playerCount === 0) {
        showToast('Diesen Raum gibt es (noch) nicht.');
        setBusy(false);
        return;
      }
      onJoin(c, n);
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="home">
      <h1 className="home-title">
        <span>QUAR</span>
        <span className="tilt">TETT</span>
      </h1>
      <p className="home-sub">Supertrumpf &amp; klassisches Quartett – online mit Freunden.</p>

      <label className="field">
        <span>Dein Name</span>
        <input
          value={name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
          placeholder="z.B. Fritz"
        />
      </label>

      <div className="home-actions">
        <button className="primary" disabled={busy} onClick={handleCreate}>
          Raum erstellen
        </button>
        <div className="divider">oder</div>
        <div className="join-row">
          <input
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            placeholder="RAUM-CODE"
            className="code-input"
          />
          <button disabled={busy} onClick={handleJoin}>
            Beitreten
          </button>
        </div>
      </div>
    </main>
  );
}
