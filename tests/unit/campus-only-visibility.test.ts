import { describe, it, expect } from "vitest";
import { dateGateFixture, command } from "../fixtures/date-gate";
import { analysisStatements } from "@/lib/server/console/article-analysis";
import { readPublicContent } from "@/lib/server/console/public-content";
import { readCalendar } from "@/lib/server/calendar/query";
import { isCampusEmail } from "@/lib/server/access/campus";
import { filterCampusOnlyResult } from "@/lib/server/retrieval/skills";

describe("campus-only source visibility", () => {
  it("recognises verified campus mailboxes case-insensitively", () => {
    expect(isCampusEmail("student@mail.gdufs.edu.cn")).toBe(true);
    expect(isCampusEmail(" Student@MAIL.GDUFS.EDU.CN ")).toBe(true);
    expect(isCampusEmail("student@gdufs.edu.cn")).toBe(false);
    expect(isCampusEmail("student@mail.gdufs.edu.cn.evil.test")).toBe(false);
    expect(isCampusEmail(null)).toBe(false);
    expect(isCampusEmail("")).toBe(false);
  });

  it("hides campus-only articles from public lists and calendars unless access is proven", async () => {
    const f = await dateGateFixture();
    try {
      const id = f.ids[0];
      await f.db.batch(
        await analysisStatements(f.db, id, 1, "a".repeat(64), {
          title: "仅校内讲座",
          body: "讲座时间：2026年11月5日 19:00。地点：白云山校区。",
          publishedAt: "2026-10-01",
        }),
      );
      await f.sqlite
        .prepare("UPDATE knowledge_sources SET campus_only=1 WHERE id=?")
        .run(f.source.id);

      const hidden = await readPublicContent(f.db, { surface: "radar" });
      expect(hidden.items.map((x) => x.id)).not.toContain(id);
      const visible = await readPublicContent(
        f.db,
        { surface: "radar" },
        f.db,
        true,
      );
      expect(visible.items.map((x) => x.id)).toContain(id);

      const result = {
        hits: [{ documentId: id }],
        activities: [],
        knowledge: [],
      } as never;
      expect((await filterCampusOnlyResult(f.db, result)).hits).toEqual([]);

      const window = { after: "2026-11-05", before: "2026-11-06" };
      expect((await readCalendar(f.db, window)).items).toEqual([]);
      expect(
        (
          await readCalendar(
            f.db,
            window,
            "2026-11-01T00:00:00.000Z",
            undefined,
            { campusAccess: true },
          )
        ).items.map((x) => x.sources[0]?.documentId),
      ).toContain(id);
    } finally {
      f.close();
    }
  });

  it("persists the flag and allows a closed source to be enabled without re-verification", async () => {
    const f = await dateGateFixture();
    try {
      const s = await f.store.sourceV2(f.source.id);
      await f.store.setCampusOnly(s.id, {
        ...command(s.version),
        campusOnly: true,
      });
      expect((await f.store.sourceV2(s.id)).campusOnly).toBe(true);

      const enabled = await f.store.sourceV2(s.id);
      await f.store.enableSource(enabled.id, {
        ...command(enabled.version),
        enabled: false,
      });
      const closed = await f.store.sourceV2(s.id);
      expect(closed.enabled).toBe(false);
      await f.store.enableSource(closed.id, {
        ...command(closed.version),
        enabled: true,
      });
      expect((await f.store.sourceV2(s.id)).enabled).toBe(true);
    } finally {
      f.close();
    }
  });
});
