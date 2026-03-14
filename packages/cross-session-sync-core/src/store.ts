import Database from "better-sqlite3";
import type { KnowledgeNugget } from "./types.js";

export class KnowledgeStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_nuggets (
        id              TEXT PRIMARY KEY,
        fact            TEXT NOT NULL,
        category        TEXT NOT NULL,
        confidence      REAL NOT NULL DEFAULT 1.0,
        source_session  TEXT NOT NULL,
        source_channel  TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        superseded_by   TEXT,
        ttl_hours       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_created ON knowledge_nuggets(created_at);
      CREATE INDEX IF NOT EXISTS idx_active ON knowledge_nuggets(superseded_by)
        WHERE superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_category ON knowledge_nuggets(category);
    `);
  }

  insertNugget(nugget: KnowledgeNugget): void {
    const stmt = this.db.prepare(`
      INSERT INTO knowledge_nuggets
        (id, fact, category, confidence, source_session, source_channel, created_at, superseded_by, ttl_hours)
      VALUES
        (@id, @fact, @category, @confidence, @sourceSession, @sourceChannel, @createdAt, @supersededBy, @ttlHours)
    `);
    stmt.run({
      id: nugget.id,
      fact: nugget.fact,
      category: nugget.category,
      confidence: nugget.confidence,
      sourceSession: nugget.sourceSession,
      sourceChannel: nugget.sourceChannel,
      createdAt: nugget.createdAt,
      supersededBy: nugget.supersededBy ?? null,
      ttlHours: nugget.ttlHours ?? null,
    });
  }

  getActiveNuggets(
    excludeSession: string,
    sinceHours: number
  ): KnowledgeNugget[] {
    const cutoff = new Date(
      Date.now() - sinceHours * 60 * 60 * 1000
    ).toISOString();

    const stmt = this.db.prepare(`
      SELECT id, fact, category, confidence,
             source_session AS sourceSession,
             source_channel AS sourceChannel,
             created_at AS createdAt,
             superseded_by AS supersededBy,
             ttl_hours AS ttlHours
      FROM knowledge_nuggets
      WHERE superseded_by IS NULL
        AND source_session != ?
        AND created_at > ?
      ORDER BY created_at DESC
    `);
    return stmt.all(cutoff, excludeSession) as KnowledgeNugget[];
  }

  supersede(oldId: string, newId: string): void {
    const stmt = this.db.prepare(`
      UPDATE knowledge_nuggets SET superseded_by = ? WHERE id = ?
    `);
    stmt.run(newId, oldId);
  }

  findConflicting(
    category: string,
    sourceSession: string
  ): KnowledgeNugget | undefined {
    const stmt = this.db.prepare(`
      SELECT id, fact, category, confidence,
             source_session AS sourceSession,
             source_channel AS sourceChannel,
             created_at AS createdAt,
             superseded_by AS supersededBy,
             ttl_hours AS ttlHours
      FROM knowledge_nuggets
      WHERE category = ?
        AND superseded_by IS NULL
        AND source_session != ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return stmt.get(category, sourceSession) as KnowledgeNugget | undefined;
  }

  cleanup(olderThanHours: number): number {
    const cutoff = new Date(
      Date.now() - olderThanHours * 60 * 60 * 1000
    ).toISOString();

    const stmt = this.db.prepare(`
      DELETE FROM knowledge_nuggets WHERE created_at < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  getNuggetById(id: string): KnowledgeNugget | undefined {
    const stmt = this.db.prepare(`
      SELECT id, fact, category, confidence,
             source_session AS sourceSession,
             source_channel AS sourceChannel,
             created_at AS createdAt,
             superseded_by AS supersededBy,
             ttl_hours AS ttlHours
      FROM knowledge_nuggets
      WHERE id = ?
    `);
    return stmt.get(id) as KnowledgeNugget | undefined;
  }

  close(): void {
    this.db.close();
  }
}
