import { contentRevision } from "./sync.js";

export interface WriteReply { status: number; body: unknown }
interface Entry { fingerprint: string; accessRevision?: string; reply?: WriteReply; bytes: number }

/** Session-scoped receipts. Evicted bodies leave tombstones so an old ID never writes twice. */
export class WriteRetries {
  private tail: Promise<unknown> = Promise.resolve();
  private entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly maxEntries = 4096, private readonly maxBytes = 16 * 1024 * 1024) {}

  run(id: unknown, request: unknown, authorize: (reply: WriteReply | undefined) => Promise<boolean>, execute: () => Promise<WriteReply>, accessRevision?: string): Promise<WriteReply> {
    const job = this.tail.then(async () => {
      if (id === undefined) return execute();
      if (typeof id !== "string" || !id.trim() || id.length > 128) return failure(400, "invalid_operation_id", "operationId must contain 1–128 characters.");
      const fingerprint = contentRevision(canonical(request));
      const previous = this.entries.get(id);
      if (previous) {
        if (previous.accessRevision !== accessRevision) return failure(403, "scope_denied", "Vault access rules changed since this write. Read the file to verify the outcome; do not repeat the edit blindly.");
        if (previous.fingerprint !== fingerprint) return failure(409, "operation_id_conflict", "This operationId was used with different arguments. Use a new ID for a new edit.");
        if (!(await authorize(previous.reply))) return failure(403, "scope_denied", "The previous write result is no longer accessible. Check vault access and write permissions.");
        return previous.reply ? { ...previous.reply, body: { ...(previous.reply.body as object), replayed: true } } : failure(409, "operation_result_expired", "This operation was already attempted, but its result is no longer retained. Read the file to verify; do not blindly repeat the edit.");
      }
      if (this.entries.size >= this.maxEntries) return failure(503, "operation_capacity", "The session write receipt limit was reached. Verify outstanding edits before restarting the plugin.");
      const entry: Entry = { fingerprint, accessRevision, bytes: 0 };
      this.entries.set(id, entry);
      // Reserve the ID before execution: even an ambiguous failure must not repeat a write.
      const reply = await execute();
      const bytes = Buffer.byteLength(JSON.stringify(reply));
      if (bytes <= this.maxBytes) {
        for (const old of this.entries.values()) {
          if (this.bytes + bytes <= this.maxBytes) break;
          this.bytes -= old.bytes;
          old.bytes = 0;
          old.reply = undefined;
        }
        entry.reply = reply;
        entry.bytes = bytes;
        this.bytes += bytes;
      }
      return reply;
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}

function failure(status: number, code: string, error: string): WriteReply {
  return { status, body: { code, error } };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
