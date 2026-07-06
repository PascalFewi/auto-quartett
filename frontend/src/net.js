// REST-Helpers + stabile Spieler-Identität.

export async function createRoom() {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error('Raum konnte nicht erstellt werden.');
  const { code } = await res.json();
  return code;
}

export async function roomStatus(code) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error('Raum nicht erreichbar.');
  return res.json();
}

/**
 * Stabile Spieler-ID im localStorage. Damit erkennt der Server einen
 * Reconnect (Tab neu geladen, Handy gesperrt, ...) und hängt den Spieler
 * wieder an seine bestehende Hand.
 */
export function getPlayerId() {
  let id = localStorage.getItem('qt-player-id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('qt-player-id', id);
  }
  return id;
}

export function getSavedName() {
  return localStorage.getItem('qt-name') ?? '';
}

export function saveName(name) {
  localStorage.setItem('qt-name', name);
}

export function wsUrl(code) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws/${encodeURIComponent(code)}`;
}
