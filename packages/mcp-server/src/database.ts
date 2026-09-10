import { setTimeout, setInterval, clearInterval } from "node:timers";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import {
  chunkMarkdown,
  countOrphanedEmbeddingsInDatabase,
  pruneOrphanedEmbeddingsInDatabase,
  titleFromPath,
  type MarkdownChunk,
  type PruneEmbeddingsResult,
  type SearchResult,
  type VaultNote
} from "@obsidian-mcp/shared";
import { sha256 } from "./hash.js";

export interface IndexStats {
  noteCount: number;
  chunkCount: number;
  embeddingCount: number;
  orphanedEmbeddingCount: number;
  lastIndexedAt: string | null;
}

export interface IndexedNote {
  path: string;
  title: string;
  mtime: number;
  size: number;
  tags: string[];
  aliases: string[];
  frontmatter: Record<string, unknown>;
  outlinks: string[];
  embeds: string[];
  backlinks: string[];
  contentHash: string;
  indexedAt: string;
}

export interface StoredChunk extends MarkdownChunk {
  id: number;
  contentHash: string;
}

export class VaultDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    const Database = loadBetterSqlite3();
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  stats(): IndexStats {
    const noteCount = this.db.prepare("SELECT COUNT(*) AS count FROM notes").get() as { count: number };
    const chunkCount = this.db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number };
    const embeddingCount = this.db.prepare("SELECT COUNT(*) AS count FROM embeddings").get() as { count: number };
    const orphanedEmbeddingCount = this.countOrphanedEmbeddings();
    const last = this.db.prepare("SELECT MAX(indexed_at) AS lastIndexedAt FROM notes").get() as { lastIndexedAt: string | null };
    return {
      noteCount: noteCount.count,
      chunkCount: chunkCount.count,
      embeddingCount: embeddingCount.count,
      orphanedEmbeddingCount,
      lastIndexedAt: last.lastIndexedAt
    };
  }

  replaceNotes(notes: VaultNote[]): void {
    const seen = new Set(notes.map((note) => note.path));
    const tx = this.db.transaction((items: VaultNote[]) => {
      for (const note of items) {
        this.upsertNote(note);
      }
      const existing = this.db.prepare("SELECT path FROM notes").all() as Array<{ path: string }>;
      for (const row of existing) {
        if (!seen.has(row.path)) {
          this.deleteNote(row.path);
        }
      }
    });
    tx(notes);
  }

  upsertNote(note: VaultNote): void {
    this.db.transaction(() => this.writeNote(note)).immediate();
  }

  private writeNote(note: VaultNote): void {
    const contentHash = note.revision ?? sha256(note.content);
    const indexedAt = new Date().toISOString();
    const metadata = note.metadata;

    this.db
      .prepare(
        `INSERT INTO notes (
          path, title, mtime, size, content_hash, content, tags_json, aliases_json,
          frontmatter_json, outlinks_json, embeds_json, backlinks_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          title = excluded.title,
          mtime = excluded.mtime,
          size = excluded.size,
          content_hash = excluded.content_hash,
          content = excluded.content,
          tags_json = excluded.tags_json,
          aliases_json = excluded.aliases_json,
          frontmatter_json = excluded.frontmatter_json,
          outlinks_json = excluded.outlinks_json,
          embeds_json = excluded.embeds_json,
          backlinks_json = excluded.backlinks_json,
          indexed_at = excluded.indexed_at`
      )
      .run(
        note.path,
        note.title || titleFromPath(note.path),
        note.mtime,
        note.size,
        contentHash,
        note.content,
        JSON.stringify(note.tags),
        JSON.stringify(note.aliases),
        JSON.stringify(note.frontmatter),
        JSON.stringify(metadata.outlinks),
        JSON.stringify(metadata.embeds),
        JSON.stringify(metadata.backlinks),
        indexedAt
      );

    this.db.prepare("DELETE FROM note_fts WHERE path = ?").run(note.path);
    this.db
      .prepare("INSERT INTO note_fts(path, title, content, tags) VALUES (?, ?, ?, ?)")
      .run(note.path, `${note.title} ${note.aliases.join(" ")}`, note.content, note.tags.join(" "));

    const old = this.db.prepare("SELECT content_hash FROM chunks WHERE path = ? ORDER BY chunk_index").all(note.path) as Array<{content_hash: string}>;
    const chunks = chunkMarkdown(note.path, note.content);
    if (old.length === chunks.length && chunks.every((chunk, i) => sha256(chunk.content) === old[i]?.content_hash)) return;
    this.db.prepare("DELETE FROM chunks WHERE path = ?").run(note.path);
    const insertChunk = this.db.prepare(
      "INSERT INTO chunks(path, chunk_index, heading, content, content_hash) VALUES (?, ?, ?, ?, ?)"
    );
    for (const chunk of chunks) {
      insertChunk.run(chunk.path, chunk.index, chunk.heading, chunk.content, sha256(chunk.content));
    }
  }

  deleteNote(path: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM note_fts WHERE path = ?").run(path);
      this.db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
      this.db.prepare("DELETE FROM notes WHERE path = ?").run(path);
    }).immediate();
  }

  retainAllowed(paths: string[]): void {
    const allowed = new Set(paths);
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT path FROM notes").all() as Array<{path: string}>) {
        if (!allowed.has(row.path)) this.deleteNote(row.path);
      }
      this.pruneOrphanedEmbeddings();
    }).immediate();
  }

  async withSyncLock<T>(work: () => Promise<T>, lockId = 1): Promise<T> {
    const owner = `${process.pid}:${Math.random()}`;
    const acquire = this.db.prepare("INSERT INTO sync_lock(id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE sync_lock.expires < ?");
    const deadline = Date.now() + 30000;
    while (!acquire.run(lockId, owner, Date.now() + 60000, Date.now()).changes) {
      if (Date.now() > deadline) throw new Error("Another client is synchronizing this index. Try again shortly.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const heartbeat = setInterval(() => this.db.prepare("UPDATE sync_lock SET expires=? WHERE owner=?").run(Date.now() + 60000, owner), 10000);
    heartbeat.unref();
    try { return await work(); }
    finally {
      clearInterval(heartbeat);
      this.db.prepare("DELETE FROM sync_lock WHERE owner=?").run(owner);
    }
  }

  listNotes(options: { query?: string; tag?: string; folder?: string; limit: number; offset: number }): IndexedNote[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.folder) {
      where.push("(path = ? OR path LIKE ?)");
      params.push(options.folder, `${options.folder}/%`);
    }
    if (options.tag) {
      where.push("tags_json LIKE ?");
      params.push(`%"${options.tag.replace(/^#/, "").toLowerCase()}"%`);
    }
    if (options.query) {
      where.push("(title LIKE ? OR path LIKE ?)");
      params.push(`%${options.query}%`, `%${options.query}%`);
    }
    params.push(options.limit, options.offset);
    const rows = this.db
      .prepare(
        `SELECT * FROM notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY mtime DESC LIMIT ? OFFSET ?`
      )
      .all(...params) as NoteRow[];
    return rows.map(fromNoteRow);
  }

  getNote(path: string): (IndexedNote & { content: string }) | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE path = ?").get(path) as NoteRow | undefined;
    return row ? { ...fromNoteRow(row), content: row.content } : null;
  }

  searchFts(query: string, limit: number, offset: number): SearchResult[] {
    const match = toFtsQuery(query);
    if (!match) {
      return [];
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT n.path, n.title, n.mtime, n.tags_json, bm25(note_fts, 0, 8, 1, 3) AS score,
            snippet(note_fts, 2, '[', ']', '...', 18) AS snippet
           FROM note_fts JOIN notes n ON n.path = note_fts.path
           WHERE note_fts MATCH ?
           ORDER BY CASE WHEN lower(n.title) = lower(?) OR EXISTS (SELECT 1 FROM json_each(n.aliases_json) WHERE lower(value) = lower(?)) THEN 0 ELSE 1 END, score ASC, n.path ASC LIMIT ? OFFSET ?`
        )
        .all(match, query.replace(/^"|"$/g, ""), query.replace(/^"|"$/g, ""), limit, offset) as Array<{ path: string; title: string; mtime: number; tags_json: string; score: number; snippet: string }>;
      return rows.map((row) => ({
        path: row.path,
        title: row.title,
        mtime: row.mtime,
        tags: parseJson<string[]>(row.tags_json, []),
        score: Number.isFinite(row.score) ? -row.score : 0,
        snippet: row.snippet
      }));
    } catch {
      const rows = this.db
        .prepare(
          `SELECT path, title, mtime, tags_json, content
           FROM notes WHERE content LIKE ? OR title LIKE ?
           ORDER BY mtime DESC LIMIT ? OFFSET ?`
        )
        .all(`%${query}%`, `%${query}%`, limit, offset) as Array<{
        path: string;
        title: string;
        mtime: number;
        tags_json: string;
        content: string;
      }>;
      return rows.map((row, index) => ({
        path: row.path,
        title: row.title,
        mtime: row.mtime,
        tags: parseJson<string[]>(row.tags_json, []),
        score: index,
        snippet: row.content.slice(0, 360).replace(/\s+/g, " ")
      }));
    }
  }

  relatedNotes(path: string, limit: number): SearchResult[] {
    const note = this.getNote(path);
    if (!note) {
      return [];
    }
    const candidates = this.listNotes({ limit: 1000, offset: 0 });
    const noteTags = new Set(note.tags);
    const linked = new Set([...note.outlinks, ...note.backlinks]);
    return candidates
      .filter((candidate) => candidate.path !== path)
      .map((candidate) => {
        const sharedTags = candidate.tags.filter((tag) => noteTags.has(tag)).length;
        const linkScore = linked.has(candidate.path) || linked.has(candidate.title) ? 3 : 0;
        return {
          path: candidate.path,
          title: candidate.title,
          mtime: candidate.mtime,
          tags: candidate.tags,
          score: linkScore + sharedTags,
          snippet: `Shared tags: ${sharedTags}; linked: ${linkScore > 0 ? "yes" : "no"}`
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.mtime - a.mtime)
      .slice(0, limit);
  }

  chunksMissingEmbeddings(provider: string, model: string, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.* FROM chunks c
         LEFT JOIN embeddings e ON e.content_hash = c.content_hash AND e.provider = ? AND e.model = ?
         WHERE e.content_hash IS NULL
         ORDER BY c.path, c.chunk_index
         LIMIT ?`
      )
      .all(provider, model, limit) as ChunkRow[];
    return rows.map(fromChunkRow);
  }

  upsertEmbedding(contentHash: string, provider: string, model: string, vector: number[]): void {
    this.db
      .prepare(
        `INSERT INTO embeddings(content_hash, provider, model, vector_json, dim, updated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE content_hash = ?)
         ON CONFLICT(content_hash, provider, model) DO UPDATE SET
           vector_json = excluded.vector_json,
           dim = excluded.dim,
           updated_at = excluded.updated_at`
      )
      .run(contentHash, provider, model, JSON.stringify(vector), vector.length, new Date().toISOString(), contentHash);
  }

  pruneOrphanedEmbeddings(): PruneEmbeddingsResult {
    return this.db.transaction(() => pruneOrphanedEmbeddingsInDatabase(this.db)).immediate();
  }

  semanticSearch(queryVector: number[], provider: string, model: string, limit: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.path, c.heading, c.content, e.vector_json, n.title, n.mtime, n.tags_json
         FROM embeddings e
         JOIN chunks c ON c.content_hash = e.content_hash
         JOIN notes n ON n.path = c.path
         WHERE e.provider = ? AND e.model = ?`
      )
      .all(provider, model) as Array<{
      path: string;
      heading: string | null;
      content: string;
      vector_json: string;
      title: string;
      mtime: number;
      tags_json: string;
    }>;

    if (rows.some(row => (parseJson<number[]>(row.vector_json, [])).length !== queryVector.length)) {
      this.db.prepare("DELETE FROM embeddings WHERE provider = ? AND model = ?").run(provider, model);
      throw new Error("Embedding dimensions changed. Cached vectors were reset; background indexing or Refresh index will rebuild them. Standard search remains available.");
    }
    const ranked = rows
      .map((row) => {
        const vector = parseJson<number[]>(row.vector_json, []);
        return {
          path: row.path,
          title: row.title,
          mtime: row.mtime,
          tags: parseJson<string[]>(row.tags_json, []),
          score: cosineSimilarity(queryVector, vector),
          heading: row.heading,
          snippet: `${row.heading ? `${row.heading}: ` : ""}${row.content.slice(0, 360).replace(/\s+/g, " ")}`
        };
      })
      .sort((a, b) => b.score - a.score);
    const unique = new Map<string, SearchResult>();
    for (const item of ranked) {
      const existing = unique.get(item.path);
      if (!existing) unique.set(item.path, { ...item, passages: [{ heading: item.heading ?? null, text: item.snippet }] });
      else if ((existing.passages?.length ?? 0) < 3) existing.passages?.push({ heading: item.heading ?? null, text: item.snippet });
    }
    return [...unique.values()].slice(0, limit);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_lock (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (
        path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        frontmatter_json TEXT NOT NULL,
        outlinks_json TEXT NOT NULL,
        embeds_json TEXT NOT NULL,
        backlinks_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS note_fts
      USING fts5(path UNINDEXED, title, content, tags, tokenize = 'unicode61');

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        UNIQUE(path, chunk_index)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

      CREATE TABLE IF NOT EXISTS embeddings (
        content_hash TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        dim INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(content_hash, provider, model)
      );
    `);
  }

  private embeddingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM embeddings").get() as { count: number }).count;
  }

  private countOrphanedEmbeddings(): number {
    return countOrphanedEmbeddingsInDatabase(this.db);
  }
}

function loadBetterSqlite3(): typeof Database {
  try {
    const requireFn = getRequire();
    return requireFn("better-sqlite3") as typeof Database;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(
        "SQLite runtime dependency better-sqlite3 is not installed. Open MCP Vault Bridge plugin settings, click Check runtime, then click Install SQLite runtime. After installation, restart or reload the MCP server in Claude Desktop or LM Studio."
      );
    }
    throw error;
  }
}

function isModuleNotFoundError(error: unknown): error is Error & { code: "MODULE_NOT_FOUND" } {
  return error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND";
}

function getRequire(): NodeJS.Require {
  try {
    if (typeof __filename !== "undefined") {
      return createRequire(__filename);
    }
  } catch {
    // Fall through to the ESM/test fallback below.
  }
  return createRequire(`${process.cwd()}/noop.js`);
}

interface NoteRow {
  path: string;
  title: string;
  mtime: number;
  size: number;
  content_hash: string;
  content: string;
  tags_json: string;
  aliases_json: string;
  frontmatter_json: string;
  outlinks_json: string;
  embeds_json: string;
  backlinks_json: string;
  indexed_at: string;
}

interface ChunkRow {
  id: number;
  path: string;
  chunk_index: number;
  heading: string | null;
  content: string;
  content_hash: string;
}

function fromNoteRow(row: NoteRow): IndexedNote {
  return {
    path: row.path,
    title: row.title,
    mtime: row.mtime,
    size: row.size,
    tags: parseJson<string[]>(row.tags_json, []),
    aliases: parseJson<string[]>(row.aliases_json, []),
    frontmatter: parseJson<Record<string, unknown>>(row.frontmatter_json, {}),
    outlinks: parseJson<string[]>(row.outlinks_json, []),
    embeds: parseJson<string[]>(row.embeds_json, []),
    backlinks: parseJson<string[]>(row.backlinks_json, []),
    contentHash: row.content_hash,
    indexedAt: row.indexed_at
  };
}

function fromChunkRow(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    path: row.path,
    index: row.chunk_index,
    heading: row.heading,
    content: row.content,
    contentHash: row.content_hash
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toFtsQuery(query: string): string {
  const phrases = query.match(/"[^"]+"|[\p{L}\p{N}_/-]+/gu) ?? [];
  return phrases.map(term => term.startsWith('"') ? term : `"${term}"*`).join(" OR ");
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  if (a.some(value => !Number.isFinite(value)) || b.some(value => !Number.isFinite(value))) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  if (aMag === 0 || bMag === 0) {
    return 0;
  }
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
