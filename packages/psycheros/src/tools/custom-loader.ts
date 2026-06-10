/**
 * Custom Tools Loader
 *
 * Dynamically loads user-written tools from the `.psycheros/custom-tools/`
 * directory inside dataRoot. Each `.js` file should export a default `Tool`
 * object matching the Tool interface.
 *
 * On first load after upgrade, migrates any files from the legacy
 * `{dataRoot}/custom-tools/` location into `.psycheros/custom-tools/` so
 * existing tools survive the path change without manual intervention.
 */

import type { Tool } from "./types.ts";
import { join, toFileUrl } from "@std/path";

/** The canonical subdirectory for custom tool files, relative to dataRoot. */
const CUSTOM_TOOLS_SUBDIR = join(".psycheros", "custom-tools");

/**
 * One-time migration: move `.js` files from the legacy `custom-tools/`
 * directory (at dataRoot level) into `.psycheros/custom-tools/`. Safe to call
 * on every startup — it's a no-op once migration is complete.
 */
async function migrateLegacyCustomTools(dataRoot: string): Promise<void> {
  const legacyDir = join(dataRoot, "custom-tools");
  const newDir = join(dataRoot, CUSTOM_TOOLS_SUBDIR);

  let legacyEntries;
  try {
    legacyEntries = Array.from(Deno.readDirSync(legacyDir));
  } catch {
    // Legacy directory doesn't exist — nothing to migrate.
    return;
  }

  const jsFiles = legacyEntries.filter(
    (e) => e.isFile && e.name.endsWith(".js"),
  );
  if (jsFiles.length === 0) {
    // Only remove the empty legacy directory to avoid re-checking next time.
    try {
      Deno.removeSync(legacyDir);
    } catch {
      // Non-fatal — directory may not be empty (non-.js files).
    }
    return;
  }

  console.log(
    `[CustomTools] Migrating ${jsFiles.length} tool(s) from legacy custom-tools/ → .psycheros/custom-tools/`,
  );

  await Deno.mkdir(newDir, { recursive: true });

  for (const entry of jsFiles) {
    const src = join(legacyDir, entry.name);
    const dest = join(newDir, entry.name);
    try {
      await Deno.rename(src, dest);
    } catch {
      // Cross-device rename won't work; fall back to copy + delete.
      await Deno.copyFile(src, dest);
      await Deno.remove(src);
    }
  }

  // Clean up the legacy directory if it's now empty.
  try {
    Deno.removeSync(legacyDir);
  } catch {
    // Non-fatal — directory may still contain non-.js files.
  }
}

/**
 * Load custom tools from the `.psycheros/custom-tools/` directory.
 *
 * Scans for `.js` files, dynamically imports each, validates it exports
 * a Tool object, and returns a record of tool name -> Tool.
 *
 * Logs warnings for invalid files but doesn't crash.
 * Returns empty record if the directory doesn't exist.
 */
export async function loadCustomTools(
  dataRoot: string,
): Promise<Record<string, Tool>> {
  await migrateLegacyCustomTools(dataRoot);

  const customDir = join(dataRoot, CUSTOM_TOOLS_SUBDIR);
  const tools: Record<string, Tool> = {};

  let entries;
  try {
    entries = Array.from(Deno.readDirSync(customDir));
  } catch {
    // Directory doesn't exist — no custom tools
    return tools;
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".js")) {
      continue;
    }

    const filePath = join(customDir, entry.name);

    try {
      // toFileUrl URL-encodes path segments (notably spaces, which appear
      // in `~/Library/Application Support/...` on macOS). Hand-rolling
      // `` `file://${filePath}` `` truncates the URL at the first space.
      const module = await import(toFileUrl(filePath).href);
      const tool = module.default as Tool | undefined;

      if (!tool || typeof tool !== "object") {
        console.warn(
          `[CustomTools] ${entry.name}: no default export — skipped`,
        );
        continue;
      }

      if (!tool.definition?.function?.name) {
        console.warn(
          `[CustomTools] ${entry.name}: missing definition.function.name — skipped`,
        );
        continue;
      }

      if (typeof tool.execute !== "function") {
        console.warn(
          `[CustomTools] ${entry.name}: execute is not a function — skipped`,
        );
        continue;
      }

      const name = tool.definition.function.name;
      tools[name] = tool;
      console.log(`[CustomTools] Loaded: ${name} (${entry.name})`);
    } catch (error) {
      console.warn(
        `[CustomTools] ${entry.name}: failed to load —`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return tools;
}
