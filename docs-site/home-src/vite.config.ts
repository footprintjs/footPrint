import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@/lib/utils': path.resolve(__dirname, 'utils.ts') },
  },
  build: {
    outDir: '../public/home',
    emptyOutDir: true,
    rollupOptions: {
      input: 'main.tsx',
      output: {
        entryFileNames: 'app.js',
        assetFileNames: (info) =>
          info.name?.endsWith('.css') ? 'app.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
});
