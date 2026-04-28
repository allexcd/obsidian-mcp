import { describe, expect, it } from "vitest";
import { chunkMarkdown, extractWikiLinks, parseMarkdown } from "./markdown.js";

describe("markdown helpers", () => {
  it("extracts frontmatter, aliases, tags, links, and embeds", () => {
    const parsed = parseMarkdown(
      "Projects/Plan.md",
      `---
tags: [project, important]
aliases:
  - Big Plan
---
# Heading
Text with #inline and [[Other Note|other]] plus ![[image.png]].`
    );

    expect(parsed.frontmatter.tags).toEqual(["project", "important"]);
    expect(parsed.aliases).toEqual(["Big Plan"]);
    expect(parsed.tags).toEqual(["project", "important", "inline"]);
    expect(parsed.wikilinks).toEqual(["Other Note"]);
    expect(parsed.embeds).toEqual(["image.png"]);
  });

  it("chunks by headings and large sections", () => {
    const chunks = chunkMarkdown("A.md", "# One\nBody\n\n## Two\nMore", 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.heading).toBe("One");
    expect(chunks[1]?.heading).toBe("Two");
  });

  it("extracts wiki links with aliases", () => {
    expect(extractWikiLinks("[[Target#Heading|Alias]]")).toEqual([
      { target: "Target#Heading", alias: "Alias", embed: false }
    ]);
  });
});

