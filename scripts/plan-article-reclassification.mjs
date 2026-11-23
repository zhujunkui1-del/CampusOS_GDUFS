// Read-only historical reclassification planner.
// It never writes to a database. The generated SQL is guarded by the
// document's current revision/input hash and by the absence of a human
// classification override, and is safe to re-run: rows already at the new
// classifier/version are reported as unchanged and are not emitted.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const inputArg = process.argv.find((arg) => arg.startsWith("--input="));
const input = inputArg ? inputArg.slice("--input=".length) : ".tmp/samples.json";
const outDir = "test-results/article-reclassification";
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents:
      'export {analyzeArticle} from "./src/lib/ingestion/article-analysis";export {ARTICLE_CLASSIFIER_VERSION} from "./src/domain/console/article-analysis";',
    resolveDir: process.cwd(),
  },
  outfile: path.join(outDir, "classifier.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { analyzeArticle, ARTICLE_CLASSIFIER_VERSION } = await import(
  pathToFileURL(path.resolve(outDir, "classifier.mjs")).href +
    "?t=" +
    Date.now()
);

const raw = JSON.parse(readFileSync(input, "utf8"));
const rows = Array.isArray(raw)
  ? raw.flatMap((entry) => entry?.results || entry)
  : raw[0]?.results || raw.results || [];
if (!Array.isArray(rows) || !rows.length) throw Error("NO_INPUT_ROWS");

const plan = {
  generatedAt: new Date().toISOString(),
  classifierVersion: ARTICLE_CLASSIFIER_VERSION,
  source: input,
  readOnly: true,
  proposed: [],
  unchanged: [],
  skipped: [],
};

for (const row of rows) {
  if (!row.id || !row.title) {
    plan.skipped.push({ id: row.id ?? null, reason: "missing_identity" });
    continue;
  }
  if (!row.content_revision || !row.input_hash) {
    plan.skipped.push({ id: row.id, reason: "missing_revision_guard" });
    continue;
  }
  if (row.override_document_id) {
    plan.skipped.push({ id: row.id, reason: "human_override_preserved" });
    continue;
  }
  const analysis = analyzeArticle({
    title: row.title,
    body: row.body || "",
    bodyFormat: row.body_format === "reading_html" ? "reading_html" : "plain",
    bodyStatus: row.body_status || "not_provided",
    publishedAt: row.published_at,
    originalUrl: row.url,
    sourceName: row.display_name || row.source_name || "",
  });
  const before = {
    primaryDestination: row.primary_destination ?? null,
    radarCategory: row.radar_category ?? null,
    knowledgeCategory: row.knowledge_category ?? null,
    classifierVersion: row.classifier_version ?? null,
  };
  const after = {
    primaryDestination: analysis.primaryDestination,
    radarCategory: analysis.radarCategory,
    knowledgeCategory: analysis.knowledgeCategory,
  };
  const unchanged =
    before.primaryDestination === after.primaryDestination &&
    before.radarCategory === after.radarCategory &&
    before.knowledgeCategory === after.knowledgeCategory &&
    before.classifierVersion === ARTICLE_CLASSIFIER_VERSION;
  const record = {
    id: row.id,
    title: row.title,
    before,
    after,
    guard: {
      contentRevision: row.content_revision,
      inputHash: row.input_hash,
    },
  };
  if (unchanged) plan.unchanged.push(record);
  else plan.proposed.push(record);
}

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const statements = plan.proposed.map((record) => {
  const row = rows.find((candidate) => candidate.id === record.id);
  const prior = row.analysis_json ? JSON.parse(row.analysis_json) : null;
  const analysis = analyzeArticle({
    title: row.title,
    body: row.body || "",
    bodyFormat: row.body_format === "reading_html" ? "reading_html" : "plain",
    bodyStatus: row.body_status || "not_provided",
    publishedAt: row.published_at,
    originalUrl: row.url,
    sourceName: row.display_name || row.source_name || "",
  });
  // Keep the already-published calendar projection; this plan only changes
  // classification. Re-extracting activities is a separate reviewed step.
  const projection =
    prior?.calendar
      ? {
          ...analysis,
          activities: prior.activities,
          calendar: prior.calendar,
        }
      : analysis;
  const projectionJson = JSON.stringify(projection);
  const projectionHash = hash(projectionJson);
  const stamp = new Date().toISOString();
  record.guard.projectionHash = row.projection_hash ?? null;
  record.after.projectionHash = projectionHash;
  record.after.processedAt = stamp;
  return {
    id: record.id,
    sql: `UPDATE document_article_analysis
SET primary_destination=${sqlString(record.after.primaryDestination)},
    radar_category=${record.after.radarCategory === null ? "NULL" : sqlString(record.after.radarCategory)},
    knowledge_category=${record.after.knowledgeCategory === null ? "NULL" : sqlString(record.after.knowledgeCategory)},
    classifier_version=${sqlString(ARTICLE_CLASSIFIER_VERSION)},
    projection_hash=${sqlString(projectionHash)},
    processed_at=${sqlString(stamp)},
    analysis_json=${sqlString(projectionJson)}
WHERE document_id=${sqlString(record.id)}
  AND content_revision=${record.guard.contentRevision}
  AND input_hash=${sqlString(record.guard.inputHash)}
  AND projection_hash IS ${row.projection_hash === null || row.projection_hash === undefined ? "NULL" : sqlString(row.projection_hash)}
  AND NOT EXISTS (SELECT 1 FROM document_classification_overrides m WHERE m.document_id=document_article_analysis.document_id)
  AND (primary_destination IS NOT ${sqlString(record.after.primaryDestination)}
    OR radar_category IS NOT ${record.after.radarCategory === null ? "NULL" : sqlString(record.after.radarCategory)}
    OR knowledge_category IS NOT ${record.after.knowledgeCategory === null ? "NULL" : sqlString(record.after.knowledgeCategory)}
    OR classifier_version IS NOT ${sqlString(ARTICLE_CLASSIFIER_VERSION)}
    OR projection_hash IS NOT ${sqlString(projectionHash)});`,
  };
});

const summary = {
  read: rows.length,
  proposed: plan.proposed.length,
  unchanged: plan.unchanged.length,
  skipped: plan.skipped.length,
};
writeFileSync(
  path.join(outDir, "plan.json"),
  JSON.stringify({ ...plan, summary }, null, 2) + "\n",
);
writeFileSync(
  path.join(outDir, "plan.sql"),
  `-- Generated read-only plan. Review before applying to any database.
-- Guards: current content_revision/input_hash/projection_hash, no human override, and a
-- null-safe "not already at this value" check make the statements idempotent.
${statements.map((item) => `-- ${item.id}\n${item.sql}`).join("\n\n")}\n`,
);
writeFileSync(
  path.join(outDir, "plan-statements.json"),
  JSON.stringify(
    statements.map((item) => ({ id: item.id, sql: item.sql })),
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    mode: "plan",
    readOnly: true,
    classifierVersion: ARTICLE_CLASSIFIER_VERSION,
    output: path.join(outDir, "plan.json"),
    sql: path.join(outDir, "plan.sql"),
    ...summary,
  }),
);
