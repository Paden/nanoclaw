import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'groups/**/*.test.mjs',
      'scripts/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
  },
});
