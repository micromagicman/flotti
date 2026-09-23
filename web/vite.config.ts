import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
/**
 * The page is built into build/web, next to the compiled server that serves
 * it. `npm run dev:web` serves it with hot reload and sends /api and /ws to a
 * `flotti run` on the default port.
 */
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    build: {
        outDir: fileURLToPath(new URL('../build/web', import.meta.url)),
        emptyOutDir: true
    },
    server: {
        proxy: {
            '/api': 'http://127.0.0.1:4870',
            '/ws': { target: 'ws://127.0.0.1:4870', ws: true }
        }
    }
});
