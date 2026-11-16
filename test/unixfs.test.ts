import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CarBuilder } from '../src/car.js';
import { buildFile, cidToString } from '../src/unixfs.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

// "0\n1\n2\n..." cut at the given size. The reference CIDs below come from
// Kubo 0.43.1 for the same bytes:
//   ipfs add --only-hash -Q --cid-version=0 --raw-leaves=false --chunker=size-262144
function generated(size: number): Buffer {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < size; i++) {
    const line = `${i}\n`;
    parts.push(line);
    length += line.length;
  }
  return Buffer.from(parts.join('')).subarray(0, size);
}

const KUBO: [number, string][] = [
  [0, 'QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH'],
  [1, 'QmS6mcrMTFsZnT3wAptqEb8NpBPnv1H6WwZBMzEjT8SSDv'],
  [262144, 'QmPcqptizEd2qK42oK2fEnYwmm89ZXZHE92vRNN55Ey5E3'],
  [262145, 'QmZcUZz1k9h5o2L6avYDfLq9xWmihuX6YznTxBeK9YVc52'],
  [600000, 'Qmakzc63KMkfRh7Q8HahfFy1qJn8LuBseCFFBEaZDnj1sx'],
  // 176 chunks: more than 174 links, so the tree has three levels.
  [46000000, 'QmYwVM5DwMjv7uzqNoT5tbNWmk6vsEPpVFQCe3GJ7GCZyi'],
];

for (const [size, expected] of KUBO) {
  test(`file of ${size} bytes gives the same CID as Kubo`, () => {
    const dag = buildFile(generated(size));
    assert.equal(cidToString(dag.cid), expected);
    for (const block of dag.blocks) {
      const hash = createHash('sha256').update(block.data).digest();
      assert.deepEqual(block.cid.subarray(2), hash);
    }
  });
}

// Contract 0x79b3BB2961097502ad8aC68e44134a6bbE390E91 on Ethereum mainnet.
test('metadata.json gives the IPFS hash that is in the on-chain bytecode', () => {
  // From the CBOR part at the end of the runtime bytecode.
  const onchain = Buffer.from(
    '1220c014ed4399f7da6bd0baf80ba3b648c07daa309b18818b8cdaada0da8c2d8435',
    'hex',
  );
  assert.deepEqual(buildFile(fixture('metadata.json')).cid, onchain);
});

test('source file gives the IPFS URL that metadata.json lists for it', () => {
  const metadata = JSON.parse(fixture('metadata.json').toString());
  const cid = cidToString(buildFile(fixture('LaunchToken.sol')).cid);
  assert.ok(metadata.sources['src/LaunchToken.sol'].urls.includes(`dweb:/ipfs/${cid}`));
});

test('CAR file has the root in the header and every block after it', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'car-')), 'test.car');
  const car = new CarBuilder(path);
  const a = car.addFile(fixture('metadata.json'));
  const b = car.addFile(fixture('LaunchToken.sol'));
  const finished = car.finish();
  const bytes = readFileSync(path);
  assert.equal(bytes.length, finished.bytes);

  // Header: varint length, then dag-cbor that ends with the root and version.
  const headerLength = bytes[0];
  const header = bytes.subarray(1, 1 + headerLength);
  assert.ok(header.includes(finished.root));

  // Blocks: varint(length) + 34-byte CID + data.
  const found: string[] = [];
  let offset = 1 + headerLength;
  while (offset < bytes.length) {
    let length = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[offset++];
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (byte < 0x80) break;
    }
    const cid = bytes.subarray(offset, offset + 34);
    const data = bytes.subarray(offset + 34, offset + length);
    assert.deepEqual(cid.subarray(2), createHash('sha256').update(data).digest());
    found.push(cidToString(cid));
    offset += length;
  }
  assert.deepEqual(found, [cidToString(a), cidToString(b), cidToString(finished.root)]);
});
