import { parseHTML } from "linkedom";
import type { ArticleAnalysisInput } from "@/domain/console/article-analysis";
import { allowedMediaUrl } from "@/lib/server/calendar/enrichment";

export type ArticleImageCandidate = {
  url: string;
  locator: string;
  width: number | null;
  height: number | null;
};

const DECORATIVE = /logo|avatar|icon|qrcode|二维码|头图|banner|share|favicon/i;

/**
 * Only images that can plausibly carry article content. The allowlist and
 * origin checks match the calendar enrichment path so a queued URL cannot
 * become an SSRF handle.
 */
export function articleImages(
  input: ArticleAnalysisInput,
  max = 6,
): ArticleImageCandidate[] {
  if (input.bodyFormat !== "reading_html" || !input.body) return [];
  let document: ReturnType<typeof parseHTML>["document"];
  try {
    document = parseHTML(input.body).document;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: ArticleImageCandidate[] = [];
  for (const [i, node] of [...document.querySelectorAll("img")].entries()) {
    const raw =
      node.getAttribute("data-src") || node.getAttribute("src") || "";
    if (!raw) continue;
    let url: string;
    try {
      url = new URL(raw, input.originalUrl).href;
    } catch {
      continue;
    }
    if (!allowedMediaUrl(url) || DECORATIVE.test(url) || seen.has(url)) continue;
    const width = Number(node.getAttribute("width") || 0) || null;
    const height = Number(node.getAttribute("height") || 0) || null;
    if ((width !== null && width < 100) || (height !== null && height < 100))
      continue;
    seen.add(url);
    out.push({ url, locator: `img[${i + 1}]`, width, height });
    if (out.length >= max) break;
  }
  return out;
}
