import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { API_HELPERS, API_RUN_CONFIG, postmanCollection, projectReadme, specFileName, specFor } from "@/lib/apitesting";

export const dynamic = "force-dynamic";

/** The API tests as a Playwright project (?kind=playwright, a zip) or a Postman collection (?kind=postman, JSON). The sign-in value is never in either. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const kind = new URL(req.url).searchParams.get("kind") ?? "playwright";
  const [release, target, endpoints] = await Promise.all([
    prisma.release.findUnique({ where: { id } }),
    prisma.apiTarget.findUnique({ where: { releaseId: id } }),
    prisma.apiEndpoint.findMany({ where: { releaseId: id }, orderBy: { no: "asc" }, include: { tests: { orderBy: { testId: "asc" } } } }),
  ]);
  const withTests = endpoints.filter((e) => e.tests.length);
  if (!release || !withTests.length) return new Response("No API tests yet", { status: 404 });
  const safe = release.name.replace(/[^a-z0-9_-]+/gi, "_");
  if (kind === "postman") {
    return new Response(JSON.stringify(postmanCollection(release.name, target, withTests), null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${safe}-api-tests.postman_collection.json"` } });
  }
  const zip = new JSZip();
  zip.file("playwright.config.ts", API_RUN_CONFIG);
  zip.file("README.md", projectReadme(target?.baseUrl ?? "", target?.authHeader ?? ""));
  zip.file("tests/helpers.ts", API_HELPERS);
  for (const e of withTests) zip.file(`tests/${specFileName(e)}`, specFor(e, e.tests));
  const body = await zip.generateAsync({ type: "uint8array" });
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${safe}-api-tests.zip"` } });
}
