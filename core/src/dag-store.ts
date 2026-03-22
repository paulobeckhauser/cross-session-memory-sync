import { openDatabase } from "./sqlite-adapter.js";
import type { SQLiteDatabase } from "./sqlite-adapter.js";
import type { DAGNode, NuggetCategory } from "./types.js";

export class DAGStore {
  private db: SQLiteDatabase;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dag_nodes (
        id              TEXT PRIMARY KEY,
        depth           INTEGER NOT NULL DEFAULT 0,
        content         TEXT NOT NULL,
        category        TEXT,
        confidence      REAL NOT NULL DEFAULT 1.0,
        source_session  TEXT,
        source_channel  TEXT,
        parent_id       TEXT,
        created_at      TEXT NOT NULL,
        superseded_by   TEXT,
        is_compressed   INTEGER NOT NULL DEFAULT 0,
        archived_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS dag_lineage (
        summary_id  TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        PRIMARY KEY (summary_id, source_id)
      );

      CREATE INDEX IF NOT EXISTS idx_depth ON dag_nodes(depth);
      CREATE INDEX IF NOT EXISTS idx_active ON dag_nodes(superseded_by) WHERE superseded_by IS NULL;
      CREATE INDEX IF NOT EXISTS idx_uncompressed ON dag_nodes(is_compressed) WHERE is_compressed = 0;
      CREATE INDEX IF NOT EXISTS idx_parent ON dag_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_created ON dag_nodes(created_at);
      CREATE INDEX IF NOT EXISTS idx_archived ON dag_nodes(archived_at) WHERE archived_at IS NULL;
    `);

    // Migration: add archived_at column to existing databases
    try {
      this.db.exec(`ALTER TABLE dag_nodes ADD COLUMN archived_at TEXT`);
    } catch {
      // Column already exists — ignore
    }
  }

  insertFact(fact: Omit<DAGNode, "depth" | "isCompressed" | "parentId" | "supersededBy">): void {
    this.db
      .prepare(
        `INSERT INTO dag_nodes (id, depth, content, category, confidence, source_session, source_channel, created_at, is_compressed)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        fact.id,
        fact.content,
        fact.category ?? null,
        fact.confidence,
        fact.sourceSession ?? null,
        fact.sourceChannel ?? null,
        fact.createdAt
      );
  }

  insertSummary(node: {
    id: string;
    depth: number;
    content: string;
    category?: NuggetCategory;
    createdAt: string;
    childIds: string[];
  }): void {
    const insertNode = this.db.prepare(
      `INSERT INTO dag_nodes (id, depth, content, category, confidence, created_at, is_compressed)
       VALUES (?, ?, ?, ?, 1.0, ?, 0)`
    );
    const insertLineage = this.db.prepare(
      `INSERT INTO dag_lineage (summary_id, source_id) VALUES (?, ?)`
    );
    const markCompressed = this.db.prepare(
      `UPDATE dag_nodes SET is_compressed = 1, parent_id = ? WHERE id = ?`
    );

    const tx = this.db.transaction(() => {
      insertNode.run(
        node.id,
        node.depth,
        node.content,
        node.category ?? null,
        node.createdAt
      );
      for (const childId of node.childIds) {
        insertLineage.run(node.id, childId);
        markCompressed.run(node.id, childId);
      }
    });
    tx();
  }

  getActiveNodes(
    excludeSession?: string,
    maxDepth?: number
  ): DAGNode[] {
    let sql = `SELECT * FROM dag_nodes WHERE superseded_by IS NULL AND is_compressed = 0 AND archived_at IS NULL`;
    const params: (string | number)[] = [];

    if (excludeSession) {
      sql += ` AND (source_session IS NULL OR source_session != ?)`;
      params.push(excludeSession);
    }
    if (maxDepth !== undefined) {
      sql += ` AND depth <= ?`;
      params.push(maxDepth);
    }
    sql += ` ORDER BY depth ASC, created_at DESC`;

    return this.db.prepare(sql).all(...params).map(rowToNode);
  }

  getUncompressedNodes(depth: number, category?: string): DAGNode[] {
    let sql = `SELECT * FROM dag_nodes WHERE depth = ? AND is_compressed = 0 AND superseded_by IS NULL AND archived_at IS NULL`;
    const params: (string | number)[] = [depth];

    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }
    sql += ` ORDER BY created_at ASC`;

    return this.db.prepare(sql).all(...params).map(rowToNode);
  }

  getCategories(depth: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT category FROM dag_nodes
         WHERE depth = ? AND is_compressed = 0 AND superseded_by IS NULL AND category IS NOT NULL AND archived_at IS NULL`
      )
      .all(depth) as { category: string }[];
    return rows.map((r) => r.category);
  }

  supersede(oldId: string, newId: string): void {
    this.db
      .prepare(`UPDATE dag_nodes SET superseded_by = ? WHERE id = ?`)
      .run(newId, oldId);
  }

  getLineage(summaryId: string): DAGNode[] {
    return this.db
      .prepare(
        `SELECT n.* FROM dag_nodes n
         JOIN dag_lineage l ON n.id = l.source_id
         WHERE l.summary_id = ?
         ORDER BY n.created_at ASC`
      )
      .all(summaryId)
      .map(rowToNode);
  }

  getNodeById(id: string): DAGNode | null {
    const row = this.db.prepare(`SELECT * FROM dag_nodes WHERE id = ?`).get(id);
    return row ? rowToNode(row) : null;
  }

  getActiveFactsByCategory(category: string): DAGNode[] {
    return this.db
      .prepare(
        `SELECT * FROM dag_nodes
         WHERE category = ? AND depth = 0 AND superseded_by IS NULL AND is_compressed = 0 AND archived_at IS NULL
         ORDER BY created_at DESC`
      )
      .all(category)
      .map(rowToNode);
  }

  cleanup(olderThanHours: number): number {
    const cutoff = new Date(
      Date.now() - olderThanHours * 60 * 60 * 1000
    ).toISOString();
    const now = new Date().toISOString();

    // Soft-delete: archive instead of removing
    const result = this.db
      .prepare(
        `UPDATE dag_nodes SET archived_at = ?
         WHERE created_at < ? AND archived_at IS NULL
         AND (is_compressed = 1 OR superseded_by IS NOT NULL)`
      )
      .run(now, cutoff);

    return result.changes;
  }

  nodeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM dag_nodes`)
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}

function rowToNode(row: unknown): DAGNode {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    depth: r.depth as number,
    content: r.content as string,
    category: (r.category as NuggetCategory) ?? undefined,
    confidence: r.confidence as number,
    sourceSession: (r.source_session as string) ?? undefined,
    sourceChannel: (r.source_channel as string) ?? undefined,
    parentId: (r.parent_id as string) ?? undefined,
    createdAt: r.created_at as string,
    supersededBy: (r.superseded_by as string) ?? undefined,
    isCompressed: (r.is_compressed as number) === 1,
    archivedAt: (r.archived_at as string) ?? undefined,
  };
}
