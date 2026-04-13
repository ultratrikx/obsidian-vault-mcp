import path from 'path';
import fs from 'fs/promises';
import { createStore } from '@tobilu/qmd';
import type { QMDStore } from '@tobilu/qmd';
import chokidar, { FSWatcher } from 'chokidar';

export interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet?: string;
}

export class VaultSearch {
  private store: QMDStore | null = null;
  private watcher: FSWatcher | null = null;
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly REINDEX_DEBOUNCE_MS = 5_000;

  constructor(
    private readonly vaultPath: string,
    private readonly dbPath: string
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });

    this.store = await createStore({
      dbPath: this.dbPath,
      config: {
        collections: {
          vault: {
            path: this.vaultPath,
            pattern: '**/*.md',
            ignore: ['.obsidian/**', '.trash/**'],
          },
        },
      },
    });

    log('info', `QMD store opened: ${this.dbPath}`);

    // Initial index + embed (non-blocking from caller's perspective — errors are logged)
    await this.reindex();

    // Watch vault for changes and debounce re-indexing
    this.watcher = chokidar.watch(this.vaultPath, {
      ignored: [/(^|[/\\])\../, '**/.obsidian/**'],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });

    this.watcher.on('add', () => this.scheduleReindex());
    this.watcher.on('change', () => this.scheduleReindex());
    this.watcher.on('unlink', () => this.scheduleReindex());

    log('info', 'Vault watcher started');
  }

  private scheduleReindex(): void {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    this.reindexTimer = setTimeout(() => this.reindex(), this.REINDEX_DEBOUNCE_MS);
  }

  async reindex(): Promise<void> {
    if (!this.store) return;
    try {
      log('info', 'Indexing vault files…');
      await this.store.update({ collections: ['vault'] });
      log('info', 'Generating embeddings…');
      await this.store.embed({ force: false });
      log('info', 'Index up to date');
    } catch (err) {
      log('error', `Reindex failed: ${err}`);
    }
  }

  /** Hybrid search: BM25 + vector + LLM reranking. Best quality. */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.store) throw new Error('Search store not initialized');
    const results = await this.store.search({ query, limit });
    return results.map(r => ({
      path: r.file,
      title: r.title ?? path.basename(r.file),
      score: r.score,
      snippet: r.bestChunk?.slice(0, 200) ?? undefined,
    }));
  }

  /** Fast BM25 keyword-only search. No LLM required. */
  async searchKeyword(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.store) throw new Error('Search store not initialized');
    const results = await this.store.searchLex(query, { limit });
    return results.map(r => ({
      path: r.filepath,
      title: r.title ?? path.basename(r.filepath),
      score: r.score,
    }));
  }

  /** Pure vector / semantic search using embeddings. */
  async searchSemantic(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.store) throw new Error('Search store not initialized');
    const results = await this.store.searchVector(query, { limit });
    return results.map(r => ({
      path: r.filepath,
      title: r.title ?? path.basename(r.filepath),
      score: r.score,
    }));
  }

  async getIndexStatus(): Promise<{ indexed: number; needsEmbedding: number }> {
    if (!this.store) return { indexed: 0, needsEmbedding: 0 };
    const status = await this.store.getStatus();
    return { indexed: status.totalDocuments, needsEmbedding: status.needsEmbedding };
  }

  async close(): Promise<void> {
    if (this.reindexTimer) clearTimeout(this.reindexTimer);
    await this.watcher?.close();
    await this.store?.close();
  }
}

function log(level: 'info' | 'error' | 'warn', msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${msg}\n`);
}
