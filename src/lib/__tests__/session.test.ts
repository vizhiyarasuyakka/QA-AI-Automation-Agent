import { describe, expect, it } from "vitest";
import { SESSION_HOURS, signSession, verifySession } from "../session";

const SECRET = "a".repeat(48);

describe("session cookie", () => {
  it("verifies what it signed", async () => {
    const token = await signSession({ sub: "user1", ver: 3 }, SECRET);
    const p = await verifySession(token, SECRET);
    expect(p).toMatchObject({ sub: "user1", ver: 3 });
  });

  it("refuses another secret", async () => {
    const token = await signSession({ sub: "user1", ver: 1 }, SECRET);
    expect(await verifySession(token, "b".repeat(48))).toBeNull();
  });

  it("refuses an edited payload, such as another user id", async () => {
    const token = await signSession({ sub: "user1", ver: 1 }, SECRET);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "admin", ver: 1, exp: 9999999999 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("expires", async () => {
    const issued = Date.now() - (SESSION_HOURS * 3600 + 60) * 1000;
    const token = await signSession({ sub: "user1", ver: 1 }, SECRET, issued);
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it("refuses junk", async () => {
    for (const t of [undefined, "", "abc", "a.b.c", "x.y"]) expect(await verifySession(t, SECRET)).toBeNull();
  });
});
