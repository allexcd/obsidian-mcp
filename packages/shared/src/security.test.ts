import { describe, expect, it } from "vitest";
import { isPathIncluded, normalizeVaultPath, normalizeVaultScope, parseDelimitedList, truncateText } from "./security.js";

describe("security helpers", () => {
  it("rejects traversal and URL-like paths", () => {
    expect(() => normalizeVaultPath("../secret.md")).toThrow(/traversal/i);
    expect(() => normalizeVaultPath("file:///tmp/secret.md")).toThrow(/URL-style/i);
  });

  it("includes regular markdown by default and denies hidden folders", () => {
    expect(isPathIncluded("Projects/Plan.md", [], { excludedFolders: [], excludedFiles: [], excludedTags: [] })).toBe(true);
    expect(isPathIncluded(".config-folder/config.md", [], { excludedFolders: [], excludedFiles: [], excludedTags: [] })).toBe(false);
    expect(isPathIncluded("Projects/Plan.md", [], { excludedFolders: ["Projects"], excludedFiles: [], excludedTags: [] })).toBe(false);
  });

  it("excludes by normalized tags and exact files", () => {
    expect(isPathIncluded("Inbox/Note.md", ["Knowledge"], { excludedFolders: [], excludedFiles: [], excludedTags: ["#knowledge"] })).toBe(false);
    expect(isPathIncluded("Inbox/Note.md", [], { excludedFolders: [], excludedFiles: ["Inbox/Note.md"], excludedTags: [] })).toBe(false);
    expect(isPathIncluded("Inbox/Other.md", [], { excludedFolders: [], excludedFiles: ["Inbox/Note.md"], excludedTags: [] })).toBe(true);
  });

  it("parses delimited settings and truncates safely", () => {
    expect(parseDelimitedList("A, B\nC")).toEqual(["A", "B", "C"]);
    expect(truncateText("abcdef", 4)).toEqual({ text: "abcd\n\n[truncated]", truncated: true });
  });

  it("drops invalid exclusion entries instead of throwing", () => {
    expect(normalizeVaultScope({ excludedFolders: ["Projects", "../Secrets"], excludedFiles: ["A.md"], excludedTags: ["#Knowledge"] })).toEqual({
      excludedFolders: ["Projects"],
      excludedFiles: ["A.md"],
      excludedTags: ["knowledge"]
    });
  });
});
