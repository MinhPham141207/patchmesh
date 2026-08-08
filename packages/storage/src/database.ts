import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrations = [
  {
    id: "001_events",
    path: new URL("./migrations/001_events.sql", import.meta.url),
  },
] as const;

function migrationSql(path: URL): string {
  return readFileSync(fileURLToPath(path), "utf8");
}

function appliedMigrationIds(database: DatabaseSync): ReadonlySet<string> {
  const rows = database
    .prepare("SELECT migration_id FROM schema_migrations")
    .all() as Array<{ readonly migration_id: string }>;
  return new Set(rows.map((row) => row.migration_id));
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = appliedMigrationIds(database);
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migrationSql(migration.path));
      database
        .prepare("INSERT INTO schema_migrations (migration_id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openDatabase(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
