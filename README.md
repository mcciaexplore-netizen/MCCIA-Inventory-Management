# MCCIA Inventory

Data lives in PostgreSQL (Neon). Set `DATABASE_URL` before starting the server:

    export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
    npm run install:all
    npm run build && npm start     # http://localhost:4000

Dev: `npm run dev:server` + `npm run dev:client` (http://localhost:5173).
First login: office **Head Office**, admin@mccia.local / admin123. You'll be asked to choose a new password straight away.

Run the server test suite with `cd server && npm test`; it runs against an isolated in-memory database, so it's safe to run anytime.

## Roles

- **admin** — everything: users, categories, items, purchase orders, deleting items, the audit log.
- **employee** — day-to-day inventory work: items, purchases, purchase orders, issuing/returning stock, fulfilling staff requests, raising maintenance complaints.
- **staff** — the lowest-privilege role: browse items, raise their own stock requests, and resolve maintenance complaints (see below).

## Accounts

- **Sign-up** creates a pending staff account; an admin approves it (and can pick the role) under **Users**.
- Users created or reset by an admin must choose their own password at their next sign-in.
- Sessions last 30 days. After 5 failed sign-ins an email is locked out for 15 minutes.
- An admin can change a user's role or office at any time under **Users**.

## Maintenance complaints

An employee (or admin) reports a service/maintenance issue under **Maintenance**, with a note and/or a photo. Staff (or admin) see every open complaint and close it out by attaching a photo of the fix.

Photos are stored in **Vercel Blob**, not on the server's disk (there isn't one in a serverless deployment):

1. In the Vercel project, add a Blob store (Storage tab) and copy its `BLOB_READ_WRITE_TOKEN`.
2. Set `BLOB_READ_WRITE_TOKEN` as an environment variable on the project (and locally in `.env` for dev).

Without that token, reporting/resolving with a photo fails with a clear "Photo storage is not configured" error; reporting with just a note still works.

## Deploying (Neon + Vercel)

The client and API both run on Vercel: the client is served as static files and the Express API runs as a serverless function (`api/index.js`), configured by the root `vercel.json`.

1. **Neon**: create a project and copy the **pooled** connection string (host contains `-pooler`). Tables are created on first request.
2. **Vercel**: import the repo with Root Directory left at the repo root (`./`). In Settings → Environment Variables set `DATABASE_URL`.
3. Optional: copy existing local data into Neon once: `DATABASE_URL=... node server/migrate_sqlite_to_pg.js`.

## Importing a monthly register

    DATABASE_URL=... node server/import_stock.js SEPTEMBER-2026.xlsx

A one-off CLI tool for loading items and historical consumption from a vendor Excel register. Writes to Neon when `DATABASE_URL` is set, otherwise to the local database. Aborts if the vendors' items already exist; `--snapshot-only` attaches just the month's figures to items imported earlier. There's no in-app page for the monthly register itself (that feature was removed); this is purely for seeding historical item/consumption data.

## Day-to-day workflow

**Daily Entry** (consumption), **Issue / Return** (loans), **Purchases** (stock in with challan), **Items > Adjust** (damage, loss, recount). All stock changes are recorded in the **Audit Log** (admin).
