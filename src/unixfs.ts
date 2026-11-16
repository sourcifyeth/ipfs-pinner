// Builds the exact IPFS blocks that the Solidity compiler assumes when it
// writes an IPFS hash into contract bytecode or into metadata.json:
// CIDv0, dag-pb UnixFS file, sha2-256, fixed 256 KiB chunks, no raw leaves,
// balanced tree with at most 174 links per node.
// Port of libsolutil/IpfsHash.cpp (same algorithm as ipfsHash in lib-sourcify),
// extended to return the blocks and not only the hash.

import { createHash } from 'node:crypto';

export const CHUNK_SIZE = 256 * 1024;
export const MAX_LINKS = 174;

/** One IPFS block. `cid` is the 34-byte CIDv0 (the sha2-256 multihash). */
export interface Block {
  cid: Buffer;
  data: Buffer;
}

/** A finished file or directory tree. */
export interface Dag {
  cid: Buffer;
  blocks: Block[];
  /** Total size of all blocks in the tree. Used as Tsize in parent links. */
  dagSize: number;
}

interface Link {
  hash: Buffer;
  /** File bytes under this node. */
  size: number;
  /** Block bytes under this node, this node included. */
  blockSize: number;
}

export function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push(0x80 | (n % 0x80));
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Buffer.from(out);
}

function multihash(block: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x12, 0x20]),
    createHash('sha256').update(block).digest(),
  ]);
}

function leaf(chunk: Buffer, blocks: Block[]): Link {
  const length = varint(chunk.length);
  const unixfs = Buffer.concat([
    Buffer.from([0x08, 0x02]),
    // Empty data has no Data field. This matches the compiler and Kubo.
    ...(chunk.length > 0 ? [Buffer.from([0x12]), length, chunk] : []),
    Buffer.from([0x18]),
    length,
  ]);
  const data = Buffer.concat([Buffer.from([0x0a]), varint(unixfs.length), unixfs]);
  const hash = multihash(data);
  blocks.push({ cid: hash, data });
  return { hash, size: chunk.length, blockSize: data.length };
}

function parent(links: Link[], blocks: Block[]): Link {
  const linkParts: Buffer[] = [];
  const lengthParts: Buffer[] = [];
  let size = 0;
  let blockSize = 0;
  for (const link of links) {
    size += link.size;
    blockSize += link.blockSize;
    const inner = Buffer.concat([
      Buffer.from([0x0a]),
      varint(link.hash.length),
      link.hash,
      Buffer.from([0x12, 0x00, 0x18]),
      varint(link.blockSize),
    ]);
    linkParts.push(Buffer.from([0x12]), varint(inner.length), inner);
    lengthParts.push(Buffer.from([0x20]), varint(link.size));
  }
  const unixfs = Buffer.concat([
    Buffer.from([0x08, 0x02, 0x18]),
    varint(size),
    ...lengthParts,
  ]);
  const data = Buffer.concat([
    ...linkParts,
    Buffer.from([0x0a]),
    varint(unixfs.length),
    unixfs,
  ]);
  const hash = multihash(data);
  blocks.push({ cid: hash, data });
  return { hash, size, blockSize: blockSize + data.length };
}

/** Builds all blocks of one file. Most files are one block. */
export function buildFile(content: Buffer): Dag {
  const blocks: Block[] = [];
  let level: Link[] = [];
  const chunkCount = Math.max(1, Math.ceil(content.length / CHUNK_SIZE));
  for (let i = 0; i < chunkCount; i++) {
    level.push(leaf(content.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), blocks));
  }
  while (level.length > 1) {
    const next: Link[] = [];
    for (let i = 0; i < level.length; i += MAX_LINKS) {
      next.push(parent(level.slice(i, i + MAX_LINKS), blocks));
    }
    level = next;
  }
  return { cid: level[0].hash, blocks, dagSize: level[0].blockSize };
}

export interface DirEntry {
  name: string;
  cid: Buffer;
  dagSize: number;
}

/**
 * Builds one UnixFS directory block that links to the given entries.
 * It is the root of a CAR file, so one pin on it keeps every file.
 */
export function buildDirectory(entries: DirEntry[]): Block {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const name = Buffer.from(entry.name);
    const inner = Buffer.concat([
      Buffer.from([0x0a]),
      varint(entry.cid.length),
      entry.cid,
      Buffer.from([0x12]),
      varint(name.length),
      name,
      Buffer.from([0x18]),
      varint(entry.dagSize),
    ]);
    parts.push(Buffer.from([0x12]), varint(inner.length), inner);
  }
  parts.push(Buffer.from([0x0a, 0x02, 0x08, 0x01]));
  const data = Buffer.concat(parts);
  return { cid: multihash(data), data };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Text form of a CIDv0: "Qm...". */
export function cidToString(cid: Buffer): string {
  let n = BigInt('0x' + cid.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of cid) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}
