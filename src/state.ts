// Small JSON documents that the job keeps between runs: one cursor per
// table and mode, and one record per uploaded CAR file.
// In Cloud Run they live in a GCS bucket. For local runs they live in a folder.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Storage } from '@google-cloud/storage';

export interface StateStore {
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
}

export class DirStateStore implements StateStore {
  constructor(private dir: string) {}

  async read<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, key), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
  }
}

export class GcsStateStore implements StateStore {
  private bucket;

  constructor(bucket: string) {
    this.bucket = new Storage().bucket(bucket);
  }

  async read<T>(key: string): Promise<T | undefined> {
    try {
      const [data] = await this.bucket.file(key).download();
      return JSON.parse(data.toString('utf8')) as T;
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    await this.bucket
      .file(key)
      .save(JSON.stringify(value, null, 2), { contentType: 'application/json' });
  }
}
