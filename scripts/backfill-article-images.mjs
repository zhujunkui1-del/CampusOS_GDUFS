#!/usr/bin/env node
/**
 * Queue the images of existing articles for OCR.
 *
 * The normal ingestion path queues images through analysisStatements. Historic
 * rows predate that queue, so this script only inserts article_images rows (the
 * same shape imageQueueStatements writes) and lets the scheduled worker perform
 * OCR and the projection. It never writes article_activity_index directly and
 * refuses rows whose revision/input_hash no longer match.
 *
 * Usage:
 *   node scripts/backfill-article-images.mjs --ids=ids.json [--write]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const idsFile = args.find((a) => a.startsWith("--ids="))?.slice(6);
const write = args.includes("--write");
if (!idsFile) {
  console.error("need --ids=<json array of document ids>");
  process.exit(1);
}
const ids = JSON.parse(readFileSync(idsFile, "utf8"));
const list = (Array.isArray(ids) ? ids : ids.ids || []).map((x) =>
  typeof x === "string" ? x : x.id,
);
if (!list.length) {
  console.error("empty id list");
  process.exit(1);
}

const IMAGE = /<img\b[^>]*?\b(?:data-src|src)\s*=\s*["']([^"']+)["']/gi;
const BLOCK = /logo|avatar|icon|qrcode|二维码|头图|banner|share|favicon/i;
function imagesOf(html, max = 6) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(IMAGE)) {
    const url = match[1].replaceAll("&amp;", "&").trim();
    if (
      !/^https:\/\/[a-z0-9.-]+\.(?:qpic\.cn|qlogo\.cn|gdufs\.edu\.cn)\//i.test(
        url,
      )
    )
      continue;
    if (BLOCK.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

function d1(sql) {
  const r = spawnSync(
    process.execPath,
    [
      "node_modules/wrangler/wrangler-dist/cli.js",
      "d1",
      "execute",
      "campusos-preview",
      "--remote",
      "--env",
      "preview",
      "--json",
      "--command",
      sql,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000" },
      maxBuffer: 40 * 1024 * 1024,
    },
  );
  const out = r.stdout || "";
  const at = out.split(/\r?\n/).findIndex((line) => /^\s*\[/.test(line));
  if (at < 0) throw new Error((r.stderr || out).slice(0, 500));
  return JSON.parse(out.split(/\r?\n/).slice(at).join("\n"))[0].results;
}

const stamp = new Date().toISOString();
const report = [];
for (const id of list) {
  const rows = d1(
    `SELECT id,title,body,content_revision,input_hash FROM knowledge_documents WHERE id='${id.replaceAll("'", "''")}' AND owner_user_id IS NULL AND data_domain<>'user_private'`,
  );
  if (!rows.length) {
    report.push({ id, queued: 0, reason: "not_found" });
    continue;
  }
  const row = rows[0];
  const urls = imagesOf(row.body);
  const statements = urls.map((url) => {
    const imageId = createHash("sha256")
      .update(`image:${row.id}:${url}`)
      .digest("hex");
    return `INSERT INTO article_images(id,document_id,content_revision,input_hash,url,locator,status,attempts,created_at,updated_at)
      SELECT '${imageId}','${row.id}',${row.content_revision},'${row.input_hash}','${url.replaceAll("'", "''")}','img[image]','pending',0,'${stamp}','${stamp}'
      FROM knowledge_documents d WHERE d.id='${row.id}' AND d.content_revision=${row.content_revision} AND d.input_hash='${row.input_hash}'
      ON CONFLICT(document_id,url) DO UPDATE SET
        content_revision=excluded.content_revision,input_hash=excluded.input_hash,
        status=CASE WHEN article_images.content_revision<>excluded.content_revision OR article_images.input_hash<>excluded.input_hash THEN 'pending' ELSE article_images.status END,
        attempts=CASE WHEN article_images.content_revision<>excluded.content_revision OR article_images.input_hash<>excluded.input_hash THEN 0 ELSE article_images.attempts END,
        projected_at=CASE WHEN article_images.content_revision<>excluded.content_revision OR article_images.input_hash<>excluded.input_hash THEN NULL ELSE article_images.projected_at END,
        updated_at=excluded.updated_at;`;
  });
  if (!write) {
    report.push({ id, title: row.title, queued: statements.length, urls });
    continue;
  }
  let changes = 0;
  for (const sql of statements) {
    try {
      const result = d1(sql);
      changes += Number(result[0]?.meta?.changes || 0);
    } catch (error) {
      report.push({
        id,
        title: row.title,
        queued: 0,
        error: String(error.message || error).slice(0, 200),
      });
    }
  }
  report.push({ id, title: row.title, queued: statements.length, changes });
}

mkdirSync("test-results/image-backfill", { recursive: true });
const file = `test-results/image-backfill/enqueue-${stamp.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify({ stamp, write, report }, null, 2));
console.log(
  JSON.stringify(
    {
      file,
      articles: report.length,
      images: report.reduce((n, r) => n + (r.queued || 0), 0),
      changes: report.reduce((n, r) => n + (r.changes || 0), 0),
      errors: report.filter((r) => r.error).length,
    },
    null,
    2,
  ),
);
