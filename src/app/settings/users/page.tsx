import { Badge } from "@/components/Badge";
import { Notice } from "@/components/Notice";
import { MIN_PASSWORD, ROLES, requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createUser, resetPassword, updateUser } from "./actions";

export const dynamic = "force-dynamic";

const RIGHTS: Record<string, string> = {
  Admin: "Everything, plus users, integrations and the audit log.",
  "QA Lead": "Sign-off, release status, deleting releases and bugs, editing Playwright scripts, choosing the AI connection.",
  "QA Engineer": "Upload, generate, review, run tests, log and update bugs.",
  Viewer: "Read only. Every change is refused.",
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const sp = await searchParams;
  const me = await requireRole("Admin", "manage users");
  const users = await prisma.user.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] });

  return (
    <>
      <h1>Users and roles</h1>
      <p className="muted">Each person signs in with their own account, so sign-offs, deletions and script edits name who did them. Changing a role or deactivating someone signs them out at once.</p>
      <Notice searchParams={sp} />

      <div className="grid-2">
        <div className="card">
          <h3>Add a user</h3>
          <form action={createUser} className="stack">
            <label><span className="req">Name</span><input name="name" required /></label>
            <label><span className="req">Email</span><input name="email" type="email" required autoComplete="off" /></label>
            <label><span className="req">Role</span><select name="role" defaultValue="QA Engineer">{ROLES.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label><span className="req">First password ({MIN_PASSWORD}+ characters, letters and a digit)</span><input name="password" type="password" required minLength={MIN_PASSWORD} autoComplete="new-password" /></label>
            <div><button type="submit">Add user</button></div>
          </form>
        </div>
        <div className="card">
          <h3>What each role can do</h3>
          <table><tbody>{ROLES.map((r) => <tr key={r}><td style={{ whiteSpace: "nowrap" }}><strong>{r}</strong></td><td>{RIGHTS[r]}</td></tr>)}</tbody></table>
        </div>
      </div>

      <h2>Accounts ({users.length})</h2>
      <div className="card">
        <div className="tbox">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role and access</th><th>Last sign-in</th><th>Reset password</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name} {u.id === me.id && <Badge tone="accent">You</Badge>} {!u.active && <Badge tone="bad">Deactivated</Badge>}</td>
                  <td className="mono">{u.email}</td>
                  <td>
                    <form action={updateUser} className="row">
                      <input type="hidden" name="id" value={u.id} />
                      <select name="role" defaultValue={u.role} style={{ width: "auto" }}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
                      <label className="row" style={{ gap: ".3rem" }}><input type="checkbox" name="active" defaultChecked={u.active} style={{ width: "auto" }} /> Active</label>
                      <button type="submit" className="small secondary">Save</button>
                    </form>
                  </td>
                  <td className="muted">{u.lastLoginAt ? u.lastLoginAt.toLocaleString("en-IN") : "Never"}</td>
                  <td>
                    <form action={resetPassword} className="row">
                      <input type="hidden" name="id" value={u.id} />
                      <input name="password" type="password" placeholder="New password" minLength={MIN_PASSWORD} required autoComplete="new-password" />
                      <button type="submit" className="small secondary">Reset</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
