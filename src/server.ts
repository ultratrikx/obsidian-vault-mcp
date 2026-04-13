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
  {
    name: 'search_vault',
    description:
      'Hybrid semantic + keyword search across the entire Obsidian vault using QMD (BM25 + vector embeddings + LLM reranking). Best for natural language queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)', default: 10 },
        mode: {
          type: 'string',
          enum: ['hybrid', 'keyword', 'semantic'],
          description: 'Search mode (default: hybrid)',
          default: 'hybrid',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description: 'Read the full content of a note by its vault-relative path (e.g. "folder/note.md").',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the note' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_notes',
    description: 'List notes in the vault. Optionally filter with a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern relative to vault root (default: **/*.md)',
          default: '**/*.md',
        },
      },
    },
  },
  {
    name: 'get_vault_tree',
    description: 'Return the vault directory tree as a formatted string, like the `tree` command.',
    inputSchema: {
      type: 'object',
      properties: {
        max_depth: {
          type: 'number',
          description: 'Maximum depth to show (default: 4)',
          default: 4,
        },
      },
    },
  },
  {
    name: 'create_note',
    description: 'Create a new note. Fails if the note already exists unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path (e.g. "folder/note.md")' },
        content: { type: 'string', description: 'Markdown content of the note' },
        overwrite: { type: 'boolean', description: 'Overwrite if exists (default: false)', default: false },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'update_note',
    description: 'Overwrite or append to a note. Use mode="overwrite" to replace all content, mode="append" to add to the end.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the note' },
        content: { type: 'string', description: 'Content to write or append' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'Write mode (default: overwrite)',
          default: 'overwrite',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Permanently delete a note from the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Vault-relative path to the note' },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_note',
    description: 'Move or rename a note within the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source vault-relative path' },
        to: { type: 'string', description: 'Destination vault-relative path' },
        overwrite: { type: 'boolean', description: 'Overwrite destination if exists (default: false)', default: false },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_search_status',
    description: 'Get the status of the QMD search index: how many notes are indexed and embedded.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reindex_vault',
    description: 'Trigger a manual reindex and re-embed of the vault. Useful after bulk changes.',
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
const GetNoteInput = z.object({ path: z.string() });
const ListNotesInput = z.object({ pattern: z.string().default('**/*.md') });
const TreeInput = z.object({ max_depth: z.number().min(1).max(10).default(4) });
const CreateNoteInput = z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().default(false),
});
const UpdateNoteInput = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['overwrite', 'append']).default('overwrite'),
});
const DeleteNoteInput = z.object({ path: z.string() });
const MoveNoteInput = z.object({
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().default(false),
});

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

  const server = new Server(
    { name: 'obsidian-vault-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case 'search_vault': {
          const { query, limit, mode } = SearchInput.parse(args);
          let results;
          if (mode === 'keyword') results = await search.searchKeyword(query, limit);
          else if (mode === 'semantic') results = await search.searchSemantic(query, limit);
          else results = await search.search(query, limit);

          const text = results.length === 0
            ? 'No results found.'
            : results.map((r, i) =>
                `${i + 1}. **${r.title}** (${(r.score * 100).toFixed(1)}%)\n   Path: ${r.path}${r.snippet ? `\n   ${r.snippet}` : ''}`
              ).join('\n\n');
          return { content: [{ type: 'text', text }] };
        }

        case 'get_note': {
          const { path } = GetNoteInput.parse(args);
          const content = await vault.read(path);
          return { content: [{ type: 'text', text: content }] };
        }

        case 'list_notes': {
          const { pattern } = ListNotesInput.parse(args);
          const notes = await vault.list(pattern);
          if (notes.length === 0) return { content: [{ type: 'text', text: 'No notes found.' }] };
          const text = notes
            .map(n => `${n.path}  (${formatBytes(n.size)}, modified ${n.modified.toISOString().slice(0, 10)})`)
            .join('\n');
          return { content: [{ type: 'text', text: `${notes.length} notes:\n\n${text}` }] };
        }

        case 'get_vault_tree': {
          const { max_depth } = TreeInput.parse(args);
          const tree = await vault.tree(max_depth);
          return { content: [{ type: 'text', text: tree }] };
        }

        case 'create_note': {
          const { path, content, overwrite } = CreateNoteInput.parse(args);
          await vault.write(path, content, overwrite);
          return { content: [{ type: 'text', text: `Created: ${path}` }] };
        }

        case 'update_note': {
          const { path, content, mode } = UpdateNoteInput.parse(args);
          if (mode === 'append') await vault.append(path, content);
          else await vault.write(path, content, true);
          return { content: [{ type: 'text', text: `Updated (${mode}): ${path}` }] };
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

        case 'get_search_status': {
          const status = await search.getIndexStatus();
          return {
            content: [{
              type: 'text',
              text: `Index status:\n  Indexed: ${status.indexed} notes\n  Needs embedding: ${status.needsEmbedding}`,
            }],
          };
        }

        case 'reindex_vault': {
          await search.reindex();
          const status = await search.getIndexStatus();
          return {
            content: [{
              type: 'text',
              text: `Reindex complete. Indexed: ${status.indexed}, Needs embedding: ${status.needsEmbedding}`,
            }],
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

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------
  if (USE_HTTP) {
    if (!API_KEY) {
      process.stderr.write('[WARN] API_KEY is not set — HTTP server is unauthenticated\n');
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const httpServer = createServer((req, res) => {
      // Bearer token auth — only enforced when API_KEY is set
      if (API_KEY) {
        const authHeader = req.headers['authorization'] ?? '';
        if (authHeader !== `Bearer ${API_KEY}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
      transport.handleRequest(req, res).catch(err => {
        res.writeHead(500);
        res.end(String(err));
      });
    });
    await server.connect(transport);
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

main().catch(err => {
  process.stderr.write(`[FATAL] ${err}\n`);
  process.exit(1);
});
