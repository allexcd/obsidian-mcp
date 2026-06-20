import { describe, expect, it } from "vitest";
import { buildBaseFileContent, buildBaseFilter, normalizeBasePath, resolveBasePath } from "./base.js";

describe("base file helpers", () => {
  it("normalizes base file paths", () => {
    expect(normalizeBasePath("Bases/Reading")).toBe("Bases/Reading.base");
    expect(normalizeBasePath("Bases/Reading.base")).toBe("Bases/Reading.base");
    expect(() => normalizeBasePath("../Reading.base")).toThrow(/traversal/i);
    expect(() => normalizeBasePath("Bases/Reading.md")).toThrow(/must end with .base/i);
  });

  it("derives default base paths inside folder scopes", () => {
    expect(resolveBasePath(undefined, { folder: "Articles/Science" })).toBe("Articles/Science/Science.base");
    expect(resolveBasePath(undefined, { kind: "folder", folder: "Articles" })).toBe("Articles/Articles.base");
    expect(resolveBasePath("Custom/Science", { folder: "Articles/Science" })).toBe("Custom/Science.base");
    expect(resolveBasePath(undefined, { kind: "vault" })).toBe("Vault.base");
  });

  it("creates a default whole-vault table base", () => {
    expect(buildBaseFileContent()).toBe(
      [
        "filters: 'file.ext != \"base\"'",
        "views:",
        "  - type: table",
        "    name: Table",
        "    order:",
        "      - file.name",
        "      - file.folder",
        "      - file.mtime",
        "      - file.tags",
        ""
      ].join("\n")
    );
  });

  it("creates a folder-scoped table with requested first columns", () => {
    expect(
      buildBaseFileContent({
        scope: { kind: "folder", folder: "Folder X" },
        views: [
          {
            type: "table",
            name: "Table",
            order: ["title", "author", "url", "file.name"]
          }
        ]
      })
    ).toBe(
      [
        "filters:",
        "  and:",
        "    - and:",
        "        - 'file.inFolder(\"Folder X\")'",
        "    - 'file.ext != \"base\"'",
        "views:",
        "  - type: table",
        "    name: Table",
        "    order:",
        "      - title",
        "      - author",
        "      - url",
        "      - file.name",
        ""
      ].join("\n")
    );
  });

  it("accepts shorthand folder scope without an explicit kind", () => {
    expect(
      buildBaseFileContent({
        scope: { folder: "Articles/Science" }
      })
    ).toContain(`- 'file.inFolder("Articles/Science")'`);
  });

  it("adds explicit base filters for excluded paths, extensions, and user filters", () => {
    expect(
      buildBaseFileContent({
        scope: { folder: "Articles/Politics" },
        filters: 'title.contains("budget")',
        excludePaths: ["Articles/Politics/Politics.base"],
        includeExtensions: ["md"],
        excludeExtensions: ["canvas"],
        views: [{ type: "table", name: "All Politics Files", order: ["file.name", "title"] }]
      })
    ).toContain(
      [
        "filters:",
        "  and:",
        "    - and:",
        "        - 'file.inFolder(\"Articles/Politics\")'",
        "    - 'title.contains(\"budget\")'",
        "    - 'file.path != \"Articles/Politics/Politics.base\"'",
        "    - 'file.ext == \"md\"'",
        "    - 'file.ext != \"canvas\"'",
        "    - 'file.ext != \"base\"'"
      ].join("\n")
    );
  });

  it("can include base files when explicitly requested", () => {
    expect(
      buildBaseFileContent({
        scope: { kind: "vault" },
        includeBaseFiles: true
      })
    ).not.toContain('file.ext != "base"');
  });

  it("builds tag, files, and custom filters", () => {
    expect(buildBaseFilter({ kind: "tag", tag: "#book" })).toEqual({ and: ['file.hasTag("book")'] });
    expect(buildBaseFilter({ kind: "files", files: ["A.md", "Folder/B.md"] })).toEqual({
      or: ['file.path == "A.md"', 'file.path == "Folder/B.md"']
    });
    expect(buildBaseFilter({ kind: "custom", filter: { and: ['status != "done"'] } })).toEqual({ and: ['status != "done"'] });
  });
});
