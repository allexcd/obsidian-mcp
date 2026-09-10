import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeSync, VaultNote } from "@obsidian-mcp/shared";
import { VaultDatabase } from "./database.js";
import { VaultIndexer } from "./indexer.js";
import { EmbeddingClient } from "./embeddings.js";
import { BridgeClient } from "./bridge-client.js";

const roots: string[] = [];
const databases: VaultDatabase[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(path => rmSync(path, {recursive:true,force:true})); });
function database(path?: string) {
  const root = path ?? mkdtempSync(join(tmpdir(), "vault-sync-test-"));
  if (!path) roots.push(root);
  const db = new VaultDatabase(join(root,"index.sqlite")); databases.push(db); return {db,root};
}
function note(path: string, content: string): VaultNote {
  return {path,title:path,content,size:content.length,mtime:1,tags:[],aliases:[],frontmatter:{},truncated:false,
    metadata:{path,title:path,basename:path,extension:"md",stat:{ctime:1,mtime:1,size:content.length},tags:[],aliases:[],frontmatter:{},outlinks:[],embeds:[],backlinks:[]}};
}

describe("synchronization", () => {
  it("incrementally follows edits, renames, deletion, exclusions, and reconnects", async () => {
    const {db} = database();
    const notes = new Map([["A.md",note("A.md","alpha")],["B.md",note("B.md","beta")]]);
    let snapshot: BridgeSync = {epoch:"one",revision:0,policyRevision:"public",reset:false,paths:[],allowedPaths:[...notes.keys()],refreshRequest:0};
    const bridge = {
      sync: vi.fn(async () => ({...snapshot})),
      exportNotes: vi.fn(async () => ({notes:[...notes.values()].filter(note=>snapshot.allowedPaths.includes(note.path)),nextOffset:null})),
      readNote: vi.fn(async (path: string) => notes.get(path)!), report: vi.fn(async () => undefined)
    };
    const embeddings = new EmbeddingClient({enabled:false,baseUrl:null,model:null,provider:"test",apiKey:null});
    const indexer = new VaultIndexer(bridge as unknown as BridgeClient, db, embeddings);
    await indexer.synchronize();
    expect(db.stats().noteCount).toBe(2);
    notes.set("A.md",note("A.md","changed")); snapshot={...snapshot,revision:1,paths:["A.md"]};
    await indexer.synchronize();
    expect(db.getNote("A.md")?.content).toBe("changed");
    expect(bridge.exportNotes).toHaveBeenCalledTimes(1);
    notes.delete("A.md"); notes.set("Renamed.md",note("Renamed.md","changed"));
    snapshot={...snapshot,revision:2,paths:["A.md","Renamed.md"],allowedPaths:[...notes.keys()]};
    await indexer.synchronize(); expect(db.getNote("A.md")).toBeNull(); expect(db.getNote("Renamed.md")).not.toBeNull();
    snapshot={...snapshot,revision:3,paths:[],policyRevision:"restricted",allowedPaths:["B.md"]};
    await indexer.synchronize(); expect(db.getNote("Renamed.md")).toBeNull();
    snapshot={...snapshot,epoch:"two",reset:true,allowedPaths:[]};
    await indexer.synchronize(); expect(db.stats().noteCount).toBe(0);
  });

  it("fails closed when the bridge cannot verify the current scope", async () => {
    const {db}=database(); db.upsertNote(note("A.md","cached"));
    const bridge={sync:async()=>{throw new Error("offline");},report:async()=>undefined};
    const embeddings=new EmbeddingClient({enabled:false,baseUrl:null,model:null,provider:"test",apiKey:null});
    await expect(new VaultIndexer(bridge as unknown as BridgeClient,db,embeddings).synchronize()).rejects.toThrow("Cannot synchronize or verify vault access");
  });

  it("serializes two database connections and releases the lease after failure", async () => {
    const {db,root}=database(); const second=database(root).db;
    const order: string[]=[];
    let release!: () => void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    const first=db.withSyncLock(async()=>{order.push("first");await wait;throw new Error("fixture");});
    const firstCheck=expect(first).rejects.toThrow("fixture");
    const next=second.withSyncLock(async()=>{order.push("second");second.upsertNote(note("A.md","new"));});
    release(); await firstCheck; await next;
    expect(order).toEqual(["first","second"]); expect(db.getNote("A.md")?.content).toBe("new");
  });
});
