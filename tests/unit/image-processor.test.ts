import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteD1 } from "../fixtures/sqlite-d1";
import {
  processImageRow,
  type ImageRow,
} from "@/lib/server/ingestion/image-processor";
import type { CalendarAI } from "@/lib/server/calendar/enrichment";
import {
  articleImageEvidence,
  imageOcrDocumentIds,
} from "@/lib/server/ingestion/image-evidence";

const vision = {
  readable: true,
  text: "讲座预告 11月19日 大学城校区凤鸣会堂 主讲人张三",
  title: { value: "讲座预告", evidence: "讲座预告" },
  category: { value: "lecture", evidence: "讲座预告" },
  startsAt: { value: "11月19日", evidence: "11月19日" },
  endsAt: { value: null, evidence: null },
  timeText: { value: "19:00", evidence: "19:00" },
  place: { value: "大学城校区凤鸣会堂", evidence: "大学城校区凤鸣会堂" },
  speaker: { value: "张三", evidence: "主讲人张三" },
  registration: { value: null, evidence: null },
  deadline: { value: null, evidence: null },
  organizer: { value: null, evidence: null },
  summary: { value: "讲座预告", evidence: "讲座预告" },
};

function row(id: string, documentId: string, attempts = 0): ImageRow {
  return {
    id,
    document_id: documentId,
    content_revision: 1,
    input_hash: "hash-" + documentId,
    url: "https://mmbiz.qpic.cn/poster.jpg",
    locator: "img[1]",
    attempts,
    title: "讲座预告",
    article_url: "https://mp.weixin.qq.com/s/a",
    analysis_json: null,
  };
}

function setup() {
  const fixture = sqliteD1();
  fixture.sqlite.exec(`
    INSERT INTO article_images(id,document_id,content_revision,input_hash,url,locator,status,attempts,created_at,updated_at)
    VALUES
      ('img-a','doc-a',1,'hash-doc-a','https://mmbiz.qpic.cn/poster.jpg','img[1]','pending',0,'2026-11-21','2026-11-21'),
      ('img-b','doc-b',1,'hash-doc-b','https://mmbiz.qpic.cn/poster.jpg','img[1]','pending',0,'2026-11-21','2026-11-21');
  `);
  return fixture;
}

function ai() {
  return {
    run: vi.fn(async () => ({ response: JSON.stringify(vision) })),
  } as unknown as CalendarAI & { run: ReturnType<typeof vi.fn> };
}

afterEach(() => vi.unstubAllGlobals());

describe("image OCR processor", () => {
  it("stores OCR on the owning document and indexes only that document", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "image/jpeg" },
          }),
      ),
    );
    const { db, sqlite, close } = setup();
    try {
      const outcome = await processImageRow(db, ai(), row("img-a", "doc-a"));
      expect(outcome).toMatchObject({ status: "ready", modelCalls: 1 });
      const stored = sqlite
        .prepare("SELECT status,ocr_text,document_id FROM article_images WHERE id='img-a'")
        .get() as { status: string; ocr_text: string; document_id: string };
      expect(stored.status).toBe("ready");
      expect(stored.ocr_text).toContain("凤鸣会堂");
      expect(
        sqlite
          .prepare("SELECT document_id FROM article_image_fts")
          .all(),
      ).toEqual([{ document_id: "doc-a" }]);
      expect(await imageOcrDocumentIds(db, "凤鸣会堂")).toEqual(["doc-a"]);
      expect(await imageOcrDocumentIds(db, "不存在的词")).toEqual([]);
      const evidence = await articleImageEvidence(db, "doc-a");
      expect(evidence[0]).toMatchObject({ url: "https://mmbiz.qpic.cn/poster.jpg" });
      expect(evidence[0].summary).toContain("凤鸣会堂");
      expect(await articleImageEvidence(db, "doc-b")).toEqual([]);
    } finally {
      close();
    }
  });

  it("deduplicates an identical image instead of calling the model twice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([9, 9, 9]), {
            headers: { "content-type": "image/jpeg" },
          }),
      ),
    );
    const { db, sqlite, close } = setup();
    try {
      const fake = ai();
      await processImageRow(db, fake, row("img-a", "doc-a"));
      const outcome = await processImageRow(db, fake, row("img-b", "doc-b"));
      expect(outcome).toMatchObject({ status: "deduped", modelCalls: 0 });
      expect(fake.run).toHaveBeenCalledTimes(1);
      const copy = sqlite
        .prepare("SELECT deduped_from,status FROM article_images WHERE id='img-b'")
        .get() as { deduped_from: string; status: string };
      expect(copy).toEqual({ deduped_from: "img-a", status: "ready" });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM article_image_fts").get(),
      ).toEqual({ n: 2 });
    } finally {
      close();
    }
  });

  it("retries with backoff and gives up after three failed attempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const { db, sqlite, close } = setup();
    try {
      const first = await processImageRow(db, ai(), row("img-a", "doc-a"));
      expect(first.status).toBe("failed");
      expect(
        sqlite.prepare("SELECT status,attempts FROM article_images WHERE id='img-a'").get(),
      ).toMatchObject({ status: "pending", attempts: 1 });
      await processImageRow(db, ai(), row("img-a", "doc-a", 1));
      const last = await processImageRow(db, ai(), row("img-a", "doc-a", 2));
      expect(last.status).toBe("failed");
      expect(
        sqlite.prepare("SELECT status,attempts FROM article_images WHERE id='img-a'").get(),
      ).toMatchObject({ status: "failed", attempts: 3 });
    } finally {
      close();
    }
  });

  it("keeps both values when poster and body disagree", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([5, 5]), {
            headers: { "content-type": "image/jpeg" },
          }),
      ),
    );
    const { db, sqlite, close } = setup();
    try {
      const conflicting = row("img-a", "doc-a");
      conflicting.analysis_json = JSON.stringify({
        activities: [{ startsAt: { date: "2026-12-01" }, placeRaw: "另一地点" }],
      });
      const outcome = await processImageRow(db, ai(), conflicting);
      expect(outcome.status).toBe("ready");
      const stored = sqlite
        .prepare("SELECT conflicts_json FROM article_images WHERE id='img-a'")
        .get() as { conflicts_json: string };
      const conflicts = JSON.parse(stored.conflicts_json) as {
        field: string;
        bodyValue: string;
        imageValue: string;
      }[];
      expect(conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "startsAt",
            bodyValue: "2026-12-01",
            imageValue: "11月19日",
          }),
          expect.objectContaining({ field: "place", bodyValue: "另一地点" }),
        ]),
      );
    } finally {
      close();
    }
  });

  it("marks an unreadable image skipped and respects the daily cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([7, 7]), {
            headers: { "content-type": "image/png" },
          }),
      ),
    );
    const { db, sqlite, close } = setup();
    try {
      const unreadable = {
        ...vision,
        readable: false,
        text: "",
      };
      const fake = {
        run: vi.fn(async () => ({ response: JSON.stringify(unreadable) })),
      } as unknown as CalendarAI;
      const outcome = await processImageRow(db, fake, row("img-a", "doc-a"));
      expect(outcome.status).toBe("skipped");
      expect(
        sqlite.prepare("SELECT status,error_code FROM article_images WHERE id='img-a'").get(),
      ).toEqual({ status: "skipped", error_code: "MEDIA_UNREADABLE" });

      sqlite.exec(
        "INSERT INTO image_ocr_budget(day,calls) VALUES('2026-11-21',1) ON CONFLICT(day) DO UPDATE SET calls=1",
      );
      const capped = await processImageRow(db, fake, row("img-b", "doc-b"), {
        dailyCap: 1,
        day: "2026-11-21",
      });
      expect(capped).toMatchObject({ status: "deferred", code: "DAILY_CAP" });
      expect(
        sqlite.prepare("SELECT status FROM article_images WHERE id='img-b'").get(),
      ).toEqual({ status: "pending" });
    } finally {
      close();
    }
  });
});
