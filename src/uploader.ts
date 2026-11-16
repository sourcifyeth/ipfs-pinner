// Where a finished CAR file goes. One small interface, so a change of
// pinning provider touches only this file.

import { openAsBlob } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FinishedCar } from './car.js';
import { cidToString } from './unixfs.js';

export interface Uploader {
  /** Uploads the CAR file. Returns the provider's own id for it, if any. */
  upload(car: FinishedCar, name: string): Promise<string | undefined>;
}

/** Lighthouse (lighthouse.storage): CAR import, one pin on the root. */
export class LighthouseUploader implements Uploader {
  constructor(
    private apiKey: string,
    private endpoint = 'https://upload.lighthouse.storage/api/v0/dag/import',
  ) {}

  async upload(car: FinishedCar, name: string): Promise<string | undefined> {
    const form = new FormData();
    form.append('file', await openAsBlob(car.path), name);
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Lighthouse upload of ${name}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    // The answer is { Hash, Size, Name }, in some versions inside "data".
    const parsed = JSON.parse(text);
    const hash = (parsed.data ?? parsed).Hash;
    const expected = cidToString(car.root);
    if (hash !== expected) {
      // A different root means that the provider changed our blocks.
      throw new Error(`Lighthouse upload of ${name}: root is ${hash}, expected ${expected}`);
    }
    return undefined;
  }
}

/** Copies the CAR file into a folder. For dry runs and tests. */
export class DirUploader implements Uploader {
  constructor(private dir: string) {}

  async upload(car: FinishedCar, name: string): Promise<string | undefined> {
    await mkdir(this.dir, { recursive: true });
    await copyFile(car.path, join(this.dir, name));
    return undefined;
  }
}
