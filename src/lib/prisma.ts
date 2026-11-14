import { PrismaClient } from "@prisma/client";
import { decryptSecret } from "./secrets";

/**
 * Secrets are encrypted where they are written (testurl.ts, apitesting.ts, webhook.ts) and decrypted here on every
 * read, so the code that signs in to the build or calls the API keeps reading the plain value.
 */
function makeClient() {
  return new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] }).$extends({
    result: {
      build: { loginPassword: { needs: { loginPassword: true }, compute: (b) => decryptSecret(b.loginPassword) } },
      apiTarget: { authValue: { needs: { authValue: true }, compute: (t) => decryptSecret(t.authValue) } },
    },
  });
}

type Client = ReturnType<typeof makeClient>;
const globalForPrisma = globalThis as unknown as { prismaX?: Client };

export const prisma: Client = globalForPrisma.prismaX ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaX = prisma;
