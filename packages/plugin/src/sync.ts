import { randomUUID, createHash } from "node:crypto";
import type { AdapterReport } from "@obsidian-mcp/shared";

export class BridgeSyncState {
  readonly epoch = randomUUID();
  revision = 0;
  refreshRequest = 0;
  report: AdapterReport | null = null;
  private events: Array<{ revision: number; path: string }> = [];

  changed(path: string): void {
    this.events.push({ revision: ++this.revision, path });
    this.events = this.events.slice(-10000);
  }

  changes(epoch: unknown, since: unknown): { reset: boolean; paths: string[] } {
    const cursor = typeof since === "number" ? since : -1;
    const reset = epoch !== this.epoch || cursor > this.revision || cursor < (this.events[0]?.revision ?? 1) - 1;
    return { reset, paths: [...new Set(this.events.filter(event => event.revision > cursor).map(event => event.path))] };
  }
}

export function contentRevision(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
