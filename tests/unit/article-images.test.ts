import { describe, expect, it } from "vitest";
import { articleImages } from "@/lib/ingestion/article-media";
import type { ArticleAnalysisInput } from "@/domain/console/article-analysis";

function input(body: string): ArticleAnalysisInput {
  return {
    title: "海报文章",
    body,
    bodyFormat: "reading_html",
    originalUrl: "https://www.gdufs.edu.cn/a.htm",
  } as ArticleAnalysisInput;
}

describe("article image extraction", () => {
  it("keeps content images, prefers data-src and drops decoration/duplicates", () => {
    const body = `<div>
      <img src="https://mmbiz.qpic.cn/logo.png" width="800" height="600">
      <img data-src="https://mmbiz.qpic.cn/poster-a.jpg" width="800" height="1200">
      <img src="https://mmbiz.qpic.cn/poster-a.jpg" width="800" height="1200">
      <img src="https://mmbiz.qpic.cn/tiny.png" width="60" height="60">
      <img src="http://mmbiz.qpic.cn/insecure.jpg" width="800" height="600">
      <img src="https://evil.example.com/poster.jpg" width="800" height="600">
      <img src="https://mmbiz.qpic.cn/poster-b.jpg" width="640" height="480">
    </div>`;
    const images = articleImages(input(body));
    expect(images.map((image) => image.url)).toEqual([
      "https://mmbiz.qpic.cn/poster-a.jpg",
      "https://mmbiz.qpic.cn/poster-b.jpg",
    ]);
    expect(images[0]).toMatchObject({
      locator: "img[2]",
      width: 800,
      height: 1200,
    });
  });

  it("respects the per-article cap and ignores non-html bodies", () => {
    const many = Array.from(
      { length: 9 },
      (_, i) =>
        `<img src="https://mmbiz.qpic.cn/p${i}.jpg" width="500" height="500">`,
    ).join("");
    expect(articleImages(input(`<div>${many}</div>`), 3)).toHaveLength(3);
    expect(
      articleImages({
        ...input(""),
        bodyFormat: "plain",
        body: "<img src=\"https://mmbiz.qpic.cn/a.jpg\">",
      }),
    ).toEqual([]);
  });
});
