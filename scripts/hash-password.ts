// A scrypt hash of a password, for an operator entry in ERP_LOGINS
// ("name:scrypt$..."), so the password itself never sits in Render's settings.
//   node --experimental-strip-types scripts/hash-password.ts
// It asks for the password (or reads it from stdin) and prints the hash.
import { createInterface } from "node:readline";
import { scryptSync, randomBytes } from "node:crypto";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
const pw: string = await new Promise((r) => rl.question("Password (10 characters or more): ", (a) => { rl.close(); r(a); }));
if (pw.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
const salt = randomBytes(16);
const h = scryptSync(pw.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
console.log(`scrypt$16384$8$1$${salt.toString("base64url")}$${h.toString("base64url")}`);
