// Prints new AUTH_SECRET and SECRETS_KEY values. With --write, adds the ones .env is missing (never replaces a key:
// a new SECRETS_KEY would make every stored secret unreadable).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const keys = {
  AUTH_SECRET: randomBytes(48).toString("base64url"),
  SECRETS_KEY: randomBytes(32).toString("base64"),
};

if (!process.argv.includes("--write")) {
  for (const [k, v] of Object.entries(keys)) console.log(`${k}="${v}"`);
  console.log("\nAdd these to .env (or run npm run keys -- --write). Keep SECRETS_KEY safe: without it, stored passwords and tokens cannot be read.");
  process.exit(0);
}

const file = ".env";
const have = existsSync(file) ? readFileSync(file, "utf8") : "";
const added = [];
for (const [k, v] of Object.entries(keys)) {
  if (new RegExp(`^${k}=.+`, "m").test(have)) continue;
  appendFileSync(file, `${have.endsWith("\n") || !have ? "" : "\n"}# Added by npm run keys\n${k}="${v}"\n`);
  added.push(k);
}
console.log(added.length ? `Added to .env: ${added.join(", ")}. Restart the app.` : ".env already has AUTH_SECRET and SECRETS_KEY; nothing changed.");
