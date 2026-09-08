'use strict';
const { migrate, pool } = require('./db');

migrate()
  .then((n) => { console.log(`  schema up to date (${n} migration files)`); return pool.end(); })
  .catch((e) => { console.error('  migration failed:', e.message); process.exit(1); });
