// Frees database space taken by old evidence. Shows what it would free unless --apply is given.
//   npm run retention                    # dry run: counts and sizes only
//   npm run retention -- --apply         # do it
//   options: --evidence-days=30 --keep-scans=5 --job-days=90 --ai-days=365
//
// Removes only what can be made again by running the check again:
//   - screenshots of runs older than --evidence-days (the result, text and differences stay; the picture goes)
//   - Playwright end-of-test screenshots on builds that are not a release's latest
//   - the ZAP HTML report and log of all but each release's newest --keep-scans scans (findings stay)
//   - finished run logs older than --job-days, keeping each release's newest run of every kind
//   - AI usage rows older than --ai-days
// Never touched: uploaded documents and prototypes, test cases, results, bugs, sign-offs, the audit log.
import { PrismaClient } from "@prisma/client";

const arg = (name, def) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.split("=")[1]) : def;
  if (!Number.isFinite(n) || n < 1) { console.error(`--${name} must be a positive number`); process.exit(1); }
  return n;
};
const apply = process.argv.includes("--apply");
const evidenceDays = arg("evidence-days", 30), keepScans = arg("keep-scans", 5), jobDays = arg("job-days", 90), aiDays = arg("ai-days", 365);
const ago = (days) => new Date(Date.now() - days * 86400_000);

/** Each rule: what it does, a query that measures it, and the statement that does it. Table and column names are fixed here, never from input. */
const rules = [
  ...[
    ["UiFlow", ["appShot", "protoShot"], "runAt"],
    ["StoryFlow", ["shot"], "runAt"],
    ["StoryCheck", ["shot"], "runAt"],
    ["UiTrigger", ["screenshot"], "runAt"],
    ["Prototype", ["matchShot", "matchProtoShot", "matchDiffShot"], "matchAt"],
  ].map(([table, cols, when]) => ({
    what: `${table} screenshots of runs older than ${evidenceDays} days`,
    where: `"${when}" < $1 and (${cols.map((c) => `"${c}" is not null`).join(" or ")})`,
    measure: `select count(*)::int as n, coalesce(sum(${cols.map((c) => `coalesce(octet_length("${c}"),0)`).join(" + ")}),0)::bigint as bytes from "${table}"`,
    run: `update "${table}" set ${cols.map((c) => `"${c}" = null`).join(", ")}`,
    params: [ago(evidenceDays)],
  })),
  {
    what: "Playwright screenshots on builds that are not their release's latest",
    where: `shot is not null and "buildId" not in (select distinct on ("releaseId") id from "Build" order by "releaseId", "deployedAt" desc)`,
    measure: `select count(*)::int as n, coalesce(sum(octet_length(shot)),0)::bigint as bytes from "Execution"`,
    run: `update "Execution" set shot = null`,
    params: [],
  },
  {
    what: `ZAP reports and logs beyond each release's newest ${keepScans} scans`,
    where: `("zapReport" <> '' or log <> '') and id not in (select id from (select id, row_number() over (partition by "releaseId" order by "startedAt" desc) as k from "SecurityScan") s where k <= $1)`,
    measure: `select count(*)::int as n, coalesce(sum(octet_length("zapReport") + octet_length(log)),0)::bigint as bytes from "SecurityScan"`,
    run: `update "SecurityScan" set "zapReport" = '', log = ''`,
    params: [keepScans],
  },
  {
    what: `finished run logs older than ${jobDays} days (each release's newest of every kind stays)`,
    where: `status <> 'Running' and "startedAt" < $1 and id not in (select distinct on ("releaseId", kind) id from "GenerationJob" order by "releaseId", kind, "startedAt" desc)`,
    measure: `select count(*)::int as n, coalesce(sum(octet_length(log)),0)::bigint as bytes from "GenerationJob"`,
    run: `delete from "GenerationJob"`,
    params: [ago(jobDays)],
  },
  {
    what: `AI usage rows older than ${aiDays} days`,
    where: `at < $1`,
    measure: `select count(*)::int as n, (count(*) * 200)::bigint as bytes from "AiCall"`,
    run: `delete from "AiCall"`,
    params: [ago(aiDays)],
  },
];

const mb = (b) => `${(Number(b) / 1024 / 1024).toFixed(1)} MB`;
const prisma = new PrismaClient();
try {
  let total = 0n;
  const found = [];
  for (const r of rules) {
    const [row] = await prisma.$queryRawUnsafe(`${r.measure} where ${r.where}`, ...r.params);
    found.push({ ...r, n: row.n, bytes: BigInt(row.bytes) });
    total += BigInt(row.bytes);
    console.log(`${String(row.n).padStart(6)} rows  ${mb(row.bytes).padStart(9)}  ${r.what}`);
  }
  console.log(`\n${apply ? "Freeing" : "Would free"} about ${mb(total)}.`);
  if (!apply) { console.log("Dry run: nothing changed. Run again with --apply to do it."); process.exit(0); }

  const todo = found.filter((r) => r.n > 0);
  const done = await prisma.$transaction(todo.map((r) => prisma.$executeRawUnsafe(`${r.run} where ${r.where}`, ...r.params)));
  await prisma.auditLog.create({ data: { action: "retention.apply", userEmail: "command line", detail: `freed about ${mb(total)}; ${todo.map((r, i) => `${done[i]} × ${r.what}`).join("; ")}` } });
  console.log("Done. Postgres reuses the space for new rows; run VACUUM FULL in a quiet hour to give it back to the disk.");
} finally {
  await prisma.$disconnect();
}
