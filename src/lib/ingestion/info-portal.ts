const HOST = "info.gdufs.edu.cn";
const DETAIL_PREFIX = "/pages/newsite/site/informationPc/details";
const LIST_API = "/news/frontend/default/news-list";
const DETAIL_API = "/news/frontend/default";

type PortalDetail = {
  title?: string;
  content?: string;
  publish_time?: string;
  publish_date_time?: string;
  publisher?: string;
};

type PortalListItem = {
  id?: string;
  title?: string;
  url?: string;
  publish_time?: string;
  publish_date_time?: string;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

async function json<T>(url: URL): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "CampusOS-Research/0.1 (official public information collection)",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`PORTAL_HTTP_${response.status}`);
  const body = (await response.json()) as {
    e?: number;
    d?: { data?: T; list?: T[] };
  };
  if (body.e !== 0) throw Error("PORTAL_REJECTED");
  if (!body.d) throw Error("PORTAL_EMPTY");
  return body.d as never;
}

function detailHtml(data: PortalDetail, url: string) {
  const date = data.publish_date_time || data.publish_time || "";
  return `<!doctype html><html><head><title>${escapeHtml(
    data.title || "",
  )}</title></head><body><article><h1>${escapeHtml(
    data.title || "",
  )}</h1><time datetime="${escapeHtml(date)}">${escapeHtml(
    date,
  )}</time><p class="publisher">${escapeHtml(
    data.publisher || "",
  )}</p><div class="v_news_content">${data.content || ""}</div><a href="${escapeHtml(
    url,
  )}">原文</a></article></body></html>`;
}

function listHtml(items: PortalListItem[], page: number, size: number) {
  const rows = items
    .filter((item) => item.id && item.title)
    .map((item) => {
      const href = `${DETAIL_PREFIX}?id=${encodeURIComponent(
        item.id!,
      )}&system=notice`;
      const date = item.publish_date_time || item.publish_time || "";
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(
        item.title!,
      )}</a><time datetime="${escapeHtml(date)}">${escapeHtml(
        date,
      )}</time></li>`;
    })
    .join("");
  const next =
    items.length >= size
      ? `<a rel="next" href="?page=${page + 1}&size=${size}">下一页</a>`
      : "";
  return `<!doctype html><html><head><title>通知公告</title></head><body><ul>${rows}</ul>${next}</body></html>`;
}

/**
 * The public portal renders its news pages in the browser from a JSON API.
 * The crawler only understands HTML, so turn the API response back into the
 * small HTML shape its selectors already expect. Listing and detail only use
 * the same public host and never accept a caller-supplied API URL.
 */
export async function infoPortalHtml(raw: string) {
  const url = new URL(raw);
  if (url.hostname !== HOST) return null;

  if (url.pathname === DETAIL_PREFIX) {
    const id = url.searchParams.get("id");
    if (!id) return null;
    const body = await json<{ data?: PortalDetail }>(
      new URL(`${DETAIL_API}/${encodeURIComponent(id)}`, url.origin),
    );
    if (!body?.data) throw Error("PORTAL_DETAIL_EMPTY");
    return detailHtml(body.data, url.href);
  }

  if (url.pathname === "/" || url.pathname === "") {
    const page = Number(url.searchParams.get("page") || "1");
    const size = Math.min(
      Math.max(Number(url.searchParams.get("size") || "20"), 1),
      50,
    );
    const api = new URL(LIST_API, url.origin);
    api.searchParams.set("system", "notice");
    api.searchParams.set("page", String(page));
    api.searchParams.set("size", String(size));
    const body = await json<{ list?: PortalListItem[] }>(api);
    return listHtml(body.list || [], page, size);
  }

  return null;
}
