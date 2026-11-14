import { audit, currentUser, endSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** POST only, so a link or an image on another page cannot sign a person out. */
export async function POST(req: Request) {
  const user = await currentUser();
  if (user) await audit(user, "logout");
  await endSession();
  return Response.redirect(new URL("/login?ok=Signed%20out", req.url), 303);
}
