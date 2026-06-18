import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./bridge-client.js";
import { requestJson } from "./http-json.js";

vi.mock("./http-json.js", () => ({
  requestJson: vi.fn()
}));

const requestJsonMock = vi.mocked(requestJson);

describe("BridgeClient write methods", () => {
  beforeEach(() => {
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { operation: "append", note: { path: "Notes/A.md" } },
      text: "{}"
    });
  });

  it("sends create requests to the write create route", async () => {
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await client.createNote("Notes/New.md", "# New", false);

    expect(requestJsonMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:27125/notes/create"), {
      headers: { Authorization: "Bearer token" },
      body: {
        path: "Notes/New.md",
        content: "# New",
        overwrite: false
      }
    });
  });

  it("sends exact replacement requests without losing occurrenceIndex", async () => {
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await client.replaceNoteText("Notes/A.md", "old", "new", 2);

    expect(requestJsonMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:27125/notes/replace"), {
      headers: { Authorization: "Bearer token" },
      body: {
        path: "Notes/A.md",
        oldText: "old",
        newText: "new",
        occurrenceIndex: 2
      }
    });
  });

  it("sends append requests to the append route", async () => {
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await client.appendNote("Notes/A.md", "\nMore text");

    expect(requestJsonMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:27125/notes/append"), {
      headers: { Authorization: "Bearer token" },
      body: {
        path: "Notes/A.md",
        content: "\nMore text"
      }
    });
  });

  it("sends delete requests to the delete-text route", async () => {
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await client.deleteNoteText("Notes/A.md", "remove me", 0);

    expect(requestJsonMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:27125/notes/delete-text"), {
      headers: { Authorization: "Bearer token" },
      body: {
        path: "Notes/A.md",
        text: "remove me",
        occurrenceIndex: 0
      }
    });
  });

  it("sends rewrite requests to the rewrite route", async () => {
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await client.rewriteNote("Notes/A.md", "");

    expect(requestJsonMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:27125/notes/rewrite"), {
      headers: { Authorization: "Bearer token" },
      body: {
        path: "Notes/A.md",
        content: ""
      }
    });
  });

  it("surfaces write-disabled bridge errors", async () => {
    requestJsonMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: { error: "Write tools are disabled in the Obsidian plugin settings." },
      text: "{}"
    });
    const client = new BridgeClient("http://127.0.0.1:27125", "token");

    await expect(client.appendNote("Notes/A.md", "Text")).rejects.toThrow(
      "Obsidian bridge 403: Write tools are disabled in the Obsidian plugin settings."
    );
  });
});
