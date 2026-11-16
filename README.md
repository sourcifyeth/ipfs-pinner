# ipfs-pinner

Keeps the source files and the metadata files of Sourcify available on IPFS.

The Solidity compiler writes the IPFS hash of `metadata.json` into the
contract bytecode, and `metadata.json` lists an IPFS hash for each source
file. This job makes those hashes resolve. It is separate from the Sourcify
server and only reads the Sourcify database.

## How it works

1. Read new rows from two tables: `sources` (column `content`) and
   `compiled_contracts_metadata` (column `metadata`).
2. Build the IPFS blocks for each row, in the exact format that the compiler
   assumes: CIDv0, 256 KiB chunks. See `src/unixfs.ts`.
3. Pack the blocks of many rows into one CAR file (an archive of IPFS
   blocks). The root of the CAR file is a directory that links to every file.
4. Upload the CAR file to the pinning provider (Lighthouse).
5. Save the cursor.

Each file keeps its own CID inside the CAR file, so anybody can fetch one
file by the hash from the bytecode.

## Two modes

| `MODE` | Reads | Use |
|---|---|---|
| `incremental` | rows by `created_at` after the cursor, older than `LAG_MINUTES` | hourly |
| `backfill` | all rows in primary key order, with a rate limit | once |

The backfill does not read by `created_at`, because millions of metadata
rows share one `created_at` value and the index cannot order them.

The same row can be uploaded twice (a crash before the cursor write, or the
overlap of the two modes). Equal content gives equal CIDs, so this is harmless.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MODE` | `incremental` | `incremental` or `backfill` |
| `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | | database connection |
| `STATE_BUCKET` or `STATE_DIR` | | where cursors and upload records live |
| `LIGHTHOUSE_API_KEY` | | key of the pinning provider |
| `UPLOAD_DIR` | | if set, CAR files go to this folder and nothing is uploaded |
| `TABLES` | both | comma-separated list |
| `BATCH_ROWS` | 500 | rows per query |
| `CAR_MAX_FILES` | 8000 | files per CAR file |
| `CAR_MAX_BYTES` | 128 MB | content bytes per CAR file |
| `MAX_BYTES_PER_SECOND` | 0 (no limit) | read rate limit, for the backfill |
| `LAG_MINUTES` | 15 | rows younger than this wait for the next run |
| `MAX_RUN_MINUTES` | 0 (no limit) | the run stops cleanly after this time |

State layout: `cursors/<mode>-<table>.json` and one `uploads/<car name>.json`
per CAR file with the root CID, the key range and the date.

## Develop

```bash
npm install
npm test        # compares CIDs with Kubo and with a real on-chain hash
npm run build
```

Deploy steps: [deploy/gcp.md](deploy/gcp.md). Database role: [deploy/db-role.sql](deploy/db-role.sql).
