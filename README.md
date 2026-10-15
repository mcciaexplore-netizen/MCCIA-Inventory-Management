# MCCIA Inventory

Data lives in PostgreSQL (Neon). Set `DATABASE_URL` before starting the server:

    export DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
    npm run install:all
    npm run build && npm start     # http://localhost:4000

Dev: `npm run dev:server` + `npm run dev:client` (http://localhost:5173).
First login: admin@mccia.local / admin123 - change it under Users.

## Deploying (Neon + Vercel)

The client and API both run on Vercel: the client is served as static files and the Express API runs as a serverless function (`api/index.js`), configured by the root `vercel.json`.

1. **Neon**: create a project and copy the **pooled** connection string (host contains `-pooler`). Tables are created on first request.
2. **Vercel**: import the repo with Root Directory left at the repo root (`./`). In Settings → Environment Variables set `DATABASE_URL`.
3. Optional: copy existing local data into Neon once: `DATABASE_URL=... node server/migrate_sqlite_to_pg.js`.

`import_stock.py` still targets the old local SQLite file; run the Excel import locally, then run the migration script above.

## Importing a monthly register

    pip install openpyxl
    python server/import_stock.py SEPTEMBER-2026.xlsx

Loads items from the vendor sheets and consumption rows as history. Aborts if vendor items already exist.

## Month-end workflow

1. Day to day: **Daily Entry** (consumption), **Issue / Return** (loans), **Purchases** (stock in with challan), **Items > Adjust** (damage, loss, recount).
2. **Monthly Report** shows opening, purchases, issues and closing per vendor; **Excel** exports it.
3. **Close month** freezes the figures; closing stock becomes next month's opening and nothing can be dated inside a closed month.

All stock changes are recorded in the **Audit Log** (admin).
