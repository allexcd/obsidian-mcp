import type {
  BaseFileInput,
  BaseFileWriteResponse,
  BridgeExportResponse,
  BridgeListResponse,
  BridgeStatus,
  NoteMetadata,
  SearchResult,
  VaultNote,
  WriteNoteResponse
} from "@obsidian-mcp/shared";
import { requestJson } from "./http-json.js";

export class BridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null
  ) {}

  async status(): Promise<BridgeStatus> {
    return this.request<BridgeStatus>("/status", {});
  }

  async listNotes(limit: number, offset: number): Promise<BridgeListResponse> {
    return this.request<BridgeListResponse>("/notes/list", { limit, offset });
  }

  async exportNotes(limit: number, offset: number): Promise<BridgeExportResponse> {
    return this.request<BridgeExportResponse>("/notes/export", { limit, offset });
  }

  async searchNotes(query: string, limit: number): Promise<{ results: SearchResult[] }> {
    return this.request<{ results: SearchResult[] }>("/notes/search", { query, limit });
  }

  async readNote(path: string, maxBytes?: number): Promise<VaultNote> {
    return this.request<VaultNote>("/notes/read", { path, maxBytes });
  }

  async metadata(path: string): Promise<NoteMetadata> {
    return this.request<NoteMetadata>("/notes/metadata", { path });
  }

  async links(path: string): Promise<{ path: string; outlinks: string[]; embeds: string[]; backlinks: string[] }> {
    return this.request<{ path: string; outlinks: string[]; embeds: string[]; backlinks: string[] }>("/notes/links", { path });
  }

  async createNote(path: string, content: string, overwrite: boolean): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/create", { path, content, overwrite });
  }

  async createBaseFile(
    path: string | undefined,
    base: BaseFileInput,
    overwrite: boolean,
    createFolder: boolean
  ): Promise<BaseFileWriteResponse> {
    return this.request<BaseFileWriteResponse>("/bases/create", { path, ...base, overwrite, createFolder });
  }

  async appendNote(path: string, content: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/append", { path, content });
  }

  async replaceNoteText(path: string, oldText: string, newText: string, occurrenceIndex?: number): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/replace", { path, oldText, newText, occurrenceIndex });
  }

  async deleteNoteText(path: string, text: string, occurrenceIndex?: number): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/delete-text", { path, text, occurrenceIndex });
  }

  async rewriteNote(path: string, content: string): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/rewrite", { path, content });
  }

  async setNoteProperties(path: string, properties: Record<string, unknown>): Promise<WriteNoteResponse> {
    return this.request<WriteNoteResponse>("/notes/properties", { path, properties });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    if (!this.token) {
      throw new Error("OBSIDIAN_MCP_TOKEN is required. Copy it from the Obsidian plugin settings.");
    }
    const url = new URL(path, this.baseUrl);
    const response = await requestJson<{ error?: string } & T>(url, {
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      body
    });

    if (!response.ok) {
      const parsed = response.body;
      const message = typeof parsed === "object" && parsed && "error" in parsed ? String(parsed.error) : response.statusText;
      throw new Error(`Obsidian bridge ${response.status}: ${message}`);
    }
    return response.body;
  }
}
