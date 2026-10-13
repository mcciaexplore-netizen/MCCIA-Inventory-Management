// One-time copy of server/inventory.db (SQLite) into the Postgres database in DATABASE_URL (Neon).
//   DATABASE_URL="postgresql://..." node server/migrate_sqlite_to_pg.js [path/to/inventory.db]
// Requires Node 22.5+ (node:sqlite). Aborts if the target already holds items.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const src = new DatabaseSync(process.argv[2] || fileURLToPath(new URL('./inventory.db', import.meta.url)), { readOnly: true });
const { db, tx } = await import('./db.js'); // creates the schema if needed

if ((await db.get('SELECT COUNT(*) n FROM items')).n > 0) {
  console.error('Target database already has items; refusing to import over them.');
  process.exit(1);
}

// Parents first so foreign keys hold.
const TABLES = ['users', 'categories', 'items', 'sessions', 'issues', 'purchases', 'adjustments', 'audit_log', 'closed_months', 'month_closings'];

await tx(async (t) => {
  // Drop the seeded defaults; the real rows come from SQLite.
  for (const name of ['sessions', 'categories', 'users']) await t.run(`DELETE FROM ${name}`);
  for (const table of TABLES) {
    const rows = src.prepare(`SELECT * FROM ${table}`).all();
    for (const r of rows) {
      const cols = Object.keys(r);
      await t.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => r[c]));
    }
    // Keep SERIAL counters ahead of the copied ids.
    if (rows.length && 'id' in rows[0]) await t.run(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT MAX(id) FROM ${table}))`);
    console.log(`${table}: ${rows.length} rows`);
  }
});
console.log('Done.');
process.exit(0);
