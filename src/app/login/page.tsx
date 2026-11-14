import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { oidcConfig, safeNext } from "@/lib/oidc";
import { prisma } from "@/lib/prisma";
import { signIn } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ err?: string; next?: string; ok?: string; password?: string }> }) {
  const sp = await searchParams;
  // Already signed in: go where the link pointed, not always to the release list.
  if (await currentUser()) redirect(safeNext(sp.next ?? ""));
  const users = await prisma.user.count();
  const sso = oidcConfig();
  // With single sign-on only, the password form stays reachable at /login?password=1 for a break-glass Admin.
  const showPassword = !sso?.only || sp.password === "1";

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1 style={{ marginTop: 0 }}>Sign in</h1>
        <p className="muted">QA Workflow keeps release evidence and sign-offs, so every action is tied to the person who took it.</p>
        {sp.err && <div className="notice bad" role="alert">{sp.err}</div>}
        {sp.ok && <div className="notice ok" role="status">{sp.ok}</div>}
        {sso && (
          <div className="stack" style={{ marginBottom: "1rem" }}>
            <a className="btn" href={`/login/oidc${sp.next ? `?next=${encodeURIComponent(sp.next)}` : ""}`}>{sso.label}</a>
            {showPassword && <p className="muted" style={{ margin: 0, textAlign: "center" }}>or with a password</p>}
          </div>
        )}
        {!showPassword ? null : users === 0 ? (
          <div className="notice warn">
            <p style={{ margin: 0 }}><strong>No accounts yet.</strong> Create the first Admin on the server, from the project folder:</p>
            <pre className="block" style={{ marginTop: ".5rem" }}>npm run user:create -- --email you@company.com --name &quot;Your Name&quot; --role Admin</pre>
            <p className="muted" style={{ marginBottom: 0 }}>It asks for the password, or reads it from QA_NEW_PASSWORD. Then sign in here.</p>
          </div>
        ) : (
          <form action={signIn} className="stack">
            <input type="hidden" name="next" value={sp.next ?? ""} />
            <label><span>Email</span><input name="email" type="email" autoComplete="username" required autoFocus /></label>
            <label><span>Password</span><input name="password" type="password" autoComplete="current-password" required /></label>
            <div><button type="submit">Sign in</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
