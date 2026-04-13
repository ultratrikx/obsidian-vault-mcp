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

/** A single angle in a multi-perspective concept exploration */
export interface ConceptAngle {
  type: string;           // e.g. "lexical", "semantic", "hypothetical"
  query: string;          // the expanded sub-query
  results: SearchResult[];
}

/** Full result of exploreConcept */
export interface ConceptExploration {
  concept: string;
  angles: ConceptAngle[];
  /** Deduplicated union of all results, sorted by best score across angles */
  topNotes: SearchResult[];
}

/** A note with its full content, used for deep-dive context */
export interface NoteWithContent {
  path: string;
  title: string;
  score: number;
  content: string;
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
    await this.reindex();

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
      snippet: r.bestChunk?.slice(0, 300) ?? undefined,
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

  /**
   * Find semantic connections — returns results with snippets and scores,
   * optimised for discovering related ideas rather than finding a specific note.
   */
  async findConnections(query: string, limit = 15): Promise<SearchResult[]> {
    if (!this.store) throw new Error('Search store not initialized');
    // Use full hybrid search for best connection quality, with larger snippet
    const results = await this.store.search({ query, limit, rerank: true });
    return results.map(r => ({
      path: r.file,
      title: r.title ?? path.basename(r.file),
      score: r.score,
      snippet: r.bestChunk?.slice(0, 400) ?? undefined,
    }));
  }

  /**
   * Explore a concept from multiple angles using QMD query expansion.
   * Expands the concept into lexical, semantic, and hypothetical sub-queries,
   * runs each independently, then aggregates. Designed for agent deep-dives.
   */
  async exploreConcept(concept: string, resultsPerAngle = 5): Promise<ConceptExploration> {
    if (!this.store) throw new Error('Search store not initialized');

    // Expand concept into typed sub-queries
    const expanded = await this.store.expandQuery(concept);

    const angleTypeLabels: Record<string, string> = {
      lex: 'lexical',
      vec: 'semantic',
      hyde: 'hypothetical',
    };

    const angles: ConceptAngle[] = [];
    const seen = new Map<string, number>(); // path → best score

    for (const eq of expanded) {
      let results: SearchResult[] = [];

      if (eq.type === 'lex') {
        const raw = await this.store.searchLex(eq.query, { limit: resultsPerAngle });
        results = raw.map(r => ({
          path: r.filepath,
          title: r.title ?? path.basename(r.filepath),
          score: r.score,
        }));
      } else {
        // vec and hyde both use vector search
        const raw = await this.store.searchVector(eq.query, { limit: resultsPerAngle });
        results = raw.map(r => ({
          path: r.filepath,
          title: r.title ?? path.basename(r.filepath),
          score: r.score,
        }));
      }

      angles.push({
        type: angleTypeLabels[eq.type] ?? eq.type,
        query: eq.query,
        results,
      });

      // Track best score per note across all angles
      for (const r of results) {
        const prev = seen.get(r.path) ?? 0;
        if (r.score > prev) seen.set(r.path, r.score);
      }
    }

    // Build deduplicated top notes list
    const topNotes: SearchResult[] = Array.from(seen.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([p, score]) => {
        const angleResult = angles.flatMap(a => a.results).find(r => r.path === p);
        return { path: p, title: angleResult?.title ?? path.basename(p), score };
      });

    return { concept, angles, topNotes };
  }

  /**
   * Find notes semantically related to a specific vault note.
   * Reads the note's content and uses it as the search query — leverages
   * QMD's embeddings to surface conceptually connected notes.
   */
  async getRelatedForNote(
    notePath: string,
    limit = 10
  ): Promise<SearchResult[]> {
    if (!this.store) throw new Error('Search store not initialized');

    // Get note body via QMD (it's already indexed)
    const doc = await this.store.get(notePath, { includeBody: true });
    if (!doc || !('filepath' in doc)) {
      throw new Error(`Note not found in index: ${notePath}. Try reindex_vault first.`);
    }

    const body = doc.body ?? '';
    if (!body.trim()) return [];

    // Use the note's own content as vector query — finds semantically similar notes
    const raw = await this.store.searchVector(body.slice(0, 2000), { limit: limit + 1 });

    return raw
      .filter(r => r.filepath !== notePath) // exclude self
      .slice(0, limit)
      .map(r => ({
        path: r.filepath,
        title: r.title ?? path.basename(r.filepath),
        score: r.score,
      }));
  }

  /**
   * Deep context fetch: get full content of the top-N notes related to a query.
   * Designed for agents that need to synthesise across multiple notes at once.
   */
  async getContextCluster(query: string, limit = 5): Promise<NoteWithContent[]> {
    if (!this.store) throw new Error('Search store not initialized');

    const results = await this.store.search({ query, limit, rerank: true });
    const out: NoteWithContent[] = [];

    for (const r of results) {
      const body = await this.store.getDocumentBody(r.file);
      out.push({
        path: r.file,
        title: r.title ?? path.basename(r.file),
        score: r.score,
        content: body ?? '',
      });
    }

    return out;
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
