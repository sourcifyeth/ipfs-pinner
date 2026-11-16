// Writes a CAR file (version 1): an archive of ready-made IPFS blocks.
// Layout: header, then each block as varint(length) + CID + data.
// The root CID is only known at the end, so the header is written last.
// Its size does not depend on the root, so the space is reserved first.

import { closeSync, openSync, writeSync } from 'node:fs';
import {
  type Block,
  type DirEntry,
  buildDirectory,
  buildFile,
  varint,
} from './unixfs.js';

function header(root: Buffer): Buffer {
  // dag-cbor of { roots: [CID], version: 1 }
  const body = Buffer.concat([
    Buffer.from([0xa2, 0x65]),
    Buffer.from('roots'),
    Buffer.from([0x81, 0xd8, 0x2a, 0x58, 0x23, 0x00]),
    root,
    Buffer.from([0x67]),
    Buffer.from('version'),
    Buffer.from([0x01]),
  ]);
  return Buffer.concat([varint(body.length), body]);
}

export interface FinishedCar {
  path: string;
  root: Buffer;
  files: number;
  /** Size of the CAR file in bytes. */
  bytes: number;
}

export class CarBuilder {
  private fd: number;
  private position: number;
  private entries: DirEntry[] = [];
  /** Content bytes added so far. */
  contentBytes = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'w');
    this.position = header(Buffer.alloc(34)).length;
  }

  get files(): number {
    return this.entries.length;
  }

  private writeBlock(block: Block): void {
    const frame = Buffer.concat([
      varint(block.cid.length + block.data.length),
      block.cid,
      block.data,
    ]);
    writeSync(this.fd, frame, 0, frame.length, this.position);
    this.position += frame.length;
  }

  /** Adds one file and returns its CID. */
  addFile(content: Buffer): Buffer {
    const dag = buildFile(content);
    for (const block of dag.blocks) this.writeBlock(block);
    // Fixed-width names keep the directory order equal to the insert order.
    const name = String(this.entries.length).padStart(6, '0');
    this.entries.push({ name, cid: dag.cid, dagSize: dag.dagSize });
    this.contentBytes += content.length;
    return dag.cid;
  }

  finish(): FinishedCar {
    const root = buildDirectory(this.entries);
    this.writeBlock(root);
    const head = header(root.cid);
    writeSync(this.fd, head, 0, head.length, 0);
    closeSync(this.fd);
    return {
      path: this.path,
      root: root.cid,
      files: this.entries.length,
      bytes: this.position,
    };
  }
}
