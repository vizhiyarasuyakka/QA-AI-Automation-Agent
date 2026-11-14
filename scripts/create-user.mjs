// Creates a user from the server's command line, for the first Admin or when nobody can sign in.
//   npm run user:create -- --email lead@company.com --name "QA Lead" --role Admin
// The password comes from QA_NEW_PASSWORD, or is asked for (not shown while typed).
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";

const ROLES = ["Admin", "QA Lead", "QA Engineer", "Viewer"];
const scrypt = promisify(scryptCb);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? "" : "";
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

// Same format as src/lib/auth.ts hashPassword.
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const email = arg("email").trim().toLowerCase();
const name = arg("name").trim() || email.split("@")[0];
const role = arg("role") || "Admin";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error("Give --email you@company.com"); process.exit(1); }
if (!ROLES.includes(role)) { console.error(`--role must be one of: ${ROLES.join(", ")}`); process.exit(1); }

const password = process.env.QA_NEW_PASSWORD || (await askHidden(`Password for ${email}: `));
if (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) { console.error("The password needs at least 12 characters, with letters and a digit."); process.exit(1); }

const prisma = new PrismaClient();
try {
  const existing = await prisma.user.findUnique({ where: { email } });
  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.user.update({ where: { email }, data: { passwordHash, role, active: true, sessionVersion: { increment: 1 } } });
    console.log(`Updated ${email}: role ${role}, new password, reactivated.`);
  } else {
    await prisma.user.create({ data: { email, name, role, passwordHash } });
    console.log(`Created ${email} (${name}) as ${role}.`);
  }
  await prisma.auditLog.create({ data: { action: existing ? "user.update" : "user.create", userEmail: "command line", target: email, detail: `role ${role}, from scripts/create-user.mjs` } });
} finally {
  await prisma.$disconnect();
}
