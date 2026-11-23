import { AccountStore } from "../account/store";
import type { SqlDatabase } from "../assistant/database";

const CAMPUS_EMAIL_DOMAIN = "@mail.gdufs.edu.cn";

/** Only a verified GDUFS mailbox identifies a current member of the university. */
export function isCampusEmail(email: string | null | undefined) {
  return !!email && email.trim().toLowerCase().endsWith(CAMPUS_EMAIL_DOMAIN);
}

export async function hasCampusAccess(db: SqlDatabase, request: Request) {
  const account = await new AccountStore(db, {
    origin: new URL(request.url).origin,
  }).resolve(request);
  return isCampusEmail(account?.row.verified_email);
}
