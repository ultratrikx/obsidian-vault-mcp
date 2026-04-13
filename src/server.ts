#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'http';
import { z } from 'zod';
import { Vault } from './vault.js';
import { VaultSearch } from './search.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const VAULT_PATH = process.env.VAULT_PATH;
const QMD_DB_PATH =
  process.env.QMD_DB_PATH ??
  new URL('../qmd-index/vault.db', import.meta.url).pathname;
const MCP_PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);
const USE_HTTP = process.argv.includes('--http');
const API_KEY = process.env.API_KEY ?? '';

if (!VAULT_PATH) {
  process.stderr.write('ERROR: VAULT_PATH environment variable is required\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  // --- Search & discovery ---
  {
    name: 'search_vault',
    description: 'Hybrid semantic + keyword search (BM25 + vector + LLM reranking). Best for finding specific notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'], default: 'hybrid' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_connections',
    description: 'Find notes semantically connected to a concept, idea, or phrase. Returns notes with relevant snippets — optimised for discovering related thinking, not finding a specific note.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Concept, idea, or question to find connections for' },
        limit: { type: 'number', description: 'Max results (default 15)', default: 15 },
      },
      required: ['query'],
    },
  },
  {
    name: 'explore_concept',
    description: 'Deep-dive a concept using QMD query expansion. Runs lexical, semantic, and hypothetical angles simultaneously and returns a multi-perspective map of how the concept appears across your vault. Ideal for agents synthesising your thinking on a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: 'Concept or topic to explore' },
        results_per_angle: { type: 'number', description: 'Results per search angle (default 5)', default: 5 },
      },
      required: ['concept'],
    },
  },
  {
    name: 'get_related_notes',
    description: 'Find notes semantically related to a specific note using its content as the embedding query. Surfaces conceptually connected notes even without explicit links.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the note' },
        limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_context_cluster',
    description: 'Fetch full content of the top notes related to a query. Returns complete note bodies — designed for agents that need to read and synthesise across multiple notes at once.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Topic or question' },
        limit: { type: 'number', description: 'Number of notes to fetch in full (default 5, max 10)', default: 5 },
      },
      required: ['query'],
    },
  },
  // --- Note reading ---
  {
    name: 'get_note',
    description: 'Read the full content of a note by vault-relative path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_backlinks',
    description: 'Find all notes that contain a [[wikilink]] pointing to a given note.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path or note name to find backlinks for' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_notes',
    description: 'List notes in the vault, optionally filtered by glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', default: '**/*.md' },
      },
    },
  },
  {
    name: 'get_vault_tree',
    description: 'Return the vault directory structure as a tree.',
    inputSchema: {
      type: 'object',
      properties: {
        max_depth: { type: 'number', default: 4 },
      },
    },
  },
  // --- Note writing ---
  {
    name: 'create_note',
    description: 'Create a new note with given content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_to_note',
    description: 'Append content to the end of a note. Creates the note if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'prepend_to_note',
    description: 'Insert content at the start of a note body, after YAML frontmatter if present.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'update_note',
    description: 'Overwrite a note\'s entire content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Permanently delete a note.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'move_note',
    description: 'Move or rename a note.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['from', 'to'],
    },
  },
  // --- Templates ---
  {
    name: 'list_templates',
    description: 'List all available templates in the Templates/ folder.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_from_template',
    description: 'Create a new note from a template. Substitutes {{date}}, {{time}}, {{title}}, and any custom variables.',
    inputSchema: {
      type: 'object',
      properties: {
        template_name: { type: 'string', description: 'Template filename without .md (e.g. "Meeting Note Template")' },
        note_path: { type: 'string', description: 'Vault-relative path for the new note' },
        vars: {
          type: 'object',
          description: 'Extra template variables to substitute (e.g. {"title": "My Note"})',
          additionalProperties: { type: 'string' },
        },
        overwrite: { type: 'boolean', default: false },
      },
      required: ['template_name', 'note_path'],
    },
  },
  {
    name: 'get_daily_note',
    description: 'Get or create the daily note for today (or a specific date). Uses Daily Note Template if available.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date string YYYY-MM-DD (default: today)' },
      },
    },
  },
  // --- Index ---
  {
    name: 'get_search_status',
    description: 'Get QMD index status: how many notes are indexed and embedded.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reindex_vault',
    description: 'Manually trigger vault reindex + re-embed.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Zod schemas for tool inputs
// ---------------------------------------------------------------------------
const SearchInput = z.object({
  query: z.string(),
  limit: z.number().min(1).max(50).default(10),
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
});
const FindConnectionsInput = z.object({
  query: z.string(),
  limit: z.number().min(1).max(50).default(15),
});
const ExploreConceptInput = z.object({
  concept: z.string(),
  results_per_angle: z.number().min(1).max(20).default(5),
});
const GetRelatedInput = z.object({
  path: z.string(),
  limit: z.number().min(1).max(30).default(10),
});
const GetContextClusterInput = z.object({
  query: z.string(),
  limit: z.number().min(1).max(10).default(5),
});
const GetNoteInput = z.object({ path: z.string() });
const GetBacklinksInput = z.object({ path: z.string() });
const ListNotesInput = z.object({ pattern: z.string().default('**/*.md') });
const TreeInput = z.object({ max_depth: z.number().min(1).max(10).default(4) });
const CreateNoteInput = z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().default(false),
});
const AppendInput = z.object({ path: z.string(), content: z.string() });
const PrependInput = z.object({ path: z.string(), content: z.string() });
const UpdateNoteInput = z.object({ path: z.string(), content: z.string() });
const DeleteNoteInput = z.object({ path: z.string() });
const MoveNoteInput = z.object({
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().default(false),
});
const CreateFromTemplateInput = z.object({
  template_name: z.string(),
  note_path: z.string(),
  vars: z.record(z.string()).default({}),
  overwrite: z.boolean().default(false),
});
const GetDailyNoteInput = z.object({
  date: z.string().optional(),
});

// ---------------------------------------------------------------------------
// MCP server factory — must be called fresh per HTTP request (stateless mode)
// ---------------------------------------------------------------------------
function makeMCPServer(vault: Vault, search: VaultSearch): Server {
  const server = new Server(
    { name: 'obsidian-vault-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        // --- Search & discovery ---
        case 'search_vault': {
          const { query, limit, mode } = SearchInput.parse(args);
          let results;
          if (mode === 'keyword') results = await search.searchKeyword(query, limit);
          else if (mode === 'semantic') results = await search.searchSemantic(query, limit);
          else results = await search.search(query, limit);
          return { content: [{ type: 'text', text: formatResults(results) }] };
        }

        case 'find_connections': {
          const { query, limit } = FindConnectionsInput.parse(args);
          const results = await search.findConnections(query, limit);
          return { content: [{ type: 'text', text: formatResults(results) }] };
        }

        case 'explore_concept': {
          const { concept, results_per_angle } = ExploreConceptInput.parse(args);
          const exploration = await search.exploreConcept(concept, results_per_angle);
          const lines: string[] = [`# Concept exploration: "${exploration.concept}"\n`];

          for (const angle of exploration.angles) {
            lines.push(`## ${angle.type} angle\nQuery: _"${angle.query}"_`);
            if (angle.results.length === 0) {
              lines.push('No results.\n');
            } else {
              lines.push(angle.results.map((r, i) =>
                `${i + 1}. **${r.title}** (${(r.score * 100).toFixed(1)}%) — \`${r.path}\``
              ).join('\n'));
            }
            lines.push('');
          }

          lines.push(`## Top notes across all angles`);
          lines.push(exploration.topNotes.map((r, i) =>
            `${i + 1}. **${r.title}** (${(r.score * 100).toFixed(1)}%) — \`${r.path}\``
          ).join('\n'));

          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        case 'get_related_notes': {
          const { path, limit } = GetRelatedInput.parse(args);
          const results = await search.getRelatedForNote(path, limit);
          if (results.length === 0) return { content: [{ type: 'text', text: 'No related notes found.' }] };
          return { content: [{ type: 'text', text: formatResults(results) }] };
        }

        case 'get_context_cluster': {
          const { query, limit } = GetContextClusterInput.parse(args);
          const notes = await search.getContextCluster(query, limit);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No notes found.' }] };
          const text = notes.map(n =>
            `# ${n.title} (${(n.score * 100).toFixed(1)}%)\nPath: \`${n.path}\`\n\n${n.content}`
          ).join('\n\n---\n\n');
          return { content: [{ type: 'text', text: text }] };
        }

        // --- Note reading ---
        case 'get_note': {
          const { path } = GetNoteInput.parse(args);
          const content = await vault.read(path);
          return { content: [{ type: 'text', text: content }] };
        }

        case 'get_backlinks': {
          const { path } = GetBacklinksInput.parse(args);
          const links = await vault.getBacklinks(path);
          if (links.length === 0) return { content: [{ type: 'text', text: `No backlinks found for: ${path}` }] };
          return { content: [{ type: 'text', text: `${links.length} backlinks to "${path}":\n\n${links.join('\n')}` }] };
        }

        case 'list_notes': {
          const { pattern } = ListNotesInput.parse(args);
          const notes = await vault.list(pattern);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No notes found.' }] };
          const text = notes
            .map(n => `${n.path}  (${formatBytes(n.size)}, ${n.modified.toISOString().slice(0, 10)})`)
            .join('\n');
          return { content: [{ type: 'text', text: `${notes.length} notes:\n\n${text}` }] };
        }

        case 'get_vault_tree': {
          const { max_depth } = TreeInput.parse(args);
          const tree = await vault.tree(max_depth);
          return { content: [{ type: 'text', text: tree }] };
        }

        // --- Note writing ---
        case 'create_note': {
          const { path, content, overwrite } = CreateNoteInput.parse(args);
          await vault.write(path, content, overwrite);
          return { content: [{ type: 'text', text: `Created: ${path}` }] };
        }

        case 'append_to_note': {
          const { path, content } = AppendInput.parse(args);
          await vault.append(path, content);
          return { content: [{ type: 'text', text: `Appended to: ${path}` }] };
        }

        case 'prepend_to_note': {
          const { path, content } = PrependInput.parse(args);
          await vault.prepend(path, content);
          return { content: [{ type: 'text', text: `Prepended to: ${path}` }] };
        }

        case 'update_note': {
          const { path, content } = UpdateNoteInput.parse(args);
          await vault.write(path, content, true);
          return { content: [{ type: 'text', text: `Updated: ${path}` }] };
        }

        case 'delete_note': {
          const { path } = DeleteNoteInput.parse(args);
          await vault.delete(path);
          return { content: [{ type: 'text', text: `Deleted: ${path}` }] };
        }

        case 'move_note': {
          const { from, to, overwrite } = MoveNoteInput.parse(args);
          await vault.move(from, to, overwrite);
          return { content: [{ type: 'text', text: `Moved: ${from} → ${to}` }] };
        }

        // --- Templates ---
        case 'list_templates': {
          const templates = await vault.listTemplates();
          if (templates.length === 0) return { content: [{ type: 'text', text: 'No templates found.' }] };
          const text = templates.map(t => `- ${t.name}  (${t.path})`).join('\n');
          return { content: [{ type: 'text', text: `${templates.length} templates:\n\n${text}` }] };
        }

        case 'create_from_template': {
          const { template_name, note_path, vars, overwrite } = CreateFromTemplateInput.parse(args);
          await vault.createFromTemplate(template_name, note_path, vars, overwrite);
          return { content: [{ type: 'text', text: `Created from template "${template_name}": ${note_path}` }] };
        }

        case 'get_daily_note': {
          const { date } = GetDailyNoteInput.parse(args);
          const d = date ? new Date(date) : new Date();
          const { path, content, created } = await vault.getDailyNote(d);
          const status = created ? 'Created' : 'Existing';
          return { content: [{ type: 'text', text: `${status} daily note: ${path}\n\n${content}` }] };
        }

        // --- Index ---
        case 'get_search_status': {
          const status = await search.getIndexStatus();
          return {
            content: [{ type: 'text', text: `Indexed: ${status.indexed} notes  |  Needs embedding: ${status.needsEmbedding}` }],
          };
        }

        case 'reindex_vault': {
          await search.reindex();
          const status = await search.getIndexStatus();
          return {
            content: [{ type: 'text', text: `Reindex complete. Indexed: ${status.indexed}, Needs embedding: ${status.needsEmbedding}` }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const vault = new Vault(VAULT_PATH!);
  const search = new VaultSearch(VAULT_PATH!, QMD_DB_PATH);

  // Init search index (non-blocking — server starts immediately)
  search.init().catch(err => {
    process.stderr.write(`[WARN] Search init error: ${err}\n`);
  });

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  if (USE_HTTP) {
    if (!API_KEY) {
      process.stderr.write('[WARN] API_KEY is not set — HTTP server is unauthenticated\n');
    }

    const httpServer = createServer((req, res) => {
      // Auth: accept Bearer token in Authorization header OR ?token= query param
      if (API_KEY) {
        const authHeader = req.headers['authorization'] ?? '';
        const url = new URL(req.url ?? '/', `http://localhost`);
        const queryToken = url.searchParams.get('token') ?? '';
        const validHeader = authHeader === `Bearer ${API_KEY}`;
        const validQuery = queryToken === API_KEY;
        if (!validHeader && !validQuery) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Fresh server + transport per request — required by MCP SDK stateless mode.
      // (Stateless transport throws if reused; Server throws if connected twice.)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = makeMCPServer(vault, search);

      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        let parsedBody: unknown;
        if (chunks.length > 0) {
          try {
            parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Non-JSON body (e.g. GET requests) — pass undefined
          }
        }
        server.connect(transport)
          .then(() => transport.handleRequest(req, res, parsedBody))
          .catch(err => {
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(String(err));
            }
          });
      });
    });

    httpServer.listen(MCP_PORT, () => {
      process.stderr.write(`[INFO] MCP HTTP server listening on port ${MCP_PORT}\n`);
    });

    process.on('SIGINT', async () => {
      await search.close();
      httpServer.close();
      process.exit(0);
    });
  } else {
    const transport = new StdioServerTransport();
    const server = makeMCPServer(vault, search);
    await server.connect(transport);
    process.stderr.write('[INFO] MCP stdio server started\n');

    process.on('SIGINT', async () => {
      await search.close();
      process.exit(0);
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatResults(results: { path: string; title: string; score: number; snippet?: string }[]): string {
  if (results.length === 0) return 'No results found.';
  return results.map((r, i) =>
    `${i + 1}. **${r.title}** (${(r.score * 100).toFixed(1)}%)\n   \`${r.path}\`${r.snippet ? `\n   ${r.snippet}` : ''}`
  ).join('\n\n');
}

main().catch(err => {
  process.stderr.write(`[FATAL] ${err}\n`);
  process.exit(1);
});
