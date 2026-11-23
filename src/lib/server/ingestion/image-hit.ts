import type { EvidenceHit } from "@/domain/retrieval/contracts";
import { EvidenceHitSchema } from "@/domain/retrieval/contracts";
import type { SqlDatabase } from "../assistant/database";
import { articleImageEvidence } from "./image-evidence";

type ImageOnlyRow = {
  id: string;
  version: number;
  source_id: string;
  title: string;
  url: string;
  published_at: string | null;
  content_revision: number;
  input_hash: string;
  display_name: string;
  primary_destination: "knowledge" | "radar" | "unknown";
  classification_origin: string;
};

/**
 * Poster-only articles have a title and OCR evidence but no body chunk, so the
 * normal retriever returns nothing for their documentId. Build the same hit
 * contract from the public document row and the OCR summary, keeping the
 * article as the source of record rather than turning OCR into a new source.
 */
export async function imageOnlyHits(
  db: SqlDatabase,
  documentIds: string[],
): Promise<EvidenceHit[]> {
  if (!documentIds.length) return [];
  const rows = await db
    .prepare(
      `SELECT d.id,d.version,d.source_id,d.title,d.url,d.published_at,
              d.content_revision,d.input_hash,d.display_name,
              d.primary_destination,d.classification_origin
       FROM knowledge_documents d
       WHERE d.id IN (${documentIds.map(() => "?").join(",")})`,
    )
    .bind(...documentIds)
    .all<ImageOnlyRow>();
  const hits: EvidenceHit[] = [];
  for (const row of rows.results) {
    const images = await articleImageEvidence(db, row.id, 1);
    if (!images.length) continue;
    const image = images[0];
    const snippet = `图片 OCR：${image.summary || image.text.slice(0, 700)}`.slice(
      0,
      800,
    );
    const parsed = EvidenceHitSchema.safeParse({
      documentId: row.id,
      chunkId: `image:${row.id}`,
      title: row.title.slice(0, 250),
      sourceId: row.source_id,
      sourceName: row.display_name.slice(0, 250),
      originalUrl: row.url,
      publishedAt: row.published_at,
      contentSnippet: snippet,
      startOffset: 0,
      endOffset: snippet.length,
      evidenceBasis: "title",
      evidenceType: "metadata",
      bodyAvailable: false,
      bodyPartial: false,
      relevanceScore: 1,
      rankingReasons: ["image_ocr"],
      classificationState:
        row.primary_destination === "radar"
          ? "radar"
          : row.primary_destination === "knowledge"
            ? "knowledge"
            : "unknown",
      radarCategory: null,
      knowledgeCategory: null,
      classificationOrigin: row.classification_origin || "image_ocr",
      contentRevision: row.content_revision,
      inputHash: row.input_hash,
      documentVersion: row.version,
      publicAvailable: true,
      validity: "unknown",
      official: false,
      readable: false,
      imageUrl: image.url,
      linkedSources: [],
    });
    if (parsed.success) hits.push(parsed.data);
  }
  return hits;
}
