import { describe, expect, it, vi } from "vitest";
import { WriteRetries } from "./write-retries.js";

describe("write receipts", () => {
  const allowed = async () => true;
  it("serializes concurrent duplicates and treats object key ordering consistently", async () => {
    const receipts = new WriteRetries();
    const write = vi.fn(async () => ({ status: 200, body: { content: "done" } }));
    const results = await Promise.all([
      receipts.run("one", { a: 1, b: 2 }, allowed, write),
      receipts.run("one", { b: 2, a: 1 }, allowed, write)
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(results[1]?.body).toMatchObject({ replayed: true });
    expect((await receipts.run("one", { a: 3 }, allowed, write)).status).toBe(409);
    expect((await receipts.run("one", { a: 1, b: 2 }, async () => false, write)).status).toBe(403);
  });

  it("retains tombstones after response eviction and rejects new IDs at capacity", async () => {
    const receipts = new WriteRetries(2, 100);
    const write = vi.fn(async () => ({ status: 200, body: { content: "x".repeat(50) } }));
    await receipts.run("one", {}, allowed, write);
    await receipts.run("two", {}, allowed, write);
    expect((await receipts.run("one", {}, allowed, write)).body).toMatchObject({ code: "operation_result_expired" });
    expect((await receipts.run("three", {}, allowed, write)).status).toBe(503);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not re-execute after an ambiguous exception and keeps the queue usable", async () => {
    const receipts = new WriteRetries();
    const write = vi.fn(async () => { throw new Error("response lost after commit"); });
    await expect(receipts.run("one", {}, allowed, write)).rejects.toThrow("response lost");
    expect((await receipts.run("one", {}, allowed, write)).status).toBe(409);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await receipts.run("two", {}, allowed, async () => ({ status: 200, body: {} }))).status).toBe(200);
  });
});
