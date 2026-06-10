/**
 * Memory Recall Tool
 *
 * Two-phase hybrid recall for deliberately finding memories that
 * the automatic eager RAG pass didn't surface.
 *
 * Phase 1 (search): Run grep + semantic search in parallel, merge
 * results into a compact hit list.
 * Phase 2 (read): Read specific memories in full by granularity+date+slug.
 *
 * My memories are recalled automatically every turn. I only use this
 * when someone asks me to try harder to remember, or when I sense I
 * should know something that didn't come up naturally.
 *
 * All operations go through entity-core via MCP — no local files.
 */

import type { Granularity } from "../memory/types.ts";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

export const memoryRecallTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search my memories for something specific that didn't come up automatically. " +
        "Search mode: I describe what I'm looking for and get a compact hit list from " +
        "both keyword and semantic matching. Read mode: I pick a specific memory from " +
        "the hit list to read in full using its granularity, date, and slug. " +
        "My memories are recalled for me every turn, so I only use this when someone " +
        "asks me to try harder to remember, or when I can tell I should know something " +
        "that wasn't surfaced.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What I'm trying to remember (search mode). Natural language " +
              "description — names, topics, places, feelings, anything that " +
              "might help locate the memory. Not used in read mode.",
          },
          max_results: {
            type: "number",
            description:
              "Maximum search hits to return (default: 15, max: 30). " +
              "Not used in read mode.",
          },
          granularity: {
            type: "string",
            enum: [
              "daily",
              "weekly",
              "monthly",
              "yearly",
              "significant",
            ],
            description:
              "Granularity of the memory to read in full (read mode).",
          },
          date: {
            type: "string",
            description: "Date of the memory to read in full (read mode). " +
              "YYYY-MM-DD for daily/significant, YYYY-WXX for weekly, " +
              "YYYY-MM for monthly, YYYY for yearly.",
          },
          slug: {
            type: "string",
            description: "Slug of a significant memory to read (read mode). " +
              "Only needed for significant memories that share a date " +
              "with other significant memories.",
          },
        },
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    if (!ctx.config.mcpClient?.isConnected()) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: entity-core is not connected. Memory recall requires entity-core.",
        isError: true,
      };
    }

    const granularity = args.granularity;
    const date = args.date;

    // --- READ MODE ---
    if (typeof granularity === "string" && typeof date === "string") {
      return await readMode(
        ctx,
        granularity,
        date,
        typeof args.slug === "string" ? args.slug : undefined,
      );
    }

    // --- SEARCH MODE ---
    const query = args.query;
    if (typeof query === "string" && query.trim().length > 0) {
      const maxResults = typeof args.max_results === "number"
        ? Math.min(Math.max(args.max_results, 1), 30)
        : 15;
      return await searchMode(ctx, query.trim(), maxResults);
    }

    return {
      toolCallId: ctx.toolCallId,
      content:
        "Provide 'query' for search mode, or 'granularity' + 'date' (and optionally 'slug') for read mode.",
      isError: true,
    };
  },
};

// ---------------------------------------------------------------------------
// Search mode: grep + semantic in parallel, merge, return compact hit list
// ---------------------------------------------------------------------------

interface MergedResult {
  granularity: string;
  date: string;
  slug?: string;
  title?: string;
  semanticScore: number;
  grepScore: number;
  combinedScore: number;
  excerpt: string;
  context?: string;
}

async function searchMode(
  ctx: ToolContext,
  query: string,
  maxResults: number,
): Promise<ToolResult> {
  try {
    const [semanticResults, grepResults] = await Promise.all([
      ctx.config.mcpClient!.searchMemories(query, { maxResults }),
      ctx.config.mcpClient!.grepMemories(query, { maxResults }),
    ]);

    const merged = new Map<string, MergedResult>();

    for (const r of semanticResults) {
      const key = `${r.granularity}|${r.date}`;
      merged.set(key, {
        granularity: r.granularity,
        date: r.date,
        semanticScore: r.score,
        grepScore: 0,
        combinedScore: r.score,
        excerpt: r.excerpt,
      });
    }

    for (const r of grepResults) {
      const key = r.slug
        ? `${r.granularity}|${r.date}|${r.slug}`
        : `${r.granularity}|${r.date}`;
      const existing = merged.get(key);

      if (existing) {
        existing.grepScore = r.score;
        existing.title = r.title;
        existing.combinedScore = (existing.semanticScore + r.score) / 2 +
          (existing.semanticScore > 0 && r.score > 0 ? 0.1 : 0);
      } else {
        merged.set(key, {
          granularity: r.granularity,
          date: r.date,
          slug: r.slug,
          title: r.title,
          semanticScore: 0,
          grepScore: r.score,
          combinedScore: r.score,
          excerpt: "",
          context: r.context,
        });
      }
    }

    const sorted = Array.from(merged.values())
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, maxResults);

    if (sorted.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `No memories found for "${query}". I may not have a memory matching this, or it may not be stored yet.`,
        isError: false,
      };
    }

    const formatted = sorted
      .map((r, i) => {
        const sources: string[] = [];
        if (r.semanticScore > 0) {
          sources.push(`semantic:${Math.round(r.semanticScore * 100)}%`);
        }
        if (r.grepScore > 0) {
          sources.push(`keyword:${Math.round(r.grepScore * 100)}%`);
        }
        const memoryId = r.slug
          ? `${r.granularity} ${r.date} slug=${r.slug}`
          : `${r.granularity} ${r.date}`;
        const title = r.title ?? r.date;
        const preview = r.excerpt || r.context || "";
        const truncated = preview.length > 300
          ? preview.slice(0, 300) + "..."
          : preview;
        return [
          `[${i + 1}] "${title}" (${r.date}) [${sources.join(", ")}]`,
          `    memory_id: ${memoryId}`,
          truncated ? `    ${truncated}` : null,
        ].filter(Boolean).join("\n");
      })
      .join("\n\n");

    return {
      toolCallId: ctx.toolCallId,
      content:
        `Found ${sorted.length} memories matching "${query}":\n\n${formatted}\n\n` +
        `To read any of these in full, call memory_recall with the granularity, date, and slug (if shown) from the memory_id.`,
      isError: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[Memory Recall] Search failed:", errorMessage);
    return {
      toolCallId: ctx.toolCallId,
      content: `Error searching memories: ${errorMessage}`,
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Read mode: fetch a single memory in full
// ---------------------------------------------------------------------------

async function readMode(
  ctx: ToolContext,
  granularity: string,
  date: string,
  slug?: string,
): Promise<ToolResult> {
  try {
    const memory = await ctx.config.mcpClient!.readMemory(
      granularity as Granularity,
      date,
      slug,
    );

    if (!memory) {
      return {
        toolCallId: ctx.toolCallId,
        content: `No memory found for ${granularity}/${date}${
          slug ? "/" + slug : ""
        }.`,
        isError: false,
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: memory.content,
      isError: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[Memory Recall] Read failed:", errorMessage);
    return {
      toolCallId: ctx.toolCallId,
      content: `Error reading memory: ${errorMessage}`,
      isError: true,
    };
  }
}
