import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      // index.html: ArcGIS data map. classic.html: the original Three.js globe.
      input: { main: resolve(import.meta.dirname, 'index.html'), classic: resolve(import.meta.dirname, 'classic.html') },
    },
  },
});
