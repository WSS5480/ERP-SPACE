// Runs every retail module's checks. Prepare the database first:
//   ./db/apply.sh --reset --seed && npm run smoke && npm run smoke:modules
import { harness } from "./modules/harness.ts";
import { pool } from "../packages/core/db.ts";

const ORDER = ["setup", "catalog", "purchasing", "inventory", "pos", "ar", "workforce", "fleet", "shop", "crm"];

const { t, counts } = harness();
for (const id of ORDER) {
  let mod: { run?: (t: unknown) => Promise<void> };
  try { mod = await import(`./modules/${id}.ts`); } catch (e) {
    if ((e as { code?: string }).code === "ERR_MODULE_NOT_FOUND") continue;
    throw e;
  }
  if (!mod.run) continue;
  console.log(`\n== ${id}`);
  try { await mod.run(t); } catch (e) { t.ok(`${id}: ran to the end`, false, (e as Error).stack?.slice(0, 400)); }
}
const { passed, failed } = counts();
console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
