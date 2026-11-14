// Encrypts secrets saved before encryption existed: test-account passwords, API sign-in values and integration tokens.
// Safe to run again: values already encrypted are left alone. Needs SECRETS_KEY in .env.
//   npm run secrets:encrypt
import { createCipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const PREFIX = "enc:v1:";
const key = Buffer.from(process.env.SECRETS_KEY ?? "", "base64");
if (key.length !== 32) { console.error("SECRETS_KEY is missing or not 32 bytes. Run npm run keys -- --write first."); process.exit(1); }

// Same format as src/lib/secrets.ts encryptSecret.
function encrypt(plain) {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

const prisma = new PrismaClient();
let n = 0;
try {
  for (const b of await prisma.build.findMany({ where: { loginPassword: { not: "" } }, select: { id: true, loginPassword: true } })) {
    if (b.loginPassword.startsWith(PREFIX)) continue;
    await prisma.build.update({ where: { id: b.id }, data: { loginPassword: encrypt(b.loginPassword) } });
    n++;
  }
  for (const t of await prisma.apiTarget.findMany({ where: { authValue: { not: "" } }, select: { id: true, authValue: true } })) {
    if (t.authValue.startsWith(PREFIX)) continue;
    await prisma.apiTarget.update({ where: { id: t.id }, data: { authValue: encrypt(t.authValue) } });
    n++;
  }
  for (const s of await prisma.setting.findMany({ where: { key: { in: ["BUG_WEBHOOK_TOKEN", "BUG_MCP_TOKEN", "IMPORT_TOKEN"] }, value: { not: "" } } })) {
    if (s.value.startsWith(PREFIX)) continue;
    await prisma.setting.update({ where: { key: s.key }, data: { value: encrypt(s.value) } });
    n++;
  }
  console.log(n ? `Encrypted ${n} stored secret${n === 1 ? "" : "s"}.` : "Nothing to encrypt: every stored secret is already encrypted.");
} finally {
  await prisma.$disconnect();
}
