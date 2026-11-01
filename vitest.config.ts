import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only look inside test/. Without this, running from the wrong folder (e.g. a home
    // directory) makes vitest scan protected system folders and fail with EPERM.
    include: ['**/*.test.ts'],
    dir: 'test',
  },
});
