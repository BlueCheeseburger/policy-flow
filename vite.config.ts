import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing dependencies into their own chunks.
        // This app gets opened on tournament wifi, and these are the three
        // biggest things in the bundle — separating them means a redeploy of
        // the app code doesn't force a re-download of all of it.
        manualChunks: {
          xlsx: ['xlsx'],
          yjs: ['yjs', 'y-protocols/awareness'],
          supabase: ['@supabase/supabase-js'],
          docx: ['jszip'],
        },
      },
    },
  },
});
