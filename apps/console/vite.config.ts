import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The service's credential for the console, if the service enforces one
// (P5-A). Read here, in the dev server's Node process, and added by the proxy:
// a variable without the VITE_ prefix never reaches the client bundle.
const serviceToken = process.env['CONSOLE_SERVICE_TOKEN'];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        ...(serviceToken ? { headers: { Authorization: `Bearer ${serviceToken}` } } : {}),
      },
    },
  },
});
