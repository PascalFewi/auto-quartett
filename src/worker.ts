import { Room } from './room';
export { Room };

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

// Alphabet ohne verwechselbare Zeichen (kein O/0, I/1/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeRoomCode(length = 5): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Neuen Raum "erstellen": Wir vergeben nur einen Code. Das Durable Object
    // dazu entsteht lazy beim ersten WebSocket-Connect (idFromName ist
    // deterministisch: gleicher Code -> gleiches Object).
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      return Response.json({ code: makeRoomCode() });
    }

    // Raum-Status abfragen (für die Beitreten-Validierung im Frontend).
    const statusMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,8})$/);
    if (statusMatch) {
      const code = statusMatch[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch('https://room/status');
    }

    // WebSocket-Verbindung an das Durable Object des Raums weiterreichen.
    const wsMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    // Alles andere: statische Assets (Frontend + Decks).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
