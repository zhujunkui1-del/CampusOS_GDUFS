import { dispatchDue } from "./src/lib/server/console/scheduler";
import { runCloudWebBatch } from "./src/lib/server/console/cloud-web-runner";
import type { SqlDatabase } from "./src/lib/server/assistant/database";
import {
  backfillFlag,
  vectorBackfillBatch,
  vectorBindings,
} from "./src/lib/server/retrieval/vector";
import handler from "./.open-next/worker.js";
import { revalidateDocument } from "./src/lib/server/document-cache";
import { publicHttpsRedirect } from "./src/lib/server/public-https";
import { cleanAccountMetadata } from "./src/lib/server/account/api";
import { runCalendarBatch } from "./src/lib/server/calendar/processor";
import { runImageBatch } from "./src/lib/server/ingestion/image-processor";
import { projectPendingImages } from "./src/lib/server/ingestion/image-projection";
import type { CalendarAI } from "./src/lib/server/calendar/enrichment";
import { runWithCloudflareRequestContext } from "./.open-next/cloudflare/init.js";
import {
  previewApiHandler,
  withPreviewSecurityHeaders,
} from "./src/lib/server/preview-api";

// The existing OpenNext ALS supplies exactly the same request-scoped bindings.
// A thin preview-only dispatcher avoids Next routing overhead on small APIs.
const previewWorker = {
  async scheduled(_event: unknown, env: Record<string, unknown>) {
    if (env.APP_ENV !== "preview" || !env.DB) return;
    if (
      env.USER_ACCOUNTS_ENABLED === "true" &&
      new Date().getUTCMinutes() === 0
    )
      await cleanAccountMetadata(env.DB as SqlDatabase).catch(() =>
        console.info(JSON.stringify({ event: "account.cleanup.failure" })),
      );
    await (env.DB as SqlDatabase)
      .prepare(
        "UPDATE console_engine_settings SET cloud_runner_last_at=? WHERE id='console-v2-settings'",
      )
      .bind(new Date().toISOString())
      .run();
    await dispatchDue(env.DB as SqlDatabase);
    await runCloudWebBatch(env.DB as SqlDatabase);
    if (env.CALENDAR_ENABLED === "true")
      await runCalendarBatch(
        env.DB as SqlDatabase,
        env.CALENDAR_AUTO_ENRICH === "true"
          ? (env.AI as CalendarAI)
          : undefined,
      )
        .then((result) => {
          if (result.processed || result.failures)
            console.info(
              JSON.stringify({ event: "calendar.batch", ...result }),
            );
        })
        .catch(() =>
          console.info(
            JSON.stringify({ event: "calendar.batch", failed: true }),
          ),
        );
    // Image OCR is deliberately independent from calendar enrichment: it has
    // its own queue, budget and lease, and a failure never blocks collection.
    if (env.IMAGE_OCR_ENABLED === "true" && env.AI)
      await runImageBatch(env.DB as SqlDatabase, env.AI as CalendarAI, {
        model:
          typeof env.IMAGE_OCR_MODEL === "string"
            ? env.IMAGE_OCR_MODEL
            : undefined,
        dailyCap: Number(env.IMAGE_OCR_DAILY_CAP) || 50,
      })
        .then((result) => {
          if (result.processed || result.failures || result.deferred)
            console.info(JSON.stringify({ event: "image.batch", ...result }));
        })
        .catch(() =>
          console.info(
            JSON.stringify({ event: "image.batch", failed: true }),
          ),
        );
    // OCR results are folded into the same article analysis projection as the
    // body. Retrying here costs no vision call when the merge itself failed.
    await projectPendingImages(env.DB as SqlDatabase)
      .then((result) => {
        if (result.projected || result.failed)
          console.info(
            JSON.stringify({ event: "image.projection", ...result }),
          );
      })
      .catch(() =>
        console.info(
          JSON.stringify({ event: "image.projection", failed: true }),
        ),
      );
    // Bounded preview-only semantic backfill; a batch failure is recorded and
    // retried by the next tick instead of blocking ingestion.
    if (backfillFlag(env)) {
      const bindings = vectorBindings(env);
      if (bindings)
        await vectorBackfillBatch(env.DB as SqlDatabase, bindings, 32).catch(
          () => undefined,
        );
    }
  },
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(work: Promise<unknown>): void },
  ) {
    const upgrade = publicHttpsRedirect(request);
    if (upgrade) return upgrade;
    const route =
      env.APP_ENV === "preview"
        ? previewApiHandler(new URL(request.url).pathname, request.method)
        : null;
    if (!route) {
      const response = await handler.fetch(request, env, ctx);
      return env.APP_ENV === "preview"
        ? revalidateDocument(response)
        : response;
    }
    return runWithCloudflareRequestContext(request, env, ctx, async () => {
      const response =
        request.method === route.method
          ? await route.handle(request)
          : Response.json(
              {
                ok: false,
                error: {
                  code: "INVALID_ARGUMENT",
                  message: "请求方法不受支持。",
                  retryable: false,
                },
                requestId: crypto.randomUUID(),
              },
              {
                status: 405,
                headers: { Allow: route.method, "Cache-Control": "no-store" },
              },
            );
      return withPreviewSecurityHeaders(response);
    });
  },
};
export default previewWorker;
