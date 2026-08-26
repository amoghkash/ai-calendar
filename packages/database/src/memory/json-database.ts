import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSnapshot } from './collections.js';
import { emptySnapshot } from './collections.js';
import { MemoryDatabase } from './memory-database.js';

/**
 * Local-first persistence: the full snapshot is written to a single JSON file.
 *
 * This keeps `calendar-agent` usable with zero infrastructure. Deployments that
 * need concurrency or multiple users should use the Postgres backend instead.
 */
export class JsonFileDatabase extends MemoryDatabase {
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly filePath: string) {
    super();
  }

  override async migrate(): Promise<void> {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.import(emptySnapshot());
      await this.flush();
      return;
    }
    const contents = readFileSync(this.filePath, 'utf8');
    const parsed =
      contents.trim().length === 0 ? emptySnapshot() : (JSON.parse(contents) as DatabaseSnapshot);
    this.import({ ...emptySnapshot(), ...parsed });
  }

  override async close(): Promise<void> {
    await this.writing;
    if (this.dirty) await this.flush();
  }

  protected override async persist(): Promise<void> {
    this.dirty = true;
    // Serialise writes so concurrent saves cannot interleave.
    this.writing = this.writing.then(() => this.flush());
    await this.writing;
  }

  private async flush(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.export(), null, 2), 'utf8');
    renameSync(temp, this.filePath);
    this.dirty = false;
  }

  get path(): string {
    return this.filePath;
  }
}
