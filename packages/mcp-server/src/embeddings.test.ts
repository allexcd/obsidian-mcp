import { describe, expect, it, vi } from "vitest";
import { EmbeddingClient } from "./embeddings.js";
import { requestJson } from "./http-json.js";
vi.mock("./http-json.js", () => ({ requestJson: vi.fn() }));
const config = { enabled: true, baseUrl: "http://localhost:1234/v1", apiKey: null, model: "text-embedding-nomic-embed-text-v1.5", provider: "test" };

describe("embedding protocol", () => {
  it("restores indexed response order and applies document/query prefixes", async () => {
    vi.mocked(requestJson).mockResolvedValue({ ok: true, body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } } as never);
    const client = new EmbeddingClient(config);
    expect(await client.embed(["a", "b"], "document")).toEqual([[1, 0], [0, 1]]);
    expect(vi.mocked(requestJson).mock.lastCall?.[1]?.body).toEqual({ model: config.model, input: ["search_document: a", "search_document: b"] });
    await client.embed(["a", "b"]);
    expect(vi.mocked(requestJson).mock.lastCall?.[1]?.body).toEqual({ model: config.model, input: ["search_query: a", "search_query: b"] });
  });
  it.each([
    [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
    [{ embedding: [1, 0] }, { embedding: [1] }],
    [{ embedding: [0, 0] }, { embedding: [1, 0] }],
    [{ embedding: [Infinity, 0] }, { embedding: [1, 0] }]
  ])("rejects invalid vectors or indexes", async (a, b) => {
    vi.mocked(requestJson).mockResolvedValue({ ok: true, body: { data: [a, b] } } as never);
    await expect(new EmbeddingClient(config).embed(["a", "b"])).rejects.toThrow();
  });
  it("isolates caches by endpoint and preprocessing", () => {
    const client = new EmbeddingClient(config);
    expect(client.provider).not.toBe(new EmbeddingClient({ ...config, baseUrl: "http://localhost:5678/v1" }).provider);
    expect(client.provider).not.toBe(new EmbeddingClient({ ...config, documentPrefix: "" }).provider);
  });
});
