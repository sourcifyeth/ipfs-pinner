// Entry point. One run reads new rows, packs them into CAR files, uploads
// each CAR file, and then moves the cursor.
//
// The cursor moves only after a successful upload. If a run stops between
// the upload and the cursor write, the next run uploads the same rows
// again. That is harmless: equal content gives equal CIDs.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { CarBuilder } from './car.js';
import {
  TABLES,
  type Row,
  type TableDef,
  connect,
  dbTimeMinus,
  readByCreatedAt,
  readByKey,
} from './db.js';
import { DirStateStore, GcsStateStore, type StateStore } from './state.js';
import { DirUploader, LighthouseUploader, type Uploader } from './uploader.js';
import { cidToString } from './unixfs.js';

type Mode = 'incremental' | 'backfill';

interface Cursor {
  /** backfill: last primary key done. incremental: last created_at done. */
  position: string;
  /** Number of the next CAR file. */
  seq: number;
  /** backfill only: the walk reached the end of the table. */
  done?: boolean;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const config = {
  mode: env('MODE', 'incremental') as Mode,
  tables: env('TABLES', 'sources,compiled_contracts_metadata').split(','),
  batchRows: Number(env('BATCH_ROWS', '500')),
  carMaxFiles: Number(env('CAR_MAX_FILES', '8000')),
  carMaxBytes: Number(env('CAR_MAX_BYTES', String(128 * 1024 * 1024))),
  /** Content bytes per second read from the database. 0 means no limit. */
  maxBytesPerSecond: Number(env('MAX_BYTES_PER_SECOND', '0')),
  /** Rows younger than this are left for the next run. */
  lagMinutes: Number(env('LAG_MINUTES', '15')),
  /** The run stops cleanly after this time. 0 means no limit. */
  maxRunMinutes: Number(env('MAX_RUN_MINUTES', '0')),
};

function log(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ severity: 'INFO', message, ...fields }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTable(
  client: pg.Client,
  table: TableDef,
  state: StateStore,
  uploader: Uploader,
  deadline: number,
): Promise<void> {
  const mode = config.mode;
  const cursorKey = `cursors/${mode}-${table.name}.json`;
  let cursor = await state.read<Cursor>(cursorKey);

  if (mode === 'incremental' && !cursor) {
    // First run: start at the present. The backfill job covers older rows.
    cursor = { position: await dbTimeMinus(client, config.lagMinutes), seq: 0 };
    await state.write(cursorKey, cursor);
    log('Started the incremental cursor', { table: table.name, ...cursor });
    return;
  }
  cursor ??= { position: table.firstId, seq: 0 };
  if (cursor.done) {
    log('Backfill is already complete', { table: table.name });
    return;
  }

  const until =
    mode === 'incremental' ? await dbTimeMinus(client, config.lagMinutes) : '';
  const started = Date.now();
  let bytesRead = 0;
  let position = cursor.position;
  let first: Row | undefined;
  let last: Row | undefined;
  let car: CarBuilder | undefined;
  let reachedEnd = false;

  const flush = async () => {
    if (!car || !first || !last) return;
    const finished = car.finish();
    const name = `${table.name}-${mode}-${String(cursor!.seq).padStart(7, '0')}.car`;
    const providerId = await uploader.upload(finished, name);
    await state.write(`uploads/${name}.json`, {
      name,
      table: table.name,
      mode,
      root: cidToString(finished.root),
      files: finished.files,
      bytes: finished.bytes,
      firstId: first.id,
      lastId: last.id,
      firstCreatedAt: first.createdAt,
      lastCreatedAt: last.createdAt,
      providerId,
      uploadedAt: new Date().toISOString(),
    });
    cursor = { position, seq: cursor!.seq + 1 };
    await state.write(cursorKey, cursor);
    await rm(finished.path, { force: true });
    log('Uploaded a CAR file', {
      table: table.name,
      name,
      root: cidToString(finished.root),
      files: finished.files,
      bytes: finished.bytes,
    });
    car = undefined;
    first = undefined;
  };

  while (Date.now() < deadline) {
    const rows =
      mode === 'backfill'
        ? await readByKey(client, table, position, config.batchRows)
        : await readByCreatedAt(client, table, position, until, config.batchRows);
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    car ??= new CarBuilder(join(tmpdir(), `${table.name}-${process.pid}.car`));
    for (const row of rows) {
      car.addFile(row.content);
      bytesRead += row.content.length;
    }
    first ??= rows[0];
    last = rows[rows.length - 1];
    position = mode === 'backfill' ? last.id : last.createdAt;

    if (car.files >= config.carMaxFiles || car.contentBytes >= config.carMaxBytes) {
      await flush();
    }
    if (config.maxBytesPerSecond > 0) {
      const earliest = started + (bytesRead / config.maxBytesPerSecond) * 1000;
      if (earliest > Date.now()) await sleep(earliest - Date.now());
    }
  }
  await flush();

  if (mode === 'backfill' && reachedEnd) {
    await state.write(cursorKey, { ...cursor, done: true });
    log('Backfill reached the end of the table', { table: table.name });
  }
  log('Table run finished', { table: table.name, mode, bytesRead, reachedEnd });
}

async function main(): Promise<void> {
  const state: StateStore = process.env.STATE_BUCKET
    ? new GcsStateStore(process.env.STATE_BUCKET)
    : new DirStateStore(env('STATE_DIR'));
  const uploader: Uploader = process.env.UPLOAD_DIR
    ? new DirUploader(process.env.UPLOAD_DIR)
    : new LighthouseUploader(env('LIGHTHOUSE_API_KEY'));
  const deadline =
    config.maxRunMinutes > 0 ? Date.now() + config.maxRunMinutes * 60_000 : Infinity;

  const client = await connect();
  try {
    for (const name of config.tables) {
      const table = TABLES[name];
      if (!table) throw new Error(`Unknown table ${name}`);
      await runTable(client, table, state, uploader, deadline);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ severity: 'ERROR', message: String(error?.stack ?? error) }));
  process.exit(1);
});
