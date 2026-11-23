import { Buffer } from "node:buffer";
import { z } from "zod";
import type { SqlDatabase } from "../assistant/database";
import type { CalendarAI } from "../calendar/enrichment";
import { downloadMedia } from "../calendar/enrichment";
import { normalizeImage } from "./image-normalize";
import {
  IMAGE_VISION_PROMPT,
  ImageVisionSchema,
  normalizeVisionFields,
  type ImageVision,
} from "@/domain/ingestion/image-vision";
import { lexicalTokens } from "@/lib/retrieval/terms";

export const DEFAULT_IMAGE_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const IMAGE_MODEL_VERSION = "image-vision-v1";
const MAX_ATTEMPTS = 3;

type Row = {
  id: string;
  document_id: string;
  content_revision: number;
  input_hash: string;
  url: string;
  locator: string;
  attempts: number;
  title: string;
  article_url: string;
  analysis_json: string | null;
};

function resultObject(raw: unknown): unknown {
  const r = raw as {
    response?: unknown;
    choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  };
  const truncated = r.choices?.[0]?.finish_reason === "length";
  let content = r.choices?.[0]?.message?.content ?? r.response ?? raw;
  if (typeof content === "string")
    try {
      content = JSON.parse(
        content
          .trim()
          .replace(/^```(?:json)?\s*/, "")
          .replace(/\s*```$/, ""),
      );
    } catch {
      if (truncated) throw Error("MODEL_TRUNCATED");
      throw Error("MODEL_INVALID_JSON");
    }
  return content;
}

async function sha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}

async function reserve(db: SqlDatabase, day: string, cap: number) {
  await db
    .prepare(
      "INSERT INTO image_ocr_budget(day,calls) VALUES(?,0) ON CONFLICT(day) DO NOTHING",
    )
    .bind(day)
    .run();
  const r = await db
    .prepare(
      "UPDATE image_ocr_budget SET calls=calls+1 WHERE day=? AND calls<?",
    )
    .bind(day, cap)
    .run();
  return (r.meta?.changes || 0) > 0;
}

async function bounded<T>(p: Promise<T>, ms = 150000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("MODEL_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function calendarDate(value: string): string {
  const match = value.match(/(\d{4})[\u5e74/.-](\d{1,2})[\u6708/.-](\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`
    : value.trim();
}

function conflictsWithBody(image: ImageVision, analysisJson: string | null) {
  if (!analysisJson) return [];
  let activities: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(analysisJson) as {
      activities?: Record<string, unknown>[];
    };
    activities = parsed.activities || [];
  } catch {
    return [];
  }
  const activity = activities[0];
  if (!activity) return [];
  const conflicts: {
    field: string;
    bodyValue: string;
    imageValue: string;
    imageEvidence: string;
  }[] = [];
  const starts = activity.startsAt as { date?: string } | undefined;
  if (
    image.startsAt.value &&
    starts?.date &&
    calendarDate(image.startsAt.value) !== calendarDate(starts.date)
  )
    conflicts.push({
      field: "startsAt",
      bodyValue: starts.date,
      imageValue: image.startsAt.value,
      imageEvidence: image.startsAt.evidence || "",
    });
  const place = typeof activity.placeRaw === "string" ? activity.placeRaw : "";
  if (image.place.value && place && image.place.value !== place)
    conflicts.push({
      field: "place",
      bodyValue: place,
      imageValue: image.place.value,
      imageEvidence: image.place.evidence || "",
    });
  return conflicts;
}

export type ImageRow = Row;

export type ImageOutcome = {
  status: "ready" | "deduped" | "skipped" | "deferred" | "failed";
  code?: string;
  modelCalls?: number;
};

export async function processImageRow(
  db: SqlDatabase,
  ai: CalendarAI,
  row: ImageRow,
  options: { model?: string; dailyCap?: number; day?: string } = {},
): Promise<ImageOutcome> {
  const model = options.model || DEFAULT_IMAGE_MODEL;
  const day = options.day || new Date().toISOString().slice(0, 10);
  let modelCalls = 0;
  try {
    const downloaded = await downloadMedia(row.url, fetch);
    const payload = normalizeImage(downloaded.bytes);
    const digest = await sha256(downloaded.bytes);
    const cached = await db
      .prepare(
        `SELECT id,ocr_text,structured_json FROM article_images
         WHERE digest=? AND status='ready' AND model=? AND model_version=? AND id<>? LIMIT 1`,
      )
      .bind(digest, model, IMAGE_MODEL_VERSION, row.id)
      .first<{ id: string; ocr_text: string; structured_json: string }>();
    let vision: ImageVision;
    let dedupedFrom: string | null = null;
    if (cached) {
      vision = ImageVisionSchema.parse(JSON.parse(cached.structured_json));
      dedupedFrom = cached.id;
    } else {
      if (!(await reserve(db, day, options.dailyCap ?? 50)))
        return { status: "deferred", code: "DAILY_CAP" };
      modelCalls = 1;
      const raw = await bounded(
        ai.run(model, {
          messages: [
            { role: "system", content: IMAGE_VISION_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `文章标题：${row.title}\n只抽取这张图片里的信息；不要使用文章正文里的字段。`,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${payload.type};base64,${Buffer.from(payload.bytes).toString("base64")}`,
                  },
                },
              ],
            },
          ],
          max_completion_tokens: 6144,
          temperature: 0,
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "image_vision",
              strict: true,
              schema: z.toJSONSchema(ImageVisionSchema),
            },
          },
        }),
      );
      vision = normalizeVisionFields(ImageVisionSchema.parse(resultObject(raw)));
    }
    if (!vision.readable || !vision.text.trim()) {
      await db
        .prepare(
          "UPDATE article_images SET status='skipped',digest=?,error_code='MEDIA_UNREADABLE',lease_until_ms=0,updated_at=? WHERE id=?",
        )
        .bind(digest, new Date().toISOString(), row.id)
        .run();
      return { status: "skipped", code: "MEDIA_UNREADABLE", modelCalls };
    }
    const conflicts = conflictsWithBody(vision, row.analysis_json);
    const stamp = new Date().toISOString();
    await db.batch([
      db
        .prepare(
          `UPDATE article_images SET status='ready',digest=?,ocr_text=?,structured_json=?,conflicts_json=?,model=?,model_version=?,error_code=NULL,deduped_from=?,lease_until_ms=0,updated_at=? WHERE id=?`,
        )
        .bind(
          digest,
          vision.text.slice(0, 600),
          JSON.stringify(vision),
          conflicts.length ? JSON.stringify(conflicts) : null,
          model,
          IMAGE_MODEL_VERSION,
          dedupedFrom,
          stamp,
          row.id,
        ),
      db.prepare("DELETE FROM article_image_fts WHERE image_id=?").bind(row.id),
      db
        .prepare(
          "INSERT INTO article_image_fts(image_id,document_id,body_terms) VALUES(?,?,?)",
        )
        .bind(
          row.id,
          row.document_id,
          lexicalTokens(
            [
              row.title,
              vision.title?.value,
              vision.summary?.value,
              vision.text,
            ]
              .filter(Boolean)
              .join(" "),
          )
            .join(" ")
            .slice(0, 20000),
        ),
    ]);
    return {
      status: dedupedFrom ? "deduped" : "ready",
      modelCalls,
    };
  } catch (e) {
    const code = e instanceof Error ? e.message : "IMAGE_FAILED";
    const attempts = row.attempts + 1;
    const delay =
      attempts >= MAX_ATTEMPTS ? 0 : [60000, 300000, 1800000][attempts - 1];
    await db
      .prepare(
        "UPDATE article_images SET status=?,attempts=?,next_attempt_at_ms=?,lease_until_ms=0,error_code=?,updated_at=? WHERE id=?",
      )
      .bind(
        attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        Date.now() + delay,
        code.slice(0, 120),
        new Date().toISOString(),
        row.id,
      )
      .run();
    return { status: "failed", code: code.slice(0, 60), modelCalls };
  }
}

export async function runImageBatch(
  db: SqlDatabase,
  ai: CalendarAI | undefined,
  options: { model?: string; dailyCap?: number; limit?: number } = {},
) {
  const result = {
    processed: 0,
    ready: 0,
    deduped: 0,
    modelCalls: 0,
    failures: 0,
    deferred: 0,
    failureCodes: [] as string[],
  };
  if (!ai) return result;
  const active = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM article_images WHERE status='processing' AND lease_until_ms>?",
    )
    .bind(Date.now())
    .first<{ n: number }>();
  // One image at a time: a minute cron must not start a second slow vision
  // request while the first one still holds its lease.
  if ((active?.n ?? 0) > 0) return result;
  const model = options.model || DEFAULT_IMAGE_MODEL;
  const day = new Date().toISOString().slice(0, 10);
  // Even with a per-row lease, overlapping scheduled isolates can all read
  // "no active row" before any of them writes. The daily budget row is the one
  // serialized place where a single global OCR lease can be acquired.
  await db
    .prepare(
      "INSERT OR IGNORE INTO image_ocr_budget(day,calls,lease_until_ms) VALUES(?,0,0)",
    )
    .bind(day)
    .run();
  const acquire = await db
    .prepare(
      "UPDATE image_ocr_budget SET lease_until_ms=? WHERE day=? AND lease_until_ms<?",
    )
    .bind(Date.now() + 600000, day, Date.now())
    .run();
  if (!acquire.meta?.changes) return result;
  try {
  const candidates = await db
    .prepare(
      `SELECT i.id,i.document_id,i.content_revision,i.input_hash,i.url,i.locator,i.attempts,
              d.title,d.url AS article_url,x.analysis_json
       FROM article_images i
       JOIN knowledge_documents d ON d.id=i.document_id AND d.content_revision=i.content_revision AND d.input_hash=i.input_hash
       LEFT JOIN document_article_analysis x ON x.document_id=i.document_id
       WHERE i.status IN ('pending','failed','processing') AND i.attempts<?
         AND i.next_attempt_at_ms<=? AND i.lease_until_ms<?
         AND d.owner_user_id IS NULL AND d.data_domain<>'user_private'
         AND EXISTS(SELECT 1 FROM console_public_documents p WHERE p.id=d.id)
       ORDER BY i.attempts,i.created_at LIMIT ?`,
    )
    .bind(MAX_ATTEMPTS, Date.now(), Date.now(), options.limit ?? 3)
    .all<Row>();
  for (const row of candidates.results) {
    const claim = await db
      .prepare(
        "UPDATE article_images SET status='processing',attempts=attempts+1,lease_until_ms=? WHERE id=? AND status IN ('pending','failed','processing') AND lease_until_ms<? AND NOT EXISTS (SELECT 1 FROM article_images WHERE status='processing' AND lease_until_ms>?)",
      )
      .bind(Date.now() + 300000, row.id, Date.now(), Date.now())
      .run();
    if (!claim.meta?.changes) continue;
    result.processed++;
    const outcome = await processImageRow(db, ai, row, {
      model,
      dailyCap: options.dailyCap,
      day,
    });
    if (outcome.status === "ready") result.ready++;
    else if (outcome.status === "deduped") {
      result.ready++;
      result.deduped++;
    } else if (outcome.status === "deferred") {
      result.deferred++;
      break;
    } else if (outcome.status === "failed") {
      result.failures++;
      if (outcome.code) result.failureCodes.push(outcome.code);
    }
    result.modelCalls += outcome.modelCalls ?? 0;
  }
  } finally {
    await db
      .prepare("UPDATE image_ocr_budget SET lease_until_ms=0 WHERE day=?")
      .bind(day)
      .run();
  }
  return result;
}
