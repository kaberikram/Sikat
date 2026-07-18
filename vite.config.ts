import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
    // @iwsdk/xr-input pulls its own copy otherwise ("Multiple instances of
    // Three.js being imported" — and two class hierarchies that don't mix).
    dedupe: ['three'],
  },
});
