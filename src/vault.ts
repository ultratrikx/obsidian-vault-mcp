import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

export interface NoteInfo {
  path: string;       // vault-relative path, e.g. "folder/note.md"
  size: number;
  modified: Date;
}

export type FrontmatterValue = string | number | boolean | string[];

/** Builds a YAML frontmatter block from a key-value map. */
export function buildFrontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/** Extract the frontmatter block + remainder from a note's content. */
export function parseFrontmatter(content: string): {
  fields: Record<string, string>;
  body: string;
  raw: string; // the full ---...--- block including delimiters
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { fields: {}, body: content, raw: '' };

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) fields[key] = val;
  }
  return { fields, body: content.slice(match[0].length), raw: match[0] };
}

/** Inject / merge frontmatter into content. Replaces existing block if present. */
export function injectFrontmatter(
  content: string,
  extra: Record<string, FrontmatterValue>
): string {
  const { fields, body } = parseFrontmatter(content);
  // extra fields take priority, existing fields fill in gaps
  const merged = { ...fields, ...extra };
  return `${buildFrontmatter(merged)}\n${body}`;
}

export interface TemplateInfo {
  name: string;       // display name without .md
  path: string;       // vault-relative path
}

export class Vault {
  private readonly TEMPLATES_DIR = 'Templates';
  private readonly DAILY_DIR = 'daily';
  private readonly DAILY_TEMPLATE = 'Templates/Daily Note Template.md';

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

  /**
   * Create or overwrite a note with structured frontmatter.
   * - frontmatter: key-value pairs auto-serialised to YAML
   * - Auto-stamps `created` (new notes only) and `modified` (always) if not provided
   * - fileModifiedAt: if given, sets the filesystem mtime via utimes()
   */
  async writeNote(
    relPath: string,
    body: string,
    options: {
      frontmatter?: Record<string, FrontmatterValue>;
      overwrite?: boolean;
      fileModifiedAt?: Date;
    } = {}
  ): Promise<void> {
    const abs = this.resolve(relPath);
    const { overwrite = false, fileModifiedAt } = options;

    if (!overwrite && existsSync(abs)) {
      throw new Error(`Note already exists: ${relPath}. Set overwrite=true to replace.`);
    }

    const now = new Date();
    const nowStr = isoLocal(now);
    const isNew = !existsSync(abs);

    // Build frontmatter: user fields take priority, auto-stamps fill gaps
    const fm: Record<string, FrontmatterValue> = { ...options.frontmatter };
    if (!('created' in fm) && isNew) fm.created = nowStr;
    if (!('modified' in fm)) fm.modified = nowStr;

    const content = `${buildFrontmatter(fm)}\n\n${body}`;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');

    // Stamp filesystem mtime if requested
    if (fileModifiedAt) {
      await fs.utimes(abs, fileModifiedAt, fileModifiedAt);
    }
  }

  /**
   * Append text to an existing note (creates it if missing).
   * Automatically updates the `modified` field in frontmatter if present.
   */
  async append(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, content, 'utf8');
    await this.touchModified(abs);
  }

  /**
   * Set the filesystem mtime (and optionally update the `modified` frontmatter field)
   * on an existing note. Useful for backdating or syncing timestamps.
   */
  async touchNote(
    relPath: string,
    options: { date?: Date; updateFrontmatter?: boolean } = {}
  ): Promise<void> {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) throw new Error(`Note not found: ${relPath}`);
    const d = options.date ?? new Date();
    await fs.utimes(abs, d, d);
    if (options.updateFrontmatter !== false) {
      await this.touchModified(abs, d);
    }
  }

  /** Update the `modified` field in a note's frontmatter (internal helper). */
  private async touchModified(abs: string, date: Date = new Date()): Promise<void> {
    try {
      const existing = await fs.readFile(abs, 'utf8');
      const { raw } = parseFrontmatter(existing);
      if (!raw) return; // no frontmatter — nothing to update
      const updated = existing.replace(
        /^(modified:\s*).*$/m,
        `$1${isoLocal(date)}`
      );
      if (updated !== existing) await fs.writeFile(abs, updated, 'utf8');
    } catch { /* best-effort */ }
  }

  /**
   * Prepend content to a note, inserting after the YAML frontmatter block if present.
   * Creates the note if it doesn't exist.
   */
  async prepend(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });

    if (!existsSync(abs)) {
      await fs.writeFile(abs, content, 'utf8');
      return;
    }

    const existing = await fs.readFile(abs, 'utf8');
    // Detect and preserve frontmatter
    const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n/);
    if (fmMatch) {
      const fm = fmMatch[0];
      const body = existing.slice(fm.length);
      await fs.writeFile(abs, `${fm}\n${content}\n${body}`, 'utf8');
    } else {
      await fs.writeFile(abs, `${content}\n\n${existing}`, 'utf8');
    }
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
    const matches: NoteInfo[] = [];
    const files = await this.walk(this.root, globPattern);

    for (const relFile of files) {
      if (relFile.startsWith('.obsidian/') || relFile.startsWith('.obsidian\\')) continue;
      try {
        const stat = await fs.stat(path.join(this.root, relFile));
        matches.push({ path: relFile, size: stat.size, modified: stat.mtime });
      } catch { /* file disappeared */ }
    }

    return matches.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** List all templates in the Templates/ folder. */
  async listTemplates(): Promise<TemplateInfo[]> {
    const templatesAbs = this.resolve(this.TEMPLATES_DIR);
    if (!existsSync(templatesAbs)) return [];

    const files = await this.walk(templatesAbs, '**/*.md');
    return files.map(f => ({
      name: f.replace(/\.md$/, ''),
      path: path.join(this.TEMPLATES_DIR, f),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Render Obsidian template variables in content.
   * Supports: {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}}, {{title}},
   * and any custom vars passed in the map.
   */
  renderTemplate(content: string, vars: Record<string, string> = {}): string {
    const now = new Date();

    return content.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const k = key.trim();

      // Custom vars take priority
      if (k in vars) return vars[k];

      // Built-in: {{title}}
      if (k === 'title') return vars.title ?? '';

      // Built-in: {{date}} or {{date:FORMAT}}
      if (k === 'date' || k.startsWith('date:')) {
        const fmt = k.startsWith('date:') ? k.slice(5) : 'YYYY-MM-DD';
        return formatDate(now, fmt);
      }

      // Built-in: {{time}} or {{time:FORMAT}}
      if (k === 'time' || k.startsWith('time:')) {
        const fmt = k.startsWith('time:') ? k.slice(5) : 'HH:mm';
        return formatDate(now, fmt);
      }

      // Unrecognised — leave as-is
      return match;
    });
  }

  /**
   * Create a note from a named template.
   * templateName: filename without .md, relative to Templates/
   * notePath: vault-relative destination path
   * vars: extra template variables (title is auto-derived from notePath if omitted)
   */
  async createFromTemplate(
    templateName: string,
    notePath: string,
    vars: Record<string, string> = {},
    overwrite = false
  ): Promise<string> {
    // Normalise template path
    const tmplRel = templateName.endsWith('.md')
      ? path.join(this.TEMPLATES_DIR, templateName)
      : path.join(this.TEMPLATES_DIR, `${templateName}.md`);

    if (!existsSync(this.resolve(tmplRel))) {
      throw new Error(`Template not found: ${tmplRel}`);
    }

    const raw = await this.read(tmplRel);
    const title = vars.title ?? path.basename(notePath, '.md');
    const rendered = this.renderTemplate(raw, { title, ...vars });
    await this.write(notePath, rendered, overwrite);
    return rendered;
  }

  /**
   * Get vault-relative path for a daily note.
   * Uses format: daily/YYYYMMDD.md (matching existing vault convention).
   */
  getDailyNotePath(date: Date = new Date()): string {
    const d = formatDate(date, 'YYYYMMDD');
    return `${this.DAILY_DIR}/${d}.md`;
  }

  /**
   * Get or create today's daily note.
   * Returns { path, content, created } — created=false if it already existed.
   */
  async getDailyNote(date: Date = new Date()): Promise<{ path: string; content: string; created: boolean }> {
    const notePath = this.getDailyNotePath(date);
    const abs = this.resolve(notePath);

    if (existsSync(abs)) {
      return { path: notePath, content: await this.read(notePath), created: false };
    }

    // Create from daily template if it exists
    let content: string;
    if (existsSync(this.resolve(this.DAILY_TEMPLATE))) {
      content = await this.createFromTemplate('Daily Note Template', notePath, {
        title: formatDate(date, 'YYYY-MM-DD'),
        date: formatDate(date, 'YYYY-MM-DD'),
      });
    } else {
      content = `---\ndate: ${formatDate(date, 'YYYY-MM-DD')}\n---\n\n`;
      await this.write(notePath, content);
    }

    return { path: notePath, content, created: true };
  }

  /**
   * Find all notes that contain a [[wikilink]] referencing the given note name.
   * Returns vault-relative paths of notes that link to it.
   */
  async getBacklinks(noteName: string): Promise<string[]> {
    const bare = path.basename(noteName, '.md');
    // Match [[Note Name]] or [[Note Name|alias]] or [[folder/Note Name]]
    const pattern = new RegExp(`\\[\\[([^\\]]*\\/)?${escapeRegex(bare)}(\\|[^\\]]*)?\\]\\]`, 'i');

    const allNotes = await this.list();
    const backlinks: string[] = [];

    for (const note of allNotes) {
      if (note.path === noteName) continue;
      try {
        const content = await this.read(note.path);
        if (pattern.test(content)) backlinks.push(note.path);
      } catch { /* unreadable — skip */ }
    }

    return backlinks.sort();
  }

  /**
   * Return a nested directory tree as a formatted string (like `tree`).
   */
  async tree(maxDepth = 4): Promise<string> {
    const lines: string[] = [path.basename(this.root) + '/'];
    await this.treeDir(this.root, '', 0, maxDepth, lines);
    return lines.join('\n');
  }

  /** Recursive directory walk, returns paths relative to `dir` ending in .md */
  private async walk(dir: string, _pattern: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(dir === this.root ? this.root : dir, abs);
      if (e.isDirectory()) {
        const sub = await this.walk(abs, _pattern);
        results.push(...sub.map(s => path.join(e.name, s)));
      } else if (e.name.endsWith('.md')) {
        results.push(e.name);
      }
    }
    return results;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date using a simple subset of moment-style tokens. */
function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return fmt
    .replace('YYYY', String(d.getFullYear()))
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()))
    .replace('ss', pad(d.getSeconds()));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ISO-8601 local time string (no Z suffix — matches Obsidian's convention). */
function isoLocal(d: Date): string {
  return formatDate(d, 'YYYY-MM-DD') + 'T' + formatDate(d, 'HH:mm:ss');
}
