# bb-plugin-statusbar-usage

A [Statusbar](https://github.com/RCopeland/bb-plugin-statusbar) section provider
that shows this machine's AI usage cost in the bar:

```
$0.01 │ OpenRouter 74% │ CPU 34% MEM 51% DISK 9% load 0.84 │ 14:32 Mon 13 Oct
MTD $6.26 · 88% cached · 418k cached · 58k fresh in · 4k out
```

Today's cost is the headline; month-to-date is a secondary metric that the bar
drops first on a narrow window. The caption carries the fresh/cached input
split, which is the cache-health signal.

## What it is, and what it is not

It is a **section provider**, not a bar. It does not draw anything, does not own
its position in the row, and cannot ship UI into the bar. It publishes one
discoverable RPC method returning data; the Statusbar plugin renders it.

Installing the Statusbar plugin is what puts this on screen. Installing this
plugin alone does nothing visible — nothing would call it.

## Install

```sh
git clone <this repo>
cd bb-plugin-statusbar-usage
npm install
bb plugin build .
bb plugin install . --yes
```

Requirements:

- **bb ≥ 0.44** (see `engines`).
- The **Usage** plugin — required, see below.
- The **Statusbar** plugin installed and running. This is what renders the
  section; without it nothing calls this plugin.
- Node ≥ 22.5 on the bb server, for `node:sqlite`. bb 0.44 ships a modern Node.

## This plugin requires bb-plugin-usage

**`bb-plugin-usage` must be installed and syncing. It is not optional.**

This plugin has no data source of its own. It does not read agent logs, does
not price tokens, and keeps no history. It reads the SQLite store that the
Usage plugin writes, and there is nothing to show until that plugin has run and
populated it.

```sh
# Install the Usage plugin first, if it is not already present.
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-usage.git@main --yes
```

Without it, the section is still *correct* — it renders
`Usage plugin not installed — no store at ~/.bb/plugins/usage/data.db` rather
than a wrong number or a blank bar. That is deliberate degradation, not a
working installation. A visible error label means **you are missing the
dependency**, not that this plugin is broken.

The store lives at `~/.bb/plugins/usage/data.db` by default. If the Usage
plugin is installed but the file is somewhere else, this plugin cannot find it:
there is no setting for the path, unlike `bb-plugin-usage-footer`.

### Why it depends on another plugin

Because the Usage plugin already backfills and prices every agent log on this
machine. Re-deriving cost independently would produce a second number that
silently disagrees with the Usage panel, and two numbers that disagree are worse
than one number that is occasionally missing.

## It claims the built-in `usage` topic

The Statusbar plugin ships its own fallback reader for `usage`. Claiming that
topic means this plugin **replaces** that reading rather than adding a second
usage section beside it.

The bar keeps its fallback. Disabling or uninstalling this plugin returns the
slot to the bar's own reading instead of leaving a gap — verified by disabling
the plugin and observing `usage` go back to `kind: "builtin"`:

```sh
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json   # see `sources`
```

## Data source, and the coupling it implies

Reads the SQLite store written by the **Usage** plugin, at
`~/.bb/plugins/usage/data.db` (the `usage_events` table), so the numbers match
the Usage panel exactly. It does not parse agent logs or re-price anything
itself — a second pricing pass would produce a number that silently disagrees
with the panel.

> **Coupling:** this reads another plugin's private schema. It is a personal
> companion, not a marketplace plugin. If that schema changes, the section
> degrades to `Usage store unreadable: …` rather than throwing or blanking the
> bar. Pin the Usage plugin to a version so a schema change cannot surprise you.

**Cost is machine-local.** The store only sees agents that ran on this machine.
It is not an account-wide figure, and on a host with an OpenRouter key it will
not match OpenRouter's own `total_usage` (which is account-wide). The two are
never merged.

## Design notes

**Today means the newest day with data, not the wall-clock day.** A machine that
has not run an agent today still has a meaningful last reading, and `$0.00` would
be a lie. When the newest data is not today, the caption says so — a stale
number read as "today" is the one genuinely misleading failure this section can
have.

**Day boundaries follow the server's local calendar**, matching how the Usage
plugin buckets, so "today" agrees with the Usage panel.

**Failure degrades locally.** A missing database, a corrupt file, or an empty
table each produce a distinct, visible section state (`error` / `idle`) rather
than an exception. A section is independently degradable by design.

**One long-lived read-only connection.** The bar polls every 3s; the handle is
opened once and the file is WAL, so a reader never blocks the Usage plugin's
writer.

## Development

```sh
npm run typecheck
npm run build
bb plugin install . --yes
bb plugin reload statusbar-usage

# Confirm the bar picked it up (up to 10s discovery lag)
bb plugin rpc call statusbar providers --json
bb plugin rpc call statusbar snapshot --json
```

## License

MIT
