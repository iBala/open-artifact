import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The server serves this directory. Keeping it inside the server package
    // means one container ships both, with no separate static host to run.
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // In development the app runs on its own port and the server on another.
      // Everything the server owns is proxied so cookies and redirects behave
      // exactly as they will in production, where both are one origin.
      '/api': 'http://127.0.0.1:3000',
      '/auth': 'http://127.0.0.1:3000',
      '/a': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
});
