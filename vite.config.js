import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/miniappDemo/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'demo-sign': resolve(__dirname, 'demo-sign/index.html'),
        'demo-tx': resolve(__dirname, 'demo-tx/index.html'),
      },
    },
  },
});
