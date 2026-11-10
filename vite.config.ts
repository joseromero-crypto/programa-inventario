/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', sourcemap: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
