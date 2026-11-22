import { defineConfig } from 'vite';

// GitHub Pages serves the site at https://<user>.github.io/sched-evolution/.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/sched-evolution/' : '/',
}));
