import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // Im Dev-Modus laufen zwei Prozesse: `npm run dev:worker` (wrangler, Port 8787)
    // und `npm run dev:web` (vite, Port 5173). Vite leitet API- und
    // WebSocket-Anfragen an den Worker weiter.
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
