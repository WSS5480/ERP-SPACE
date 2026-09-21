// Forward-only migrations, in Node, so a host without psql can run them.
//
// Same rules as db/apply.sh, and the same schema_migration table, so the two
// are interchangeable:
//
//   every migration runs once, in filename order
//   each one is recorded with the sha256 of the file that ran
//   a migration whose file has changed since it ran is refused -- write a new one
//
// Two things this does that the shell script does not, because a deployed
// server restarts on its own:
//
//   Each migration and its record commit together. A migration that fails
//   halfway is not marked as applied, so the next boot tries it again rather
//   than skipping it.
//
//   An advisory lock means two instances starting at once cannot both run the
//   same migration.
//
// Seeds load only when ERP_SEED=placeholder, and each loads exactly once.
// Placeholder data has no business in a database holding real books.
//
//   node --experimental-strip-types scripts/migrate.ts
//   ERP_SEED=placeholder node --experimental-strip-types scripts/migrate.ts

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const LOCK = 7_406_311; // any constant; identifies "pentex-erp migrations"

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function poolConfig(): pg.PoolConfig {
  const ssl =
    process.env.PGSSLMODE === "require" || process.env.DATABASE_SSL === "require"
      ? { rejectUnauthorized: false }
      : undefined;
  return process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl }
    : { ssl };
}

export async function migrate(opts: { seed?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const client = new pg.Client(poolConfig());
  await client.connect();
  const applied: string[] = [];

  try {
    await client.query("select pg_advisory_lock($1)", [LOCK]);

    await client.query(`
      create table if not exists schema_migration (
        filename   text primary key,
        applied_at timestamptz not null default now(),
        sha256     text not null
      )`);

    const done = new Map<string, string>(
      (await client.query<{ filename: string; sha256: string }>(
        "select filename, sha256 from schema_migration"
      )).rows.map((r) => [r.filename, r.sha256])
    );

    const migDir = join(root, "db", "migrations");
    for (const name of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      const body = readFileSync(join(migDir, name), "utf8");
      const digest = sha(body);
      const prior = done.get(name);

      if (prior === digest) continue;
      if (prior && prior !== digest) {
        throw new Error(
          `REFUSING: ${name} has changed since it was applied. Migrations are forward-only; write a new one.`
        );
      }

      log(`applying ${name}`);
      await client.query("begin");
      try {
        await client.query(body);
        await client.query("insert into schema_migration (filename, sha256) values ($1, $2)", [name, digest]);
        await client.query("commit");
        applied.push(name);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`${name} failed and was rolled back: ${(e as Error).message}`);
      }
    }

    if (opts.seed) {
      const seedDir = join(root, "db", "seed");
      for (const name of readdirSync(seedDir).filter((f) => f.endsWith(".sql")).sort()) {
        const key = `seed/${name}`;
        if (done.has(key)) continue;
        const body = readFileSync(join(seedDir, name), "utf8");
        log(`seeding ${name}`);
        // seed files carry their own begin/commit
        await client.query(body);
        await client.query("insert into schema_migration (filename, sha256) values ($1, $2)", [key, sha(body)]);
        applied.push(key);
      }
    }

    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK]).catch(() => {});
    await client.end();
  }
}

// run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate({ seed: process.env.ERP_SEED === "placeholder" })
    .then((a) => {
      console.log(a.length ? `ok, ${a.length} applied` : "ok, nothing to do");
      process.exit(0);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
