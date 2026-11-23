import { afterEach, describe, expect, it } from "vitest";
import { dateGateFixture } from "../fixtures/date-gate";
import { analysisStatements } from "@/lib/server/console/article-analysis";
import {
  imageActivity,
  type ImageActivitySource,
} from "@/lib/server/ingestion/image-activity";
import { projectImageActivity, projectPendingImages } from "@/lib/server/ingestion/image-projection";

const source: ImageActivitySource = {
  id: "image:img-1",
  url: "https://mmbiz.qpic.cn/poster.jpg",
  locator: "img[1]",
  digest: "digest-1",
  text: "云山学术沙龙418期 时间：2026年11月13日（周五）14:30-16:00 地点：白云山校区广东国际战略研究院304会议室 主讲人：王道娟",
};

function vision(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    readable: true,
    text: source.text,
    title: { value: "云山学术沙龙418期", evidence: "云山学术沙龙418期" },
    category: { value: "lecture", evidence: "学术沙龙" },
    startsAt: {
      value: "2026年11月13日（周五）14:30-16:00",
      evidence: "时间：2026年11月13日（周五）14:30-16:00",
    },
    endsAt: { value: null, evidence: null },
    timeText: { value: null, evidence: null },
    place: {
      value: "白云山校区广东国际战略研究院304会议室",
      evidence: "地点：白云山校区广东国际战略研究院304会议室",
    },
    speaker: { value: "王道娟", evidence: "主讲人：王道娟" },
    registration: { value: null, evidence: null },
    deadline: { value: null, evidence: null },
    organizer: { value: null, evidence: null },
    summary: { value: "案例研究分享", evidence: "云山学术沙龙418期" },
    ...overrides,
  });
}

function analysis(activities: unknown[] = []) {
  return {
    primaryDestination: "radar",
    radarCategory: "lecture",
    knowledgeCategory: null,
    temporalType: "short",
    contentType: "notice",
    tags: [],
    auxiliaryDestinations: [],
    classificationConfidence: "high",
    classificationReasons: [],
    classificationEvidence: [],
    classifierVersion: "test",
    method: "rules",
    needsAssistance: false,
    bodyAvailable: true,
    registrationStatus: "unknown",
    hasRegistration: false,
    college: null,
    collegeName: null,
    eventType: null,
    eventStart: null,
    eventEnd: null,
    activities,
    knowledge: {
      topic: null,
      audience: [],
      departments: [],
      campusScope: "unknown",
      conditions: [],
      steps: [],
      fees: [],
      materials: [],
      contacts: [],
    },
    activitySlots: [],
  } as unknown as Parameters<typeof imageActivity>[0];
}

afterEach(() => {
  // no globals stubbed
});

describe("image activity conversion", () => {
  it("keeps a year, clock and room from the image evidence", () => {
    const a = imageActivity(analysis(), "img-1", source, vision())!;
    expect(a.startsAt).toMatchObject({
      date: "2026-11-13",
      at: "2026-11-13T14:30:00+08:00",
      inferred: false,
    });
    expect(a.placeRaw).toBe("白云山校区广东国际战略研究院304会议室");
    expect(a.organizer).toBe("王道娟");
    expect(a.calendar?.eligible).toBe(true);
  });

  it("keeps an English month and a 24-hour clock from a bilingual poster", () => {
    const englishSource = {
      ...source,
      text: "NEW VISION LECTURE No.86 Talent Management for International Competition. Speaker: Waldemar Pelz, Professor at THM-Business School. Date: November 16th, 2026. Time: 15:50-17:30. Location: Room 305/MBA Center/Baiyun Mountain Campus/GDUFS.",
    };
    const a = imageActivity(
      analysis(),
      "img-2",
      englishSource,
      vision({
        text: englishSource.text,
        title: { value: "Talent Management", evidence: "Talent Management" },
        startsAt: {
          value: "November 16th, 2026 15:50",
          evidence: "November 16th, 2026 15:50-17:30",
        },
        endsAt: {
          value: "November 16th, 2026 17:30",
          evidence: "November 16th, 2026 15:50-17:30",
        },
        place: {
          value: "Room 305/MBA Center/Baiyun Mountain Campus/GDUFS",
          evidence: "Room 305/MBA Center/Baiyun Mountain Campus/GDUFS",
        },
        speaker: { value: "Waldemar Pelz", evidence: "Waldemar Pelz" },
      }),
    )!;
    expect(a.startsAt).toMatchObject({
      date: "2026-11-16",
      at: "2026-11-16T15:50:00+08:00",
    });
    expect(a.endsAt?.at).toBe("2026-11-16T17:30:00+08:00");
    expect(a.placeRaw).toContain("Room 305");
  });

  it("does not invent a year for a date without one", () => {
    const a = imageActivity(
      analysis(),
      "img-1",
      source,
      vision({
        startsAt: { value: "11月13日 14:30", evidence: "11月13日 14:30" },
      }),
    );
    expect(a).toBeNull();
  });

  it("turns a deadline-only poster into an opportunity, not an event", () => {
    const deadlineSource = {
      ...source,
      text: "报名截止：2026年11月30日",
    };
    const a = imageActivity(
      analysis(),
      "img-1",
      deadlineSource,
      vision({
        text: deadlineSource.text,
        title: { value: "报名通知", evidence: "报名截止" },
        startsAt: { value: null, evidence: null },
        deadline: {
          value: "2026年11月30日",
          evidence: "报名截止：2026年11月30日",
        },
      }),
    )!;
    expect(a.kind).toBe("opportunity");
    expect(a.startsAt).toBeNull();
    expect(a.calendar?.eligible).toBe(false);
    expect(a.registrationWindows[0].end?.date).toBe("2026-11-30");
  });

  it("rejects an unreadable or decorative image", () => {
    expect(
      imageActivity(analysis(), "img-1", source, vision({ readable: false })),
    ).toBeNull();
  });
});

async function articleWithBody(body: string, title: string) {
  const f = await dateGateFixture();
  const id = await f.article(
    `photo-${Math.random().toString(36).slice(2, 8)}`,
    "2026-11-01",
    title,
    body,
  );
  const d = f.sqlite
    .prepare(
      "SELECT content_revision,input_hash FROM knowledge_documents WHERE id=?",
    )
    .get(id) as { content_revision: number; input_hash: string };
  await f.db.batch(
    await analysisStatements(f.db, id, d.content_revision, d.input_hash, {
      title,
      body,
      publishedAt: "2026-11-01",
    }),
  );
  return { f, id, revision: d.content_revision, hash: d.input_hash };
}

async function addImage(
  f: Awaited<ReturnType<typeof dateGateFixture>>,
  id: string,
  revision: number,
  hash: string,
  text: string,
  structured: string,
) {
  f.sqlite
    .prepare(
      `INSERT INTO article_images(id,document_id,content_revision,input_hash,url,locator,digest,status,attempts,ocr_text,structured_json,created_at,updated_at)
       VALUES('img-1',?,?,?,'https://mmbiz.qpic.cn/poster.jpg','img[1]','digest-1','ready',1,?,?,'2026-11-21','2026-11-21')`,
    )
    .run(id, revision, hash, text, structured);
}

describe("image activity projection", () => {
  it("merges a body schedule with an image speaker into the calendar index", async () => {
    const { f, id, revision, hash } = await articleWithBody(
      "云山学术沙龙418期\n时间：2026年11月13日 14:30-16:00\n地点：白云山校区广东国际战略研究院304会议室",
      "云山学术沙龙418期",
    );
    try {
      await addImage(f, id, revision, hash, source.text, vision());
      expect(await projectImageActivity(f.db, id)).toBe("projected");
      const row = f.sqlite
        .prepare(
          "SELECT activity_json FROM article_activity_index WHERE document_id=?",
        )
        .get(id) as { activity_json: string };
      const activity = JSON.parse(row.activity_json);
      expect(activity.placeRaw).toContain("304");
      expect(activity.organizer).toBe("王道娟");
      expect(activity.startsAt.date).toBe("2026-11-13");
    } finally {
      f.close();
    }
  });

  it("creates an event from an image-only article", async () => {
    const { f, id, revision, hash } = await articleWithBody(
      '<div class="v_news_content"><p><img data-src="https://mmbiz.qpic.cn/poster.jpg"></p></div>',
      "云山学术沙龙418期",
    );
    try {
      await addImage(f, id, revision, hash, source.text, vision());
      expect(await projectImageActivity(f.db, id)).toBe("projected");
      const row = f.sqlite
        .prepare(
          "SELECT json_extract(activity_json,'$.calendar.reason') AS reason FROM article_activity_index WHERE document_id=? AND calendar_eligible=1",
        )
        .get(id) as { reason: string };
      expect(row.reason).toBe("image_ocr");
    } finally {
      f.close();
    }
  });

  it("keeps a deadline-only image out of the event index", async () => {
    const { f, id, revision, hash } = await articleWithBody(
      "报名通知",
      "报名通知",
    );
    try {
      await addImage(
        f,
        id,
        revision,
        hash,
        "报名截止：2026年11月30日",
        vision({
          text: "报名截止：2026年11月30日",
          title: { value: "报名通知", evidence: "报名通知" },
          startsAt: { value: null, evidence: null },
          deadline: {
            value: "2026年11月30日",
            evidence: "报名截止：2026年11月30日",
          },
        }),
      );
      await projectImageActivity(f.db, id);
      expect(
        f.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM article_activity_index WHERE document_id=? AND calendar_eligible=1",
          )
          .get(id),
      ).toEqual({ n: 0 });
      expect(
        f.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM article_registration_windows WHERE document_id=?",
          )
          .get(id),
      ).toEqual({ n: 1 });
    } finally {
      f.close();
    }
  });

  it("does not re-project an image that already succeeded", async () => {
    const { f, id, revision, hash } = await articleWithBody(
      "云山学术沙龙418期\n时间：2026年11月13日 14:30-16:00",
      "云山学术沙龙418期",
    );
    try {
      await addImage(f, id, revision, hash, source.text, vision());
      expect(await projectPendingImages(f.db, 5)).toMatchObject({ projected: 1 });
      expect(await projectPendingImages(f.db, 5)).toMatchObject({ projected: 0 });
      const row = f.sqlite
        .prepare(
          "SELECT projected_at FROM article_images WHERE id='img-1'",
        )
        .get() as { projected_at: string | null };
      expect(row.projected_at).toBeTruthy();
    } finally {
      f.close();
    }
  });

  it("keeps conflicting body and image dates as two activities", async () => {
    const { f, id, revision, hash } = await articleWithBody(
      "云山学术沙龙418期\n时间：2026年11月13日 14:30-16:00\n地点：白云山校区广东国际战略研究院304会议室",
      "云山学术沙龙418期",
    );
    try {
      await addImage(
        f,
        id,
        revision,
        hash,
        "云山学术沙龙418期 时间：2026年11月14日 14:30-16:00 地点：白云山校区广东国际战略研究院304会议室",
        vision({
          startsAt: {
            value: "2026年11月14日 14:30-16:00",
            evidence: "时间：2026年11月14日 14:30-16:00",
          },
        }),
      );
      await projectImageActivity(f.db, id);
      const rows = f.sqlite
        .prepare(
          "SELECT starts_day,json_extract(activity_json,'$.calendar.reason') AS reason FROM article_activity_index WHERE document_id=? AND calendar_eligible=1 ORDER BY starts_day",
        )
        .all(id) as { starts_day: string; reason: string }[];
      expect(rows.map((r) => r.starts_day)).toEqual([
        "2026-11-13",
        "2026-11-14",
      ]);
      expect(rows.some((r) => r.reason === "image_ocr")).toBe(true);
    } finally {
      f.close();
    }
  });
});
