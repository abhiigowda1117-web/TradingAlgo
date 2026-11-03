import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the browser talks only to Vite (port 5173); /api is forwarded to the backend
// (port 3001), so cookies and requests stay same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
