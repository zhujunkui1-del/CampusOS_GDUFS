import {
  ArticleActivitySchema,
  type ArticleActivity,
  type ArticleAnalysis,
  type ArticleEvidence,
  type ArticleTimePoint,
} from "@/domain/console/article-analysis";
import { ImageVisionSchema, type ImageField, type ImageVision } from "@/domain/ingestion/image-vision";
import { CalendarSourceSchema } from "@/domain/calendar/extraction";

export type ImageActivitySource = {
  id: string;
  url: string;
  locator: string;
  digest: string;
  text: string;
};

const RADAR = new Set([
  "lecture",
  "culture_sports",
  "competition",
  "education_career",
  "academic_research",
  "scholarship_opportunity",
  "campus_notice",
]);

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function dateOf(value: string): string | null {
  const full = value.match(/(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/);
  if (full)
    return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`;
  const english = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
  );
  if (!english) return null;
  const month = MONTHS[english[1].toLowerCase()];
  return `${english[3]}-${month}-${english[2].padStart(2, "0")}`;
}

function clockOf(value: string): string | null {
  const m = value.match(/(\d{1,2})[:：](\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

const DATE_TOKEN = /(?:\d{4}[年/.-]\d{1,2}[月/.-]\d{1,2}|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/i;
const CLOCK_TOKEN = /\d{1,2}[:：]\d{2}(?:\s*[-–—~]\s*\d{1,2}[:：]\d{2})?/;

function locateEvidence(
  source: string,
  text: string,
): { start: number; end: number; body: string } | null {
  const exact = source.indexOf(text);
  if (exact >= 0)
    return { start: exact, end: exact + text.length, body: text };
  const lower = source.toLowerCase();
  const loose = lower.indexOf(text.toLowerCase());
  if (loose >= 0)
    return { start: loose, end: loose + text.length, body: source.slice(loose, loose + text.length) };

  // The model often joins a date and a clock across punctuation in the poster.
  // Keep the evidence verbatim by locating both tokens in the source and
  // slicing between them, instead of accepting a normalized non-substring.
  const positions: Array<{ start: number; end: number }> = [];
  for (const match of [text.match(DATE_TOKEN)?.[0], text.match(CLOCK_TOKEN)?.[0]]) {
    if (!match) continue;
    const at = source.indexOf(match);
    if (at >= 0) positions.push({ start: at, end: at + match.length });
  }
  if (!positions.length) return null;
  const start = Math.min(...positions.map((p) => p.start));
  const end = Math.max(...positions.map((p) => p.end));
  return { start, end, body: source.slice(start, end) };
}

function evidenceOf(
  source: ImageActivitySource,
  field: ImageField | null,
  fallback: string,
  role: string,
): ArticleEvidence | null {
  const text = field?.value && field.evidence ? field.evidence.trim() : fallback.trim();
  if (!text) return null;
  const located = locateEvidence(source.text, text);
  if (!located) return null;
  return {
    field: "body",
    startOffset: located.start,
    endOffset: located.end,
    text: located.body,
    role,
    sourceId: source.id,
  };
}

function pointOf(
  source: ImageActivitySource,
  field: ImageField,
  fallback: string,
): ArticleTimePoint | null {
  const raw = field.value?.trim() || "";
  const evidence = evidenceOf(source, { value: raw || null, evidence: field.evidence }, fallback, "image_time");
  if (!raw || !evidence) return null;
  const date = dateOf(raw) ?? dateOf(evidence.text);
  if (!date) return null;
  const clock = clockOf(raw) ?? clockOf(evidence.text);
  return {
    raw: evidence.text,
    date,
    at: clock ? `${date}T${clock}:00+08:00` : null,
    timezone: "Asia/Shanghai",
    precision: clock ? "exact_time" : "date",
    resolution: clock ? "minute" : "day",
    inferred: false,
    inferenceBasis: null,
    evidence,
  };
}

	function deadlinePoint(
	  source: ImageActivitySource,
	  field: ImageField,
	): ArticleTimePoint | null {
	  const date = dateOf(field.value || "");
	  const evidence = evidenceOf(source, field, field.evidence || "", "image_deadline");
	  if (!date || !evidence) return null;
	  const clock = clockOf(field.value || "") ?? clockOf(evidence.text);
	  return {
	    raw: evidence.text,
	    date,
	    at: clock ? `${date}T${clock}:00+08:00` : null,
	    timezone: "Asia/Shanghai",
	    precision: clock ? "exact_time" : "date",
	    resolution: clock ? "minute" : "day",
	    inferred: false,
	    inferenceBasis: null,
	    evidence,
	  };
	}

function categoryOf(vision: ImageVision, analysis: ArticleAnalysis): ArticleActivity["category"] {
  const value = vision.category.value?.trim();
  return value && RADAR.has(value) ? (value as ArticleActivity["category"]) : analysis.radarCategory;
}

/**
 * Convert one OCR result into the same ArticleActivity shape the body rules
 * produce. Nothing is guessed: a date without a year returns null, and an
 * image that only carries a deadline is an opportunity, never a fake event.
 */
export function imageActivity(
  analysis: ArticleAnalysis,
  imageId: string,
  source: ImageActivitySource,
  structuredJson: string,
  now = new Date(),
): ArticleActivity | null {
  const vision = ImageVisionSchema.parse(JSON.parse(structuredJson));
  if (!vision.readable) return null;
  const title =
    vision.title.value?.trim() ||
    analysis.activities[0]?.title ||
    source.text.slice(0, 60).trim();
  if (!title) return null;
  const startsAt = pointOf(source, vision.startsAt, vision.timeText.evidence || vision.startsAt.evidence || "");
  const endsAt = pointOf(source, vision.endsAt, "");
  const deadline = deadlinePoint(source, vision.deadline);
  if (!startsAt && !deadline) return null;
  const evidence = [
    ...(startsAt ? [startsAt.evidence] : []),
    ...(endsAt ? [endsAt.evidence] : []),
    ...(deadline ? [deadline.evidence] : []),
    ...(() => {
      const e = evidenceOf(source, vision.place, "", "image_place");
      return e ? [e] : [];
    })(),
    ...(() => {
      const e = evidenceOf(source, vision.speaker, "", "image_speaker");
      return e ? [e] : [];
    })(),
  ].slice(0, 8);
  const onlyDeadline = !startsAt && !!deadline;
  const registration = /无需报名|不用报名|免报名/.test(vision.registration.value || "")
    ? "not_required"
    : deadline || vision.registration.value
      ? "required"
      : "unknown";
  const today = now.toISOString().slice(0, 10);
  const status = !startsAt
    ? "unknown"
    : startsAt.date! > today
      ? "upcoming"
      : startsAt.date === today
        ? "ongoing"
        : "ended";
  const origin = CalendarSourceSchema.parse({
    id: source.id,
    kind: "image",
    url: source.url,
    locator: source.locator,
    digest: source.digest,
    text: source.text.slice(0, 24000),
    method: "image-ocr",
  });
  return ArticleActivitySchema.parse({
    key: `image:${imageId}`,
    title,
    kind: onlyDeadline ? "opportunity" : "event",
    category: categoryOf(vision, analysis),
    startsAt,
    endsAt,
    placeRaw: vision.place.value?.trim() || null,
    organizer: vision.organizer.value?.trim() || vision.speaker.value?.trim() || null,
    registrationStatus: registration,
    registrationWindows:
      deadline
        ? [
            {
              roundLabel: null,
              start: null,
              end: deadline,
              deadlineSemantics: "inclusive",
              capacityLimited: false,
              confidence: "high",
              evidence: [deadline.evidence],
              issues: [],
            },
          ]
        : [],
    registrationUrl: null,
    otherDeadlines: [],
    status,
    evidence,
    issues: [],
    calendar: {
      eligible: !!startsAt,
      reason: startsAt ? "image_ocr" : "deadline_only",
      nature: "announcement",
      campus:
        analysis.activities.find((a) => a.calendar)?.calendar?.campus ?? "unknown",
      candidateDates: startsAt?.date ? [startsAt.date] : [],
      origins: [
        {
          id: origin.id,
          kind: origin.kind,
          url: origin.url,
          locator: origin.locator,
          digest: origin.digest,
          method: origin.method,
        },
      ],
      usesBody: false,
    },
  });
}
