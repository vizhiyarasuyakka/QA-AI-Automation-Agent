import JSZip from "jszip";
import { prisma } from "@/lib/prisma";

const CONFIG = `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  reporter: [["list"], ["json", { outputFile: "results.json" }]],
  use: { baseURL: process.env.BASE_URL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scriptId = new URL(req.url).searchParams.get("script");
  if (scriptId) {
    const s = await prisma.automationScript.findUnique({ where: { id: scriptId } });
    if (!s || s.releaseId !== id) return new Response("Script not found", { status: 404 });
    return new Response(s.code, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${s.fileName}"` } });
  }
  const [release, scripts] = await Promise.all([prisma.release.findUnique({ where: { id } }), prisma.automationScript.findMany({ where: { releaseId: id } })]);
  if (!release || !scripts.length) return new Response("No scripts stored", { status: 404 });
  const zip = new JSZip();
  zip.file("playwright.config.ts", CONFIG);
  for (const s of scripts) zip.file(`tests/${s.fileName}`, s.code);
  const body = await zip.generateAsync({ type: "uint8array" });
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${release.name.replace(/[^a-z0-9_-]+/gi, "_")}-playwright.zip"` } });
}
