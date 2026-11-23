import type { SqlDatabase } from "../assistant/database";
import type { ImageVision } from "@/domain/ingestion/image-vision";
import { ftsExpression } from "@/lib/retrieval/terms";

const SUMMARY_FIELDS = [
  ["title", "标题"],
  ["startsAt", "时间"],
  ["endsAt", "结束"],
  ["timeText", "时段"],
  ["place", "地点"],
  ["speaker", "主讲人"],
  ["registration", "报名方式"],
  ["deadline", "截止时间"],
  ["organizer", "主办"],
] as const;

export function imageVisionSummary(vision: ImageVision) {
  const lines: string[] = [];
  for (const [key, label] of SUMMARY_FIELDS) {
    const field = vision[key];
    if (field.value) lines.push(`${label}：${field.value}`);
  }
  return lines.join("；");
}

/** Ready OCR rows for one article. Never reads rows from another document. */
export async function articleImageEvidence(
  db: SqlDatabase,
  documentId: string,
  max = 2,
) {
  const rows = await db
    .prepare(
      "SELECT url,ocr_text,structured_json,conflicts_json FROM article_images WHERE document_id=? AND status='ready' ORDER BY created_at LIMIT ?",
    )
    .bind(documentId, max)
    .all<{
      url: string;
      ocr_text: string;
      structured_json: string;
      conflicts_json: string | null;
    }>();
  return rows.results.map((row) => {
    let vision: ImageVision | null = null;
    try {
      vision = JSON.parse(row.structured_json) as ImageVision;
    } catch {}
    return {
      url: row.url,
      text: row.ocr_text,
      summary: vision ? imageVisionSummary(vision) : "",
      conflicts: row.conflicts_json
        ? (JSON.parse(row.conflicts_json) as unknown[])
        : [],
    };
  });
}

/** One compact block for the article's source card snippet. */
export async function articleImageSnippet(
  db: SqlDatabase,
  documentId: string,
  max = 2,
) {
  const rows = await articleImageEvidence(db, documentId, max);
  if (!rows.length) return "";
  return rows
    .map((row, index) => {
      const head = `图片${index + 1} OCR${row.summary ? `：${row.summary}` : ""}`;
      const conflict = row.conflicts.length
        ? "\n图片与正文存在不一致，两个版本都保留。"
        : "";
      return `${head}\n${row.text.slice(0, 260)}${conflict}`;
    })
    .join("\n\n")
    .slice(0, 600);
}

/** First ready image for a card's optional "view original image" link. */
export async function articleImageUrl(
  db: SqlDatabase,
  documentId: string,
) {
  const row = await db
    .prepare(
      "SELECT url FROM article_images WHERE document_id=? AND status='ready' ORDER BY created_at LIMIT 1",
    )
    .bind(documentId)
    .first<{ url: string }>();
  return row?.url;
}

/**
 * Keyword hits in OCR text resolve to article ids only. The caller must read
 * the article through the normal retriever so scope/rights checks still apply.
 */
export async function imageOcrDocumentIds(
  db: SqlDatabase,
  query: string,
  limit = 8,
) {
  const expression = ftsExpression(query);
  if (!expression) return [];
  let ids: string[] = [];
  try {
    const rows = await db
      .prepare(
        "SELECT DISTINCT document_id FROM article_image_fts WHERE article_image_fts MATCH ? LIMIT ?",
      )
      .bind(expression, limit)
      .all<{ document_id: string }>();
    ids = rows.results.map((row) => row.document_id);
  } catch {
    ids = [];
  }
  if (ids.length) return ids;
  // A copied article heading is often longer than the OCR text, so the bigram
  // query misses. If the user pasted the document title verbatim, bind that
  // ready image to its own document before giving up.
  try {
    const exact = await db
      .prepare(
        "SELECT DISTINCT i.document_id FROM article_images i JOIN knowledge_documents d ON d.id=i.document_id WHERE i.status='ready' AND length(d.title)>=6 AND instr(replace(replace(replace(?,' ',''),'：',''),':',''),replace(replace(replace(d.title,' ',''),'：',''),':',''))>0 LIMIT ?",
      )
      .bind(query, limit)
      .all<{ document_id: string }>();
    return exact.results.map((row) => row.document_id);
  } catch {
    return [];
  }
}
