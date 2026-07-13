#!/usr/bin/env bun
/**
 * sync-surface-sdk.ts — fetch the cortex plugin-SDK type artifact (cortex#1950).
 *
 * This bundle compiles its `PlatformAdapter` / `AdapterPlugin` implementation
 * against the cortex plugin-SDK contract with `import type { … } from
 * "@the-metafactory/cortex/surface-sdk"`. Those imports are erased at runtime
 * (the cortex loader's dynamic `import()` never resolves them), but the bundle's
 * standalone `bunx tsc --noEmit` needs the types RESOLVABLE.
 *
 * Rather than hand-vendor a copy of the contract (which drifts on every
 * `SURFACE_SDK_VERSION` bump and does not scale across bundles), we fetch the
 * single, self-contained `.d.ts` cortex generates and ships
 * (`src/surface-sdk/generated/surface-sdk.d.ts`, exposed via
 * `package.json` exports["./surface-sdk"]) at a PINNED ref, into a gitignored
 * `sdk/` dir. `tsconfig.json`'s `paths` maps the import specifier there.
 *
 * - Lands in THIS repo's tree, so its lone external import (`zod/v4`) resolves
 *   the bundle's OWN zod — no cross-instance zod-type skew, and no cortex
 *   dependency tree (react/discord.js/…) dragged in for types alone.
 * - Machine-fetched from a pinned cortex commit — never hand-edited, so it
 *   cannot drift the way the old `src/vendor/surface-sdk.ts` did.
 *
 * The pinned ref lives in `.cortex-sdk-ref` (committed). Bump it — a one-line,
 * reviewable change — to adopt a new `SURFACE_SDK_VERSION`. Staleness is never
 * silent: if the pinned types fall out of the running daemon's supported range,
 * the cortex S6 loader refuses this bundle at load (`satisfies(SURFACE_SDK_VERSION,
 * sdkRange)`), it does not silently mis-run.
 *
 * Run explicitly with `bun run sync:sdk`; it also runs on `postinstall`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REF_FILE = join(repoRoot, ".cortex-sdk-ref");
const OUT = join(repoRoot, "sdk", "surface-sdk.d.ts");
const SRC_PATH = "src/surface-sdk/generated/surface-sdk.d.ts";

const ref = (process.env.CORTEX_SDK_REF ?? readFileSync(REF_FILE, "utf8"))
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l.length > 0 && !l.startsWith("#"));

if (!ref) {
  process.stderr.write(`sync-surface-sdk: no ref in ${REF_FILE} (or $CORTEX_SDK_REF)\n`);
  process.exit(1);
}

const url = `https://raw.githubusercontent.com/the-metafactory/cortex/${ref}/${SRC_PATH}`;

const res = await fetch(url);
if (!res.ok) {
  process.stderr.write(
    `sync-surface-sdk: failed to fetch ${url}\n  HTTP ${res.status} ${res.statusText}\n` +
      `  (is the ref '${ref}' pushed to cortex, and does it contain ${SRC_PATH}?)\n`,
  );
  process.exit(1);
}

const body = await res.text();
if (!body.includes("SURFACE_SDK_VERSION") || !body.includes("PlatformAdapter")) {
  process.stderr.write(
    `sync-surface-sdk: fetched file from ${url} does not look like the SDK artifact ` +
      `(missing SURFACE_SDK_VERSION / PlatformAdapter). Refusing to write.\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `// Fetched by scripts/sync-surface-sdk.ts from cortex@${ref} — DO NOT EDIT.\n` +
    `// Regenerate: bun run sync:sdk (ref pinned in .cortex-sdk-ref).\n` +
    body,
);
process.stdout.write(`sync-surface-sdk: wrote ${OUT} from cortex@${ref}\n`);
