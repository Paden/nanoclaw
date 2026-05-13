import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'container-config-env',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE container_configs ADD COLUMN blocked_hosts_json TEXT NOT NULL DEFAULT '[]';
    `);
  },
};
