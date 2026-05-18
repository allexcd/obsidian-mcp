import { describe, expect, it } from "vitest";
import { appendNoteContent, deleteExactText, NoteEditError, replaceExactText } from "./write.js";

describe("note write helpers", () => {
  it("appends with a separating newline when the note has content", () => {
    expect(appendNoteContent("First line", "Second line")).toBe("First line\nSecond line");
    expect(appendNoteContent("First line\n", "Second line")).toBe("First line\nSecond line");
  });

  it("appends directly to an empty note", () => {
    expect(appendNoteContent("", "First line")).toBe("First line");
  });

  it("replaces exact text", () => {
    expect(replaceExactText("alpha beta gamma", "beta", "BETA")).toBe("alpha BETA gamma");
  });

  it("deletes exact text", () => {
    expect(deleteExactText("alpha beta gamma", " beta")).toBe("alpha gamma");
  });

  it("errors without writing when text is missing", () => {
    expect(() => replaceExactText("alpha beta", "delta", "DELTA")).toThrow(NoteEditError);
    expect(() => replaceExactText("alpha beta", "delta", "DELTA")).toThrow(/not found/);
  });

  it("requires an occurrence index for duplicate exact text", () => {
    expect(() => replaceExactText("tag tag tag", "tag", "TAG")).toThrow(/appears 3 times/);
    expect(replaceExactText("tag tag tag", "tag", "TAG", 1)).toBe("tag TAG tag");
  });

  it("rejects out-of-range occurrence indexes", () => {
    expect(() => deleteExactText("tag tag", "tag", 2)).toThrow(/out of range/);
  });
});
