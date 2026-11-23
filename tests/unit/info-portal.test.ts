import { afterEach, describe, expect, it, vi } from "vitest";
import { infoPortalHtml } from "@/lib/ingestion/info-portal";

const detail = {
  e: 0,
  d: {
    data: {
      title: "关于开展2027年度全国“两红两优”评选表彰推报工作的通知",
      content: "<p>各学院团委：</p><p>请按要求报送材料。</p>",
      publish_time: "2026-11-20",
      publish_date_time: "2026-11-20 19:57",
      publisher: "共青团广东外语外贸大学委员会",
    },
  },
};

const list = {
  e: 0,
  d: {
    list: [
      {
        id: "3c5215c506dc39c39c907c81a33c9f33",
        title: "关于开展2027年度全国“两红两优”评选表彰推报工作的通知",
        publish_time: "2026-11-20",
      },
      {
        id: "11bbad4565233052e7fc1ac1f3568ead",
        title: "关于调整大学城校区学生宿舍热水供应时间的通知",
        publish_time: "2026-11-18",
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("info portal adapter", () => {
  it("turns a detail API response into the HTML the connector parses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detail))),
    );
    const html = await infoPortalHtml(
      "https://info.gdufs.edu.cn/pages/newsite/site/informationPc/details?id=3c5215c506dc39c39c907c81a33c9f33&system=notice",
    );
    expect(html).toContain("关于开展2027年度全国");
    expect(html).toContain("各学院团委");
    expect(html).toContain('class="v_news_content"');
    expect(html).toContain("2026-11-20 19:57");
  });

  it("turns the list API into crawlable article links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(list))),
    );
    const html = await infoPortalHtml("https://info.gdufs.edu.cn/");
    expect(html).toContain(
      "/pages/newsite/site/informationPc/details?id=3c5215c506dc39c39c907c81a33c9f33",
    );
    expect(html).toContain("关于调整大学城校区学生宿舍热水供应时间的通知");
  });
});
