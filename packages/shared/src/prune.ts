import type { PruneEmbeddingsResult } from "./types.js";

export interface SqliteStatement<Result = unknown> {
  get(): Result | undefined;
  run(): unknown;
}

export interface PrunableEmbeddingDatabase {
  prepare<Result = unknown>(sql: string): SqliteStatement<Result>;
}

export function pruneOrphanedEmbeddingsInDatabase(db: PrunableEmbeddingDatabase): PruneEmbeddingsResult {
  const beforeCount = countEmbeddings(db);
  const orphanedBeforeCount = countOrphanedEmbeddings(db);
  const estimatedBytesFreed = estimateOrphanedEmbeddingBytes(db);
  if (orphanedBeforeCount > 0) {
    db.prepare(
      `DELETE FROM embeddings
       WHERE NOT EXISTS (
         SELECT 1 FROM chunks
         WHERE chunks.content_hash = embeddings.content_hash
       )`
    ).run();
  }
  const afterCount = countEmbeddings(db);
  const orphanedAfterCount = countOrphanedEmbeddings(db);
  return {
    beforeCount,
    afterCount,
    orphanedBeforeCount,
    orphanedAfterCount,
    deletedEmbeddings: beforeCount - afterCount,
    estimatedBytesFreed
  };
}

export function countOrphanedEmbeddingsInDatabase(db: PrunableEmbeddingDatabase): number {
  return countOrphanedEmbeddings(db);
}

function countEmbeddings(db: PrunableEmbeddingDatabase): number {
  const row = db.prepare<{ count: number }>("SELECT COUNT(*) AS count FROM embeddings").get();
  return row?.count ?? 0;
}

function countOrphanedEmbeddings(db: PrunableEmbeddingDatabase): number {
  const row = db
    .prepare<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM embeddings e
       WHERE NOT EXISTS (
         SELECT 1 FROM chunks c
         WHERE c.content_hash = e.content_hash
       )`
    )
    .get();
  return row?.count ?? 0;
}

function estimateOrphanedEmbeddingBytes(db: PrunableEmbeddingDatabase): number {
  const row = db
    .prepare<{ bytes: number }>(
      `SELECT COALESCE(SUM(
         length(content_hash) + length(provider) + length(model) + length(vector_json) + 32
       ), 0) AS bytes
       FROM embeddings e
       WHERE NOT EXISTS (
         SELECT 1 FROM chunks c
         WHERE c.content_hash = e.content_hash
       )`
    )
    .get();
  return row?.bytes ?? 0;
}
