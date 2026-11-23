import {
  ArticleAnalysisSchema,
  type ArticleAnalysis,
  type ArticleAnalysisInput,
} from "@/domain/console/article-analysis";
import { CALENDAR_VERSION } from "@/domain/calendar/extraction";
import { validateArticleAnalysis } from "@/lib/ingestion/article-validation";
import { articleText } from "@/lib/ingestion/article-text";
import { calendarInput } from "@/lib/ingestion/calendar-extraction";
import type { SqlDatabase } from "../assistant/database";
import { analysisStatements } from "../console/article-analysis";
import { imageActivity, type ImageActivitySource } from "./image-activity";

/** Activities produced by OCR are identifiable and can be replaced safely. */
function fromImage(activity: ArticleAnalysis["activities"][number]) {
  return (
    activity.calendar?.reason === "image_ocr" ||
    activity.calendar?.reason === "deadline_only" ||
    activity.evidence.some((e) => e.sourceId?.startsWith("image:"))
  );
}

function manual(activity: ArticleAnalysis["activities"][number]) {
  return (
    (activity as { manual?: boolean }).manual === true ||
    activity.calendar?.reason === "manual"
  );
}

function keyOf(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s|｜:：,，。.、()（）\-—_/]/g, "")
    .slice(0, 40);
}

function sameTitle(a: string, b: string) {
  const x = keyOf(a),
    y = keyOf(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * Merge image OCR into the same analysis projection as the body. The function
 * never edits article_activity_index directly: it validates an ArticleAnalysis
 * and hands it to analysisStatements, which owns projection_hash and index
 * writes.
 */
export async function projectImageActivity(
  db: SqlDatabase,
  documentId: string,
): Promise<"projected" | "skipped" | "conflict"> {
  const doc = await db
    .prepare(
      `SELECT d.id,d.content_revision,d.input_hash,d.title,d.body,d.body_format,d.body_status,d.source_id,d.url,d.published_at,d.content_type,d.rights_scope,s.display_name,
              x.analysis_json,x.projection_hash
       FROM knowledge_documents d
       JOIN knowledge_sources s ON s.id=d.source_id
       JOIN document_article_analysis x ON x.document_id=d.id AND x.content_revision=d.content_revision AND x.input_hash=d.input_hash
       WHERE d.id=? AND d.owner_user_id IS NULL AND d.data_domain<>'user_private'
         AND EXISTS(SELECT 1 FROM console_public_documents p WHERE p.id=d.id AND p.version=d.version)`,
    )
    .bind(documentId)
    .first<Record<string, string | number | null>>();
  if (!doc?.analysis_json) return "skipped";
  const revision = Number(doc.content_revision),
    inputHash = String(doc.input_hash);
  const images = await db
    .prepare(
      `SELECT id,url,locator,digest,structured_json,ocr_text FROM article_images
       WHERE document_id=? AND status='ready' AND structured_json IS NOT NULL
         AND content_revision=? AND input_hash=? ORDER BY created_at LIMIT 4`,
    )
    .bind(documentId, revision, inputHash)
    .all<{
      id: string;
      url: string;
      locator: string;
      digest: string | null;
      structured_json: string;
      ocr_text: string;
    }>();
  if (!images.results.length) return "skipped";

  const base: ArticleAnalysisInput = calendarInput({
    documentId,
    title: String(doc.title),
    body: String(doc.body || ""),
    bodyFormat: doc.body_format === "reading_html" ? "reading_html" : "plain",
    bodyStatus: doc.body_status as ArticleAnalysisInput["bodyStatus"],
    sourceId: String(doc.source_id),
    sourceName: String(doc.display_name),
    originalUrl: String(doc.url),
    publishedAt: doc.published_at ? String(doc.published_at) : null,
  });
  const analysis = ArticleAnalysisSchema.parse(JSON.parse(String(doc.analysis_json)));
  const kept = analysis.activities.filter((a) => !fromImage(a));
  const imageSources = new Map<string, ImageActivitySource>();
  for (const image of images.results) {
    imageSources.set(`image:${image.id}`, {
      id: `image:${image.id}`,
      url: image.url,
      locator: image.locator,
      digest: image.digest || image.id,
      text: image.ocr_text.trim(),
    });
  }
  // A retained body/table activity may still cite its table source. Keep those
  // sources, then spend the remaining four-source budget on images.
  const required = new Set(
    kept.flatMap((a) =>
      a.evidence.map((e) => e.sourceId).filter((id): id is string => !!id),
    ),
  );
  // The stored projection may cite sources that calendarInput no longer
  // reconstructs (for example media extracted from the article body). Reuse
  // the saved analysis sources first so their offsets still line up.
  const knownSources = new Map(
    [...(base.calendarSources ?? []), ...(analysis.calendar?.sources ?? [])].map((s) => [s.id, s]),
  );
  const keptSources = [...required]
    .map((id) => knownSources.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s);
  const room = Math.max(0, 4 - keptSources.length);
  const selectedImages = [...imageSources.values()].slice(0, room);
  const selected = new Set(selectedImages.map((s) => s.id));
  const imageActivities = images.results
    .map((image) => {
      const source = imageSources.get(`image:${image.id}`)!;
      if (!selected.has(source.id)) return null;
      try {
        return imageActivity(analysis, image.id, source, image.structured_json);
      } catch {
        return null;
      }
    })
    .filter((a): a is NonNullable<typeof a> => !!a);
  if (!imageActivities.length) return "skipped";

  const merged = [...kept];
  for (const image of imageActivities) {
    const existing = merged.find(
      (a) => !manual(a) && sameTitle(a.title, image.title),
    );
    if (existing) {
      // Body supplies the title; the image may fill a missing date, room or
      // speaker. Conflicting non-null values are preserved as two activities
      // rather than silently overwritten.
      if (!existing.startsAt && image.startsAt) {
        existing.startsAt = image.startsAt;
        existing.endsAt = image.endsAt;
      } else if (
        existing.startsAt?.date &&
        image.startsAt?.date &&
        existing.startsAt.date !== image.startsAt.date
      ) {
        merged.push(image);
        continue;
      }
      if (!existing.placeRaw && image.placeRaw) existing.placeRaw = image.placeRaw;
      if (!existing.organizer && image.organizer) existing.organizer = image.organizer;
      existing.evidence = [...existing.evidence, ...image.evidence].slice(0, 20);
      existing.registrationWindows = [
        ...existing.registrationWindows,
        ...image.registrationWindows,
      ].slice(0, 12);
      if (image.calendar) existing.calendar = image.calendar;
    } else {
      merged.push(image);
    }
  }

  const eligible = merged.some((a) => a.calendar?.eligible && a.startsAt?.date);
  const calendarSources = [
    ...keptSources,
    ...selectedImages.map((s) => ({
      id: s.id,
      kind: "image" as const,
      url: s.url,
      locator: s.locator,
      digest: s.digest,
      text: s.text.slice(0, 24000),
      method: "image-ocr",
    })),
  ].slice(0, 4);
  const next: ArticleAnalysis = {
    ...analysis,
    bodyAvailable: articleText(base).bodyAvailable,
    activities: merged.slice(0, 40),
    calendar: {
      version: CALENDAR_VERSION,
      status: eligible ? "accepted" : "excluded",
      reason: eligible ? "image_ocr" : "deadline_only",
      sources: calendarSources,
      attempts: analysis.calendar?.attempts ?? 0,
    },
  };
  const checked = validateArticleAnalysis(
    { ...base, calendarSources: next.calendar!.sources },
    next,
  );
  await db.batch(
    await analysisStatements(
      db,
      documentId,
      revision,
      inputHash,
      { ...base, calendarSources: next.calendar!.sources },
      checked,
      String(doc.rights_scope || ""),
      String(doc.projection_hash),
    ),
  );
  return "projected";
}

/**
 * Retry ready images whose projection failed or was never attempted. This does
 * not call the vision model, so a transient D1 error cannot burn OCR budget.
 */
export async function projectPendingImages(db: SqlDatabase, limit = 3) {
  const rows = await db
    .prepare(
      `SELECT document_id FROM article_images
       WHERE status='ready' AND projected_at IS NULL AND structured_json IS NOT NULL
       GROUP BY document_id ORDER BY MIN(updated_at) LIMIT ?`,
    )
    .bind(limit)
    .all<{ document_id: string }>();
  let projected = 0,
    failed = 0;
  for (const row of rows.results) {
    try {
      const outcome = await projectImageActivity(db, row.document_id);
      if (outcome === "projected") projected++;
      await db
        .prepare(
          "UPDATE article_images SET projected_at=?,projection_error=NULL WHERE document_id=? AND status='ready'",
        )
        .bind(new Date().toISOString(), row.document_id)
        .run();
    } catch (error) {
      failed++;
      await db
        .prepare(
          "UPDATE article_images SET projection_error=? WHERE document_id=? AND status='ready'",
        )
        .bind(
          (error instanceof Error ? error.message : "IMAGE_PROJECTION_FAILED").slice(0, 120),
          row.document_id,
        )
        .run();
    }
  }
  return { projected, failed };
}
