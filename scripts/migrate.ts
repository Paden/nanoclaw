#!/usr/bin/env tsx
import { intro, outro } from '@clack/prompts';

async function main() {
  intro('NanoClaw → Ubuntu Migration Wizard');
  outro('Done!');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
