/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    // jsdom environment creation is expensive and can exceed Vitest's worker
    // startup timeout on constrained machines / newer Node releases. Running in a
    // single forked worker keeps CI and local test runs deterministic.
    pool: 'forks',
    maxWorkers: 1,
  },
})
