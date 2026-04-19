#!/usr/bin/env node
import { intro, outro } from '@clack/prompts';

async function main() {
  intro('NanoClaw → Ubuntu Migration Wizard');
  outro('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
