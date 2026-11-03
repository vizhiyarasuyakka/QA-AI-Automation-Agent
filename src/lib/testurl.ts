import { prisma } from "./prisma";

const BAD_URL = "Enter the full address to test, starting with https://";

/** The address exactly as typed, when it is a web address Chrome can open. */
export function checkTestUrl(raw: string): string | null {
  const url = raw.trim();
  try {
    return ["http:", "https:"].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The release's current build holds the results; this keeps the address to test on it and plans every case. */
export async function setTestUrl(releaseId: string, raw: string, login?: { user: string; password: string }): Promise<{ error: string } | { build: { id: string; envUrl: string } }> {
  const url = checkTestUrl(raw);
  if (!url) return { error: BAD_URL };
  const latest = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" } });
  let build = latest;
  if (!build) {
    const host = new URL(url).host;
    const taken = new Set((await prisma.build.findMany({ where: { releaseId }, select: { number: true } })).map((b) => b.number));
    let number = host;
    for (let i = 2; taken.has(number); i++) number = `${host} (${i})`;
    build = await prisma.build.create({ data: { releaseId, number, envUrl: url } });
  } else if (build.envUrl !== url) {
    build = await prisma.build.update({ where: { id: build.id }, data: { envUrl: url } });
  }
  // A blank user name forgets the sign-in; a blank password keeps the one already saved.
  if (login) {
    const user = login.user.trim();
    const data = !user ? { loginUser: "", loginPassword: "" } : login.password ? { loginUser: user, loginPassword: login.password } : { loginUser: user };
    build = await prisma.build.update({ where: { id: build.id }, data });
  }
  await planCases(releaseId);
  return { build };
}

/** Every test case of the release waits to run on the URL to test. Nothing is approved first: step 4 runs by acceptance criterion. */
export async function planCases(releaseId: string) {
  const build = await prisma.build.findFirst({ where: { releaseId }, orderBy: { deployedAt: "desc" }, select: { id: true } });
  if (!build) return;
  const cases = await prisma.testCase.findMany({ where: { story: { releaseId } }, select: { id: true } });
  await prisma.execution.createMany({ data: cases.map((c) => ({ buildId: build.id, testCaseId: c.id })), skipDuplicates: true });
}

/** How every browser run uses the test account typed in step 4 or 5. */
export const SIGN_IN_RULE = "If the application asks you to sign in and a test account is given, sign in with it on this site's own sign-in page, then go back and carry on. Enter the account nowhere else and never repeat the password in your answer. If sign-in is needed and no account is given, or the account is refused, report Blocked and say why.";

export function accountLine(build: { loginUser: string; loginPassword: string }) {
  return build.loginUser ? `Test account for this site: user name ${JSON.stringify(build.loginUser)}, password ${JSON.stringify(build.loginPassword)}.` : "No test account was given.";
}

/** Addresses Claude in Chrome, driven from Claude Code, will not open: this machine and private networks. Step 4 runs these in a Chrome window of its own. */
export function isLocalAddress(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local") || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch {
    return false;
  }
}
