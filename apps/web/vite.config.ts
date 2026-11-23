import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base './' keeps asset paths relative, so the build works on GitHub Pages
// under /<repo>/ and later inside the Windows and Android wrappers.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
