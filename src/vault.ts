import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

export interface NoteInfo {
  path: string;       // vault-relative path, e.g. "folder/note.md"
  size: number;
  modified: Date;
}

export class Vault {
  constructor(private readonly root: string) {
    if (!existsSync(root)) {
      throw new Error(`Vault path does not exist: ${root}`);
    }
  }

  /** Resolve a vault-relative path to an absolute path, rejecting traversals. */
  private resolve(relPath: string): string {
    const abs = path.resolve(this.root, relPath);
    if (!abs.startsWith(this.root + path.sep) && abs !== this.root) {
      throw new Error(`Path traversal rejected: ${relPath}`);
    }
    return abs;
  }

  /** Read a note. Returns the raw markdown string. */
  async read(relPath: string): Promise<string> {
    return fs.readFile(this.resolve(relPath), 'utf8');
  }

  /**
   * Write a note. Creates parent directories as needed.
   * If overwrite=false (default) and file exists, throws.
   */
  async write(relPath: string, content: string, overwrite = false): Promise<void> {
    const abs = this.resolve(relPath);
    if (!overwrite && existsSync(abs)) {
      throw new Error(`Note already exists: ${relPath}. Set overwrite=true to replace.`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  /** Append text to an existing note (creates it if missing). */
  async append(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, 'utf8');
  }

  /** Delete a note. */
  async delete(relPath: string): Promise<void> {
    await fs.unlink(this.resolve(relPath));
  }

  /** Move / rename a note. Creates parent dirs for destination. */
  async move(fromPath: string, toPath: string, overwrite = false): Promise<void> {
    const absFrom = this.resolve(fromPath);
    const absTo = this.resolve(toPath);
    if (!overwrite && existsSync(absTo)) {
      throw new Error(`Destination already exists: ${toPath}. Set overwrite=true to replace.`);
    }
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
  }

  /**
   * List notes matching a glob. Defaults to all .md files.
   * Returns vault-relative paths sorted alphabetically.
   */
  async list(globPattern = '**/*.md'): Promise<NoteInfo[]> {
    const { glob } = await import('fs/promises');
    const matches: NoteInfo[] = [];

    // Node 22+ has fs/promises glob
    let files: string[];
    try {
      const iter = (glob as unknown as (pattern: string, opts: object) => AsyncIterable<string>)(
        globPattern,
        { cwd: this.root }
      );
      files = [];
      for await (const f of iter) files.push(f);
    } catch {
      // Fallback: manual recursive walk if glob API unavailable
      files = await this.walk(this.root, globPattern);
    }

    for (const relFile of files) {
      // Skip .obsidian internals
      if (relFile.startsWith('.obsidian/') || relFile.startsWith('.obsidian\\')) continue;
      try {
        const stat = await fs.stat(path.join(this.root, relFile));
        matches.push({ path: relFile, size: stat.size, modified: stat.mtime });
      } catch {
        // File disappeared between glob and stat — skip
      }
    }

    return matches.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Recursive directory walk, returns vault-relative paths ending in .md */
  private async walk(dir: string, _pattern: string): Promise<string[]> {
    const results: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(this.root, abs);
      if (e.isDirectory()) {
        results.push(...(await this.walk(abs, _pattern)));
      } else if (e.name.endsWith('.md')) {
        results.push(rel);
      }
    }
    return results;
  }

  /**
   * Return a nested directory tree as a formatted string (like `tree`).
   * maxDepth prevents runaway output on huge vaults.
   */
  async tree(maxDepth = 4): Promise<string> {
    const lines: string[] = [path.basename(this.root) + '/'];
    await this.treeDir(this.root, '', 0, maxDepth, lines);
    return lines.join('\n');
  }

  private async treeDir(
    dir: string,
    prefix: string,
    depth: number,
    maxDepth: number,
    lines: string[]
  ): Promise<void> {
    if (depth >= maxDepth) {
      lines.push(`${prefix}  [truncated — max depth ${maxDepth}]`);
      return;
    }
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => {
        // Dirs first, then files
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      lines.push(`${prefix}${connector}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) {
        await this.treeDir(path.join(dir, e.name), childPrefix, depth + 1, maxDepth, lines);
      }
    }
  }

  get vaultRoot(): string {
    return this.root;
  }
}
