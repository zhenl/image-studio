/**
 * SQLite 存储层：jobs / images 两张表 + 仓储函数。
 * 数据库路径可注入（测试用临时目录）。
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface JobRow {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  mode: string;
  prompt: string;
  negative: string;
  params_json: string;
  seed: number;
  count: number;
  progress: number;
  message: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ImageRow {
  id: string;
  job_id: string | null;
  path: string;
  url: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  prompt: string;
  negative: string;
  mode: string;
  ref_mode: string;
  favorite: number;
  flagged: number;
  elapsed_ms: number;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'txt2img',
  prompt       TEXT NOT NULL,
  negative     TEXT,
  params_json  TEXT NOT NULL,
  seed         INTEGER,
  count        INTEGER DEFAULT 1,
  progress     INTEGER DEFAULT 0,
  message      TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  path        TEXT NOT NULL,
  url         TEXT NOT NULL,
  width       INTEGER, height      INTEGER,
  steps       INTEGER, guidance    REAL, seed INTEGER,
  prompt      TEXT, negative TEXT,
  mode        TEXT DEFAULT 'txt2img',
  ref_mode    TEXT DEFAULT '',
  favorite    INTEGER DEFAULT 0,
  flagged     INTEGER DEFAULT 0,
  elapsed_ms  INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_job ON images(job_id);

CREATE TABLE IF NOT EXISTS prompts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,           -- prompt | negative
  text        TEXT NOT NULL,
  use_count   INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_kind ON prompts(kind);
`;

export interface PromptRow {
  id: string;
  kind: "prompt" | "negative";
  text: string;
  use_count: number;
  created_at: string;
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createJob(row: Omit<JobRow, "progress" | "message" | "error" | "started_at" | "finished_at" | "status">
    & { status?: JobRow["status"] }): void {
    this.db
      .prepare(`INSERT INTO jobs (id, status, mode, prompt, negative, params_json,
        seed, count, progress, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(
        row.id, row.status ?? "queued", row.mode, row.prompt, row.negative,
        row.params_json, row.seed, row.count,
        "排队中", row.created_at,
      );
  }

  updateJob(id: string, fields: Partial<JobRow>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    this.db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  }

  getJob(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  listJobs(limit = 20, status?: string): JobRow[] {
    const sql = status
      ? "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?";
    return this.db.prepare(sql).all(...(status ? [status, limit] : [limit])) as JobRow[];
  }

  insertImage(row: ImageRow): void {
    this.db
      .prepare(`INSERT INTO images (id, job_id, path, url, width, height, steps,
        guidance, seed, prompt, negative, mode, ref_mode, favorite, flagged,
        elapsed_ms, created_at)
        VALUES (@id, @job_id, @path, @url, @width, @height, @steps, @guidance,
        @seed, @prompt, @negative, @mode, @ref_mode, @favorite, @flagged,
        @elapsed_ms, @created_at)`)
      .run(row as unknown as Record<string, unknown>);
  }

  listImages(limit = 60, favoriteOnly = false): ImageRow[] {
    const sql = favoriteOnly
      ? "SELECT * FROM images WHERE favorite = 1 ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM images ORDER BY created_at DESC LIMIT ?";
    return this.db.prepare(sql).all(limit) as ImageRow[];
  }

  imagesByJob(jobId: string): ImageRow[] {
    return this.db.prepare("SELECT * FROM images WHERE job_id = ?").all(jobId) as ImageRow[];
  }

  setFavorite(imageId: string, favorite: boolean): void {
    this.db.prepare("UPDATE images SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, imageId);
  }

  deleteJob(id: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  deleteImage(id: string): void {
    this.db.prepare("DELETE FROM images WHERE id = ?").run(id);
  }

  getImage(id: string): ImageRow | undefined {
    return this.db.prepare("SELECT * FROM images WHERE id = ?").get(id) as ImageRow | undefined;
  }

  /** 近期成功出图记录（耗时自校准的数据源）。 */
  recentImagesForCalibration(limit = 30): Array<{ width: number; height: number; steps: number; elapsed_ms: number }> {
    return this.db
      .prepare(`SELECT width, height, steps, elapsed_ms FROM images
        WHERE elapsed_ms > 0 AND steps > 0 AND width > 0 AND height > 0
        ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as never;
  }

  // ---------------- 提示词库 ----------------
  insertPrompt(row: PromptRow): void {
    this.db
      .prepare("INSERT INTO prompts (id, kind, text, use_count, created_at) VALUES (@id, @kind, @text, 0, @created_at)")
      .run(row as unknown as Record<string, unknown>);
  }

  listPrompts(kind?: string, q?: string): PromptRow[] {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (kind) { conds.push("kind = ?"); args.push(kind); }
    if (q) { conds.push("text LIKE ?"); args.push(`%${q}%`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM prompts ${where} ORDER BY use_count DESC, created_at DESC`)
      .all(...args) as PromptRow[];
  }

  getPrompt(id: string): PromptRow | undefined {
    return this.db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;
  }

  updatePromptText(id: string, text: string): void {
    this.db.prepare("UPDATE prompts SET text = ? WHERE id = ?").run(text, id);
  }

  touchPrompt(id: string): void {
    this.db.prepare("UPDATE prompts SET use_count = use_count + 1 WHERE id = ?").run(id);
  }

  deletePrompt(id: string): void {
    this.db.prepare("DELETE FROM prompts WHERE id = ?").run(id);
  }
}
