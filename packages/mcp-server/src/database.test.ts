import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VaultNote } from "@obsidian-mcp/shared";
import { VaultDatabase } from "./database.js";

describe("VaultDatabase", () => {
  it("indexes notes into SQLite and searches with FTS", () => {
    const db = new VaultDatabase(join(mkdtempSync(join(tmpdir(), "obsidian-mcp-")), "index.sqlite"));
    db.replaceNotes([
      makeNote("Projects/Alpha.md", "# Alpha\nThis note mentions rocket engines.", ["project"]),
      makeNote("Knowledge/Beta.md", "# Beta\nGardening and soil notes.", ["garden"])
    ]);

    expect(db.stats().noteCount).toBe(2);
    expect(db.searchFts("rocket", 10, 0)[0]?.path).toBe("Projects/Alpha.md");
    expect(db.listNotes({ tag: "garden", limit: 10, offset: 0 })).toHaveLength(1);
    db.close();
  });

  it("deletes stale notes on replace", () => {
    const db = new VaultDatabase(join(mkdtempSync(join(tmpdir(), "obsidian-mcp-")), "index.sqlite"));
    db.replaceNotes([makeNote("A.md", "one", [])]);
    db.replaceNotes([makeNote("B.md", "two", [])]);
    expect(db.getNote("A.md")).toBeNull();
    expect(db.getNote("B.md")?.content).toBe("two");
    db.close();
  });

  it("prunes orphaned embeddings while preserving current embeddings", () => {
    const db = new VaultDatabase(join(mkdtempSync(join(tmpdir(), "obsidian-mcp-")), "index.sqlite"));
    db.replaceNotes([makeNote("A.md", "# A\nold content", [])]);
    const [oldChunk] = db.chunksMissingEmbeddings("test", "model", 10);
    expect(oldChunk).toBeDefined();
    db.upsertEmbedding(oldChunk!.contentHash, "test", "model", [1, 0, 0]);

    db.replaceNotes([makeNote("A.md", "# A\nnew content", [])]);
    const [newChunk] = db.chunksMissingEmbeddings("test", "model", 10);
    expect(newChunk).toBeDefined();
    db.upsertEmbedding(newChunk!.contentHash, "test", "model", [0, 1, 0]);

    expect(db.stats()).toMatchObject({
      embeddingCount: 2,
      orphanedEmbeddingCount: 1
    });

    const result = db.pruneOrphanedEmbeddings();

    expect(result).toMatchObject({
      beforeCount: 2,
      afterCount: 1,
      orphanedBeforeCount: 1,
      orphanedAfterCount: 0,
      deletedEmbeddings: 1
    });
    expect(result.estimatedBytesFreed).toBeGreaterThan(0);
    expect(db.stats()).toMatchObject({
      embeddingCount: 1,
      orphanedEmbeddingCount: 0
    });
    db.close();
  });
});

function makeNote(path: string, content: string, tags: string[]): VaultNote {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    mtime: Date.now(),
    size: content.length,
    tags,
    aliases: [],
    frontmatter: {},
    content,
    truncated: false,
    metadata: {
      path,
      title: path.replace(/\.md$/, ""),
      basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
      extension: "md",
      stat: { ctime: Date.now(), mtime: Date.now(), size: content.length },
      frontmatter: {},
      tags,
      aliases: [],
      outlinks: [],
      embeds: [],
      backlinks: []
    }
  };
}
