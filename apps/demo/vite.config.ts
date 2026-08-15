import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/webhdc/',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        devtoolsFrame: 'devtools-frame.html',
      },
    },
  },
});
