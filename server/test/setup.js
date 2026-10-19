// Runs before this test file's own imports, so index.js/db.js boot against an isolated,
// throwaway in-memory database instead of the real server/.pgdata or a configured DATABASE_URL.
process.env.PGLITE_DIR = ':memory:';
process.env.VERCEL = '1';
delete process.env.DATABASE_URL;
