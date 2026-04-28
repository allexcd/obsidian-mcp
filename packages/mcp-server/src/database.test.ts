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

