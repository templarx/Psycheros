/**
 * Psycheros Daemon Entry Point
 *
 * Starts the persistent entity harness server.
 */
import "@std/dotenv/load";
import { initLogCapture } from "./server/logger.ts";
initLogCapture();
import { Server } from "./server/mod.ts";
import { createMCPClient, type MCPClient } from "./mcp-client/mod.ts";
import { initialize } from "./init/mod.ts";
import { prepareVectorExtension } from "./db/mod.ts";
import { getDefaultWebSearchSettings } from "./llm/web-search-settings.ts";
import { loadEntityCoreLLMSettings } from "./llm/entity-core-settings.ts";
import { join } from "@std/path";
import { VERSION } from "./version.ts";

//=====================GENERATES CUSTOM TOOLS FROM MCP
import { ensureDir, writeFile } from "@std/fs";
async function generateCustomToolWrappers(
  clients: Array<{ name: string; client: any }>
) {
  const customToolsDir = join(config.dataRoot, ".psycheros", "custom-tools");
  await ensureDir(customToolsDir);

  console.log("[Tools] Generating custom tool wrappers...");

  for (const { name: sourceName, client } of clients) {
    if (!client) continue;

    // Determine which URL to call based on the source
    const targetUrl = sourceName === "n8n"
      ? (Deno.env.get("N8N_MCP_URL") || "http://n8n:5678/mcp-server/http")
      : (Deno.env.get("MCP_GATEWAY_URL") || "http://mcp-gateway:3019/mcp");

    try {
      const result = await client.request("tools/list");
      const tools = result.result?.tools || result.tools || [];

      for (const tool of tools) {
        const wrapperName = `${sourceName}__${tool.name}`;
        const filePath = join(customToolsDir, `${wrapperName}.js`);

        const wrapperContent = `
export const definition = {
  function: {
    name: "${wrapperName}",
    description: ${JSON.stringify(tool.description || "")},
    parameters: ${JSON.stringify(tool.inputSchema || { type: "object", properties: {} })}
  }
};

export async function execute(args) {
  const res = await fetch("${targetUrl}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "${tool.name}",
        arguments: args
      }
    })
  });
  return res.json();
}
`;

        await Deno.writeTextFile(filePath, wrapperContent);
      }
    } catch (err) {
      console.error(`[Tools] Failed to generate wrappers for ${sourceName}:`, err.message);
    }
  }

  console.log("[Tools] Custom tool wrappers generated.");
}

/**
 * ==================  Creates a simple client to talk to the MCP Gateway over HTTP.
 */
async function createN8nMCPClient() {
  const url = Deno.env.get("N8N_MCP_URL");
  const token = Deno.env.get("N8N_MCP_TOKEN");

  if (!url) return null;

  console.log("[MCP] Connecting to n8n MCP...");

  const n8nClient = {
    async request(method: string, params?: Record<string, unknown>) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };

      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`n8n MCP request failed: ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "";

      // Handle Server-Sent Events (SSE) response from n8n
      if (contentType.includes("text/event-stream")) {
        const text = await response.text();
        // Extract JSON from SSE format
        const match = text.match(/data: ({.*})/);
        if (match) {
          return JSON.parse(match[1]);
        }
        throw new Error("Failed to parse SSE response from n8n");
      }

      // Normal JSON response
      return response.json();
    },
  };

  try {
    const result = await n8nClient.request("tools/list");
    console.log(`[MCP] ✅ Connected to n8n MCP (${result.result?.tools?.length ?? 0} tools)`);
    return n8nClient;
  } catch (err) {
    console.error("[MCP] Failed to connect to n8n MCP:", err);
    return null;
  }
}


async function createMCPGatewayClient() {
  const url = Deno.env.get("MCP_GATEWAY_URL");
  if (!url) return null;

  console.log("[MCP] Connecting to MCP Gateway...");

  const gatewayClient = {
    async request(method: string, params?: Record<string, unknown>) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      });

      if (!response.ok) {
        throw new Error(`Gateway request failed: ${response.status}`);
      }

      return response.json();
    },
  };

  try {
    const result = await gatewayClient.request("tools/list");
    console.log(`[MCP] ✅ Connected to MCP Gateway (${result.result?.tools?.length ?? 0} tools)`);
    return gatewayClient;
  } catch (err) {
    console.error("[MCP] Failed to connect to MCP Gateway:", err);
    return null;
  }
}

/**
 * Parse the PSYCHEROS_TOOLS environment variable into an array of tool names.
 */
function parseAllowedTools(): string[] {
  const toolsEnv = Deno.env.get("PSYCHEROS_TOOLS");
  if (!toolsEnv || toolsEnv.trim() === "") {
    return [];
  }
  return toolsEnv
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Parse the PSYCHEROS_RAG_ENABLED environment variable.
 */
function parseRagEnabled(): boolean {
  const env = Deno.env.get("PSYCHEROS_RAG_ENABLED");
  if (env === undefined || env === "") {
    return true;
  }
  return env.toLowerCase() === "true" || env === "1";
}

// Configuration
const allowedTools = parseAllowedTools();
const ragEnabled = parseRagEnabled();
const projectRoot = Deno.cwd();
const dataRoot = Deno.env.get("PSYCHEROS_DATA_DIR") || projectRoot;

const config = {
  port: parseInt(Deno.env.get("PSYCHEROS_PORT") || "3000"),
  hostname: Deno.env.get("PSYCHEROS_HOST") || "0.0.0.0",
  projectRoot,
  dataRoot,
  allowedTools,
  ragConfig: {
    enabled: ragEnabled,
    maxChunks: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_CHUNKS") || "8"),
    maxTokens: parseInt(Deno.env.get("PSYCHEROS_RAG_MAX_TOKENS") || "2000"),
    minScore: parseFloat(Deno.env.get("PSYCHEROS_RAG_MIN_SCORE") || "0.3"),
  },
};

console.log(`
╔═══════════════════════════════════════╗
║ Psycheros v${VERSION} ║
║ Entity Harness Daemon ║
╚═══════════════════════════════════════╝
`);

await initialize(config.projectRoot, config.dataRoot);

console.log(`Starting server on http://${config.hostname}:${config.port}`);
console.log(`Project root: ${config.projectRoot}`);
if (config.dataRoot !== config.projectRoot) {
  console.log(`Data root: ${config.dataRoot}`);
}
console.log(
  `Tools enabled (PSYCHEROS_TOOLS): ${
    allowedTools.length > 0 ? allowedTools.join(", ") : "(default — all tools)"
  }`,
);
console.log(`RAG enabled: ${ragEnabled}`);

const webSearchDefaults = getDefaultWebSearchSettings();
console.log(`Web search: ${webSearchDefaults.provider}`);
console.log(`Press Ctrl+C to stop\n`);

// === Entity Core MCP Client ===
let mcpClient: MCPClient | undefined;
const mcpEnabled = Deno.env.get("PSYCHEROS_MCP_ENABLED") !== "false";

const { loadProfileSettings, getActiveProfile } = await import("./llm/mod.ts");
const activeProfile = getActiveProfile(
  await loadProfileSettings(config.dataRoot),
);

if (activeProfile) {
  console.log(
    `Active LLM profile: "${activeProfile.name}" (${activeProfile.provider}) — ${activeProfile.model}`,
  );
}

if (mcpEnabled) {
  const mcpCommand = Deno.env.get("PSYCHEROS_MCP_COMMAND") || "deno";
  const entityCoreRoot = Deno.env.get("PSYCHEROS_ENTITY_CORE_PATH") ||
    join(config.projectRoot, "..", "entity-core");

  const customArgs = Deno.env.get("PSYCHEROS_MCP_ARGS");
  const mcpArgs: string[] = customArgs
    ? customArgs.split(" ")
    : ["run", "-A", `${entityCoreRoot}/src/mod.ts`];

  const mcpInstance = Deno.env.get("PSYCHEROS_MCP_INSTANCE") || "psycheros";
  const entityCoreDataDir = Deno.env.get("PSYCHEROS_ENTITY_CORE_DATA_DIR") ||
    `${entityCoreRoot}/data`;

  console.log(`MCP enabled: connecting to entity-core as ${mcpInstance}`);

  const ecLLMSettings = await loadEntityCoreLLMSettings(config.dataRoot);
  const ecTemperature = ecLLMSettings.temperature ?? 0.3;
  const ecMaxTokens = ecLLMSettings.maxTokens ?? 8000;

  mcpClient = createMCPClient({
    command: mcpCommand,
    args: mcpArgs,
    instanceId: mcpInstance,
    env: {
      ENTITY_CORE_DATA_DIR: entityCoreDataDir,
      ENTITY_CORE_LLM_API_KEY: Deno.env.get("ENTITY_CORE_LLM_API_KEY") ||
        activeProfile?.apiKey || Deno.env.get("ZAI_API_KEY") || "",
      ENTITY_CORE_LLM_BASE_URL: Deno.env.get("ENTITY_CORE_LLM_BASE_URL") ||
        activeProfile?.baseUrl || Deno.env.get("ZAI_BASE_URL") || "",
      ENTITY_CORE_LLM_MODEL: ecLLMSettings.model ||
        Deno.env.get("ENTITY_CORE_LLM_MODEL") || activeProfile?.model ||
        Deno.env.get("ZAI_MODEL") || "",
      ENTITY_CORE_LLM_TEMPERATURE:
        Deno.env.get("ENTITY_CORE_LLM_TEMPERATURE") || String(ecTemperature),
      ENTITY_CORE_LLM_MAX_TOKENS: Deno.env.get("ENTITY_CORE_LLM_MAX_TOKENS") ||
        String(ecMaxTokens),
      ZAI_API_KEY: Deno.env.get("ZAI_API_KEY") || "",
      ZAI_BASE_URL: Deno.env.get("ZAI_BASE_URL") || "",
      ZAI_MODEL: Deno.env.get("ZAI_MODEL") || "",
    },
    syncOnStartup: true,
    offlineFallback: true,
    localBasePath: config.dataRoot,
  });

  try {
    const connected = await mcpClient.connect();
    if (connected) {
      console.log("[MCP] Connected to entity-core");
    } else {
      console.log("[MCP] Running in offline mode (will sync when available)");
    }
  } catch (error) {
    console.error("[MCP] Connection failed:", error);
    console.log("[MCP] Running in offline mode");
  }
}

// === NEW: MCP Gateway Client ===
const gatewayClient = await createMCPGatewayClient();
const n8nMCPClient = await createN8nMCPClient();   

// Build remoteMCPs array (supports multiple sources)
const remoteMCPs = [];

if (gatewayClient) {
  remoteMCPs.push({ name: "gateway", client: gatewayClient });
}

if (n8nMCPClient) {
  remoteMCPs.push({ name: "n8n", client: n8nMCPClient });
}
// Generate custom tool wrappers from both sources
const remoteClients = [];
if (gatewayClient) remoteClients.push({ name: "gateway", client: gatewayClient });
if (n8nMCPClient) remoteClients.push({ name: "n8n", client: n8nMCPClient });

if (remoteClients.length > 0) {
  await generateCustomToolWrappers(remoteClients);
}

//=================================

// Ensure sqlite-vec extension is available
await prepareVectorExtension(config.projectRoot);

const server = new Server({
  ...config,
  mcpClient,
  remoteMCPs,
});


await server.init();

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");
  if (mcpClient) {
    console.log("[MCP] Syncing and disconnecting...");
    await mcpClient.disconnect();
  }
  server.stop();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

await server.start();
