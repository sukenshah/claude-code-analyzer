import Database from "better-sqlite3";
import { mkdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TurnRecord, SessionMeta } from "./types.js";
import { calculateCost } from "./cost.js";
import { emptyMeta } from "./parser.js";

const DB_DIR = join(homedir(), ".claude-analyzer");
const DB_PATH = join(DB_DIR, "cache.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS parsed_files (
      path        TEXT PRIMARY KEY,
      mtime       INTEGER NOT NULL,
      size        INTEGER NOT NULL,
      parsed_at   INTEGER NOT NULL,
      session_id  TEXT,
      project_key TEXT,
      is_subagent INTEGER DEFAULT 0,
      agent_id    TEXT,
      meta_json   TEXT
    );

    CREATE TABLE IF NOT EXISTS turns (
      uuid               TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL,
      project_key        TEXT NOT NULL,
      parent_uuid        TEXT,
      timestamp          TEXT NOT NULL,
      model              TEXT NOT NULL,
      input_tokens       INTEGER DEFAULT 0,
      output_tokens      INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens  INTEGER DEFAULT 0,
      is_subagent        INTEGER DEFAULT 0,
      agent_id           TEXT,
      source_file        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_turns_session   ON turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_turns_project   ON turns(project_key);
    CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON turns(timestamp);
    CREATE INDEX IF NOT EXISTS idx_turns_file      ON turns(source_file);
  `);

  // Migrate: add meta_json column to existing DBs that predate this change
  try { db.exec("ALTER TABLE parsed_files ADD COLUMN meta_json TEXT"); } catch { /* already exists */ }

  return db;
}

export function isFileCached(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  const row = getDb()
    .prepare("SELECT mtime, size FROM parsed_files WHERE path = ?")
    .get(filePath) as { mtime: number; size: number } | undefined;
  if (!row) return false;
  return row.mtime === Math.floor(stat.mtimeMs) && row.size === stat.size;
}

export function saveTurns(
  filePath: string,
  sessionId: string,
  projectKey: string,
  isSubagent: boolean,
  agentId: string | null,
  turns: TurnRecord[],
  meta: SessionMeta,
): void {
  const stat = statSync(filePath);
  const d = getDb();
  const insertFile = d.prepare(`
    INSERT OR REPLACE INTO parsed_files (path, mtime, size, parsed_at, session_id, project_key, is_subagent, agent_id, meta_json)
    VALUES (@path, @mtime, @size, @parsed_at, @session_id, @project_key, @is_subagent, @agent_id, @meta_json)
  `);
  const insertTurn = d.prepare(`
    INSERT OR REPLACE INTO turns
      (uuid, session_id, project_key, parent_uuid, timestamp, model,
       input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
       is_subagent, agent_id, source_file)
    VALUES
      (@uuid, @session_id, @project_key, @parent_uuid, @timestamp, @model,
       @input_tokens, @output_tokens, @cache_write_tokens, @cache_read_tokens,
       @is_subagent, @agent_id, @source_file)
  `);

  d.transaction(() => {
    insertFile.run({
      path: filePath,
      mtime: Math.floor(stat.mtimeMs),
      size: stat.size,
      parsed_at: Date.now(),
      session_id: sessionId,
      project_key: projectKey,
      is_subagent: isSubagent ? 1 : 0,
      agent_id: agentId,
      meta_json: JSON.stringify(meta),
    });
    for (const turn of turns) {
      insertTurn.run({
        uuid: turn.uuid,
        session_id: turn.sessionId,
        project_key: turn.projectKey,
        parent_uuid: turn.parentUuid,
        timestamp: turn.timestamp,
        model: turn.model,
        input_tokens: turn.usage.input_tokens,
        output_tokens: turn.usage.output_tokens,
        cache_write_tokens: turn.usage.cache_creation_input_tokens,
        cache_read_tokens: turn.usage.cache_read_input_tokens,
        is_subagent: turn.isSubagent ? 1 : 0,
        agent_id: turn.agentId,
        source_file: turn.sourceFile,
      });
    }
  })();
}

export function loadCachedTurns(filePath: string): TurnRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM turns WHERE source_file = ? ORDER BY timestamp ASC")
    .all(filePath) as Array<{
      uuid: string; session_id: string; project_key: string; parent_uuid: string | null;
      timestamp: string; model: string; input_tokens: number; output_tokens: number;
      cache_write_tokens: number; cache_read_tokens: number; is_subagent: number;
      agent_id: string | null; source_file: string;
    }>;

  return rows.map((r) => {
    const usage = {
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_creation_input_tokens: r.cache_write_tokens,
      cache_read_input_tokens: r.cache_read_tokens,
    };
    return {
      uuid: r.uuid,
      sessionId: r.session_id,
      projectKey: r.project_key,
      parentUuid: r.parent_uuid,
      timestamp: r.timestamp,
      model: r.model,
      usage,
      cost: calculateCost(usage, r.model),
      isSubagent: r.is_subagent === 1,
      agentId: r.agent_id,
      sourceFile: r.source_file,
    };
  });
}

export function loadCachedMeta(filePath: string): SessionMeta {
  const row = getDb()
    .prepare("SELECT meta_json FROM parsed_files WHERE path = ?")
    .get(filePath) as { meta_json: string | null } | undefined;
  if (!row?.meta_json) return emptyMeta();
  try {
    const parsed = JSON.parse(row.meta_json) as SessionMeta;
    parsed.limitHitCount = parsed.limitHitCount ?? 0;
    parsed.mcpToolCalls = parsed.mcpToolCalls ?? {};
    return parsed;
  } catch { return emptyMeta(); }
}

export function clearCache(): void {
  const d = getDb();
  d.exec("DELETE FROM turns; DELETE FROM parsed_files;");
}

export function closeDb(): void {
  db?.close();
  db = null;
}
