import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Bound to 0.0.0.0 with allowedHosts open so the sandbox preview host
// (https://{port}-{sandboxId}.e2b.app) is accepted by Vite's host check.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
