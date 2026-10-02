import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works under a GitHub Pages project path
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  build: {
    // Mediabunny (~560 kB) and the lazy WASM AAC encoder (~1 MB) are big by nature.
    chunkSizeWarningLimit: 1100,
  },
});
