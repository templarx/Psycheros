// Tests the error-parsing logic in handleErrorResponse. Replicates the
// function body from src/llm/client.ts as a plain JS function so we can
// run it under Node without the full Deno runtime.

const ERROR_BODY_MAX = 4096;

// Replica of the handleErrorResponse logic (post-patch)
async function handleErrorResponse(response) {
  let errorMessage = `API request failed with status ${response.status}`;
  let errorCode;
  let rawBody = "";
  try {
    rawBody = await response.text();
    const trimmed = rawBody.length > ERROR_BODY_MAX
      ? rawBody.slice(0, ERROR_BODY_MAX) + "...[truncated]"
      : rawBody;
    let parsed = null;
    try { parsed = JSON.parse(rawBody); } catch {}
    if (parsed) {
      if (parsed.error && typeof parsed.error === "object") {
        errorMessage = parsed.error.message || parsed.error.type ||
          parsed.error.code || errorMessage;
        errorCode = parsed.error.code || parsed.error.type;
      } else if (parsed.error && typeof parsed.error === "string") {
        errorMessage = parsed.error;
      } else if (parsed.message && typeof parsed.message === "string") {
        errorMessage = parsed.message;
        errorCode = parsed.type || parsed.code;
      } else if (parsed.detail && typeof parsed.detail === "string") {
        errorMessage = parsed.detail;
      }
    } else if (trimmed) {
      const oneLine = trimmed.replace(/[\r\n]+/g, " ").trim();
      if (oneLine) errorMessage = `${errorMessage}: ${oneLine}`;
    }
    if (!rawBody) errorMessage = `${errorMessage}: ${response.statusText}`;
  } catch {
    errorMessage = `${errorMessage}: ${response.statusText}`;
  }
  return { message: errorMessage, code: errorCode, rawBody };
}

// Mock Response for tests
function mockResp(status, body, contentType) {
  return {
    status,
    statusText: status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : status === 429 ? "Too Many Requests" : "Error",
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

let pass = 0, fail = 0;
async function check(label, fn) {
  try {
    const out = await fn();
    const ok = out.ok;
    if (ok) { pass++; console.log(`  ok  ${label}`); }
    else { fail++; console.error(`  FAIL ${label}\n       ${JSON.stringify(out, null, 2).slice(0, 400)}`); }
  } catch (e) {
    fail++; console.error(`  FAIL ${label}\n       threw: ${e.message}`);
  }
}

console.log('-- handleErrorResponse error-body parsing --');

await check('OpenAI-shape JSON body: model not found', async () => {
  const r = mockResp(400, JSON.stringify({
    error: { message: "model 'glm-5.1' does not exist", type: "invalid_request_error", code: "model_not_found" }
  }), "application/json");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("glm-5.1") && out.code === "model_not_found",
    ...out,
  };
});

await check('OpenRouter-shape JSON body: error string', async () => {
  const r = mockResp(400, JSON.stringify({ error: "Provider returned error: model not found" }),
    "application/json");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("Provider returned error") && out.code === undefined,
    ...out,
  };
});

await check('Anthropic-shape JSON body: message + type', async () => {
  const r = mockResp(400, JSON.stringify({
    type: "error", message: "context length exceeded: 150000 > 131072"
  }), "application/json");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("context length exceeded") && out.code === "error",
    ...out,
  };
});

await check('Detail-wrapped body (Django / gateway)', async () => {
  const r = mockResp(429, JSON.stringify({ detail: "Rate limit exceeded. Try again in 30s." }),
    "application/json");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("Rate limit exceeded"),
    ...out,
  };
});

await check('Non-JSON body: plain text from upstream', async () => {
  // This is the case the user actually hit: electronhub returned 400
  // with a plain-text body. Old code would say "API request failed with
  // status 400". New code surfaces the real reason.
  const r = mockResp(400, "model glm-5.1 not found in provider catalog",
    "text/plain");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("glm-5.1 not found in provider catalog"),
    ...out,
  };
});

await check('Non-JSON body: HTML error page from gateway', async () => {
  const r = mockResp(502, "<html><body><h1>502 Bad Gateway</h1><p>upstream timed out</p></body></html>",
    "text/html");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("502 Bad Gateway") && out.message.includes("upstream"),
    ...out,
  };
});

await check('Empty body: falls back to status text', async () => {
  const r = mockResp(500, "", "text/plain");
  const out = await handleErrorResponse(r);
  return {
    ok: out.message.includes("500") && out.message.toLowerCase().includes("error"),
    ...out,
  };
});

await check('Very long body gets truncated, not blown up', async () => {
  const long = "x".repeat(10000);
  const r = mockResp(400, long, "text/plain");
  const out = await handleErrorResponse(r);
  return {
    ok: out.rawBody.length === 10000 && out.message.length < 6000,
    ...out,
  };
});

await check('Multiline body is collapsed to one line', async () => {
  const r = mockResp(400, "line one\nline two\nline three", "text/plain");
  const out = await handleErrorResponse(r);
  return {
    ok: !out.message.includes("\n") && out.message.includes("line one"),
    ...out,
  };
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);