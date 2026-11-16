// Reads the two tables of the Sourcify database. Read-only.
//
// Two read modes:
// - backfill: walks a table in primary key order. The primary key index
//   gives this order at no cost.
// - incremental: reads rows by created_at after a cursor.
//
// Backfill must not use created_at: 5.6 million rows of
// compiled_contracts_metadata share one created_at value (the default that
// the "add created_at" migration gave to all existing rows), and the index
// on created_at cannot order rows inside that group.

import { createHash } from 'node:crypto';
import pg from 'pg';

export interface Row {
  /** Primary key as text: hex of source_hash, or the compilation_id UUID. */
  id: string;
  content: Buffer;
  /** created_at as Postgres text, with full microsecond precision. */
  createdAt: string;
}

export interface TableDef {
  name: string;
  idSelect: string;
  idColumn: string;
  idParam: string;
  contentSelect: string;
  firstId: string;
  /** Throws when a row does not hold the bytes that its key promises. */
  check?: (row: Row) => void;
}

export const TABLES: Record<string, TableDef> = {
  sources: {
    name: 'sources',
    idSelect: "encode(source_hash, 'hex')",
    idColumn: 'source_hash',
    idParam: "decode($1, 'hex')",
    contentSelect: 'content',
    firstId: '',
    check: (row) => {
      // source_hash is sha256(content). An equal hash proves that the bytes
      // survived the trip through the driver unchanged.
      const hash = createHash('sha256').update(row.content).digest('hex');
      if (hash !== row.id) {
        throw new Error(`sources row ${row.id}: content hashes to ${hash}`);
      }
    },
  },
  compiled_contracts_metadata: {
    name: 'compiled_contracts_metadata',
    idSelect: 'compilation_id::text',
    idColumn: 'compilation_id',
    idParam: '$1::uuid',
    // The column type is json, which keeps the exact text. The cast to text
    // stops the driver from parsing it, because a parse and a new
    // serialization change the bytes and so the IPFS hash.
    contentSelect: 'metadata::text',
    firstId: '00000000-0000-0000-0000-000000000000',
  },
};

function toRows(table: TableDef, result: pg.QueryResult): Row[] {
  return result.rows.map((r) => {
    const row: Row = {
      id: r.id,
      content: Buffer.from(r.content, 'utf8'),
      createdAt: r.created_at,
    };
    table.check?.(row);
    return row;
  });
}

function select(table: TableDef): string {
  return `SELECT ${table.idSelect} AS id, ${table.contentSelect} AS content, created_at::text AS created_at FROM ${table.name}`;
}

/** Next rows in primary key order, after the given key. */
export async function readByKey(
  client: pg.Client,
  table: TableDef,
  afterId: string,
  limit: number,
): Promise<Row[]> {
  const result = await client.query(
    `${select(table)} WHERE ${table.idColumn} > ${table.idParam} ORDER BY ${table.idColumn} LIMIT $2`,
    [afterId, limit],
  );
  return toRows(table, result);
}

/**
 * Next rows with `after < created_at <= until`, in created_at order.
 * When the limit cuts a group of rows with an equal created_at, the rest of
 * that group is read too, so the caller can move the cursor to the last
 * created_at without a lost row.
 */
export async function readByCreatedAt(
  client: pg.Client,
  table: TableDef,
  after: string,
  until: string,
  limit: number,
): Promise<Row[]> {
  const result = await client.query(
    `${select(table)} WHERE created_at > $1::timestamptz AND created_at <= $2::timestamptz ORDER BY created_at LIMIT $3`,
    [after, until, limit],
  );
  const rows = toRows(table, result);
  if (rows.length < limit) return rows;
  const last = rows[rows.length - 1].createdAt;
  const group = await client.query(
    `${select(table)} WHERE created_at = $1::timestamptz`,
    [last],
  );
  const seen = new Set(rows.map((r) => r.id));
  for (const row of toRows(table, group)) {
    if (!seen.has(row.id)) rows.push(row);
  }
  return rows;
}

/** The database clock minus a lag, as Postgres text. */
export async function dbTimeMinus(
  client: pg.Client,
  minutes: number,
): Promise<string> {
  const result = await client.query(
    `SELECT (now() - make_interval(mins => $1))::text AS t`,
    [minutes],
  );
  return result.rows[0].t;
}

export async function connect(): Promise<pg.Client> {
  // Connection settings come from the standard PG* environment variables.
  const client = new pg.Client({
    application_name: 'ipfs-pinner',
    statement_timeout: 60_000,
  });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  return client;
}
