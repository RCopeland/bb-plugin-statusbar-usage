// The usage section itself: read the Usage plugin's SQLite store and turn it
// into a statusbar section payload.
//
// WHY IT READS THE DATABASE RATHER THAN PARSING LOGS
//
// The Usage plugin (bb-plugin-usage) already backfills and prices every agent
// log on this machine. Re-deriving cost here would produce a second number that
// silently disagrees with the Usage panel, so this reads the same store the
// panel reads and the two always match.
//
// WHY IT CLAIMS THE BUILT-IN `usage` TOPIC
//
// The Statusbar plugin ships a fallback reader for `usage`. Claiming the topic
// means this plugin REPLACES that reader rather than adding a second usage
// section beside it. The fallback is not deleted — it stays as the offline
// path, so disabling or uninstalling this plugin returns the slot to the bar's
// own reading instead of blanking it.
//
// WHAT THIS ADDS OVER THE BUILT-IN
//
// The built-in reader reports today's cost and month-to-date. This one reports
// the same headline but qualifies it with the fresh/cached input split, which
// is the cache-health signal: cached input is the overwhelming majority of
// token volume and a small fraction of the bill, so a cost figure without that
// split cannot explain why the same work suddenly costs more.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  sectionPayloadSchema,
  unavailableSection,
  type SectionPayload,
} from "@robcopeland/bb-statusbar-section-protocol";

/** Same default the Usage plugin and bb-plugin-usage-footer use. */
export const DEFAULT_DB_PATH = join(homedir(), ".bb", "plugins", "usage", "data.db");

const TOPIC = "usage";

/**
 * The Usage plugin buckets by the *server's* local calendar day, so "today"
 * has to be computed the same way. Using UTC here would make the section claim
 * "Latest data is yesterday" for hours every evening, and would disagree with
 * the Usage panel besides.
 */
export function localDay(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/** `$0.40` / `<$0.01` / `$0.00` / `$1,234`, matching the rest of the bar. */
export function money(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (value < 0) return `-${money(-value)}`;
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

/**
 * `12.3M` / `476k` / `412`.
 *
 * Compact on purpose: the detail line sits inside a 24px bar, so a full
 * thousands-separated count would crowd out the metrics beside it.
 */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * Percentage of input tokens that were cache reads.
 *
 * Returns null rather than 0 when there was no input at all: "0% cached" and
 * "nothing recorded" are different statements, and only one of them is true.
 */
export function cachedPercent(cached: number, fresh: number): number | null {
  const total = cached + fresh;
  if (total <= 0) return null;
  return (cached / total) * 100;
}

export interface UsageTotals {
  day: string;
  cost: number;
  fresh: number;
  cached: number;
  output: number;
}

export interface UsageSnapshot {
  /** The most recent day that has data — not necessarily today. */
  latest: UsageTotals | null;
  latestIsCurrent: boolean;
  month: { label: string; cost: number } | null;
}

/**
 * One read-only handle for the plugin's lifetime.
 *
 * The Usage plugin writes in WAL mode, so a reader never blocks its writer.
 * `node:sqlite` is a Node built-in, so there is no native module to build.
 *
 * The handle is deliberately long-lived rather than opened per poll: the bar
 * asks every 3 seconds, and reopening a SQLite file that often is pure waste.
 */
export function createUsageStore(databasePath: string = DEFAULT_DB_PATH) {
  let handle: DatabaseSync | null = null;

  function connection(): DatabaseSync {
    if (handle === null) {
      handle = new DatabaseSync(databasePath, { readOnly: true });
      // The writer may hold the lock briefly during a sync; wait rather than
      // failing the section for one poll.
      handle.exec("PRAGMA busy_timeout = 2000");
    }
    return handle;
  }

  function read(now: Date = new Date()): UsageSnapshot {
    const conn = connection();

    // The newest day with data, rather than "today": a machine that has not run
    // an agent today still has a meaningful last reading, and reporting $0.00
    // would be wrong.
    const latestRow = conn
      .prepare(
        `SELECT day,
                SUM(cost_usd)               AS cost,
                SUM(uncached_input_tokens)  AS fresh,
                SUM(cached_input_tokens)    AS cached,
                SUM(output_tokens)          AS output
           FROM usage_events
          GROUP BY day
          ORDER BY day DESC
          LIMIT 1`,
      )
      .get() as
      | { day: string; cost: number | null; fresh: number | null; cached: number | null; output: number | null }
      | undefined;

    if (latestRow === undefined) {
      return { latest: null, latestIsCurrent: false, month: null };
    }

    const latest: UsageTotals = {
      day: String(latestRow.day),
      cost: Number(latestRow.cost ?? 0),
      fresh: Number(latestRow.fresh ?? 0),
      cached: Number(latestRow.cached ?? 0),
      output: Number(latestRow.output ?? 0),
    };

    // Month-to-date is taken for the month the newest data falls in, not the
    // current wall-clock month. On the 1st of a month, before any agent has
    // run, those differ and the data-driven choice is the honest one.
    const label = latest.day.slice(0, 7);
    const monthRow = conn
      .prepare(`SELECT SUM(cost_usd) AS cost FROM usage_events WHERE day LIKE ?`)
      .get(`${label}%`) as { cost: number | null } | undefined;

    return {
      latest,
      latestIsCurrent: latest.day === localDay(now),
      month: { label, cost: Number(monthRow?.cost ?? 0) },
    };
  }

  function close(): void {
    handle?.close();
    handle = null;
  }

  return { read, close };
}

export type UsageStore = ReturnType<typeof createUsageStore>;

/**
 * Build the section payload from a snapshot.
 *
 * The section is `headline`, not `metrics`: today's cost is the one figure
 * people glance at, and the bar renders a headline large with its caption
 * beside it. Month-to-date is returned as a `secondary` metric so it is the
 * first thing dropped on a narrow window — it is context, not the answer.
 */
export function toSection(snapshot: UsageSnapshot): SectionPayload {
  if (snapshot.latest === null) {
    return unavailableSection({
      topic: TOPIC,
      status: "idle",
      detail: "No usage recorded yet.",
    });
  }

  const { latest, latestIsCurrent, month } = snapshot;
  const cachePercent = cachedPercent(latest.cached, latest.fresh);

  // Two things are being said here, and both matter: HOW MUCH input was
  // served from cache (the cost driver) and how much of this month has been
  // spent (the context). The first doubles as the cache-health signal.
  const parts: string[] = [];
  if (cachePercent !== null) {
    parts.push(
      `${cachePercent >= 99.5 ? Math.round(cachePercent) : cachePercent.toFixed(0)}% cached`,
    );
  }
  parts.push(`${compactTokens(latest.cached)} cached · ${compactTokens(latest.fresh)} fresh in`);
  parts.push(`${compactTokens(latest.output)} out`);

  // Say plainly when the headline is not today's date. A stale number read as
  // "today" is the one genuinely misleading failure this section can have.
  const detail = latestIsCurrent
    ? parts.join(" · ")
    : `Latest data is ${latest.day} · ${parts.join(" · ")}`;

  return sectionPayloadSchema.parse({
    topic: TOPIC,
    status: "ok",
    presentation: "headline",
    metrics:
      month === null
        ? []
        : [
            {
              label: "MTD",
              value: money(month.cost),
              tone: "neutral",
              detail: `Month to date (${month.label}).`,
              importance: "secondary" as const,
            },
          ],
    headline: money(latest.cost),
    detail,
  });
}

/**
 * Read the store and build a section, converting any failure into a degraded
 * section rather than a thrown error.
 *
 * A section is independently degradable by design: a missing or unreadable
 * Usage database must render a short muted label, not break the bar.
 */
export function readUsageSection(store: UsageStore, now: Date = new Date()): SectionPayload {
  try {
    return toSection(store.read(now));
  } catch (error) {
    const message = (error as Error).message;
    // A missing store is by far the most likely failure, and it means exactly
    // one thing: the Usage plugin is not installed (or has not synced yet).
    // Say that, rather than making the reader infer it from a SQLite error
    // string. Every other failure keeps the raw message, because the raw
    // message is the useful part there.
    const missing = /unable to open database file/i.test(message);
    return unavailableSection({
      topic: TOPIC,
      status: "error",
      detail: missing
        ? "Usage plugin not installed — no store at ~/.bb/plugins/usage/data.db"
        : `Usage store unreadable: ${message}`,
    });
  }
}
