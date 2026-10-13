// bb-plugin-statusbar-usage — a Statusbar section provider.
//
// WHAT THIS IS
//
// One discoverable RPC method that returns the machine's AI usage cost as a
// statusbar section. The Statusbar plugin finds it on its next discovery tick,
// matches it by topic, and prefers it over its own built-in reader for that
// topic.
//
// There is no dependency to declare and no install order to respect. BB has no
// plugin dependency mechanism at all — a provider advertises, the bar polls and
// matches. That is the whole contract:
//
//   You owe it:  one discoverable method returning a valid section payload.
//   It owes you: a slot in the row, and correct degradation if you fail.
//
// If no Statusbar is installed, nothing ever calls this code and it costs
// nothing. It does not check for the bar at startup, and it must not: `bb.sdk`
// does not exist during the plugin factory, and the bar may be installed or
// removed while this plugin runs.
//
// IT CLAIMS THE BUILT-IN `usage` TOPIC
//
// `usage` is one of the topics the bar ships a fallback reader for. Claiming it
// replaces that reading rather than adding a section beside it. The bar keeps
// its fallback, so disabling this plugin degrades gracefully instead of leaving
// a gap.
//
// DATA SOURCE
//
// The Usage plugin's SQLite store (bb-plugin-usage). This reads another
// plugin's private schema, which is a real coupling: if that schema changes,
// this section degrades to a visible "Usage store unreadable" label rather than
// throwing or blanking the bar.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
} from "@robcopeland/bb-statusbar-section-protocol";
import { DEFAULT_DB_PATH, createUsageStore, readUsageSection } from "./section.js";

export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "Today's AI usage cost, as a statusbar section.",
  },
  /**
   * Declared because the bar routes a section's controls back to the plugin
   * that owns them. This section advertises no `actions`, so this exists only
   * to satisfy the contract and to fail clearly if it is ever reached.
   */
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  const databasePath = DEFAULT_DB_PATH;
  const store = createUsageStore(databasePath);

  // The bar polls every 3 seconds. `read()` is a grouped query against a
  // local SQLite file, so it is cheap enough to answer directly without
  // layering a cache on top.
  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: () => ({
        generatedAt: new Date().toISOString(),
        section: readUsageSection(store),
      }),

      [SECTION_METHOD_ACTION]: ({ actionId }) => {
        // Reachable only if the section advertises actions, which it does not.
        throw new Error(`The usage section has no "${actionId}" action.`);
      },
    },
    {
      // THE LINE THAT MAKES THIS A PROVIDER. Without it the method is callable
      // by id, but the bar cannot find it by asking the host which plugins
      // publish section methods.
      experimental_discoverable: true,
      experimental_description: "A usage cost section for the Statusbar plugin.",
    },
  );

  bb.onDispose(() => {
    store.close();
  });

  bb.log.info(`ready (usage provider; reading ${databasePath})`);
}
