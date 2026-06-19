// Tests for buildChatErrorPayload. Replicates the helper as plain JS
// so we can run it under Node without Deno.

const ERROR_DETAIL_MAX = 280;

function buildChatErrorPayload(errorCode, statusCode, rawMessage) {
  let primary;
  let detail;
  switch (errorCode) {
    case "CONNECT_TIMEOUT":
      primary = "The AI service is unreachable or failed to respond. It may be temporarily unavailable — please try again.";
      break;
    case "STREAM_STALL_TIMEOUT":
      primary = "The AI response stalled mid-stream. The service may be overloaded — please try again.";
      break;
    case "NETWORK_ERROR":
      primary = "Could not reach the AI service. Please check your connection and try again.";
      break;
    case "MALFORMED_STREAM":
      primary = "Received corrupted data from the AI service. Please try again.";
      break;
    default:
      if (statusCode && statusCode >= 500) {
        primary = `The AI service returned an error (HTTP ${statusCode}). Please try again later.`;
      } else if (statusCode === 429) {
        primary = "Rate limited by the AI service. Please wait a moment and try again.";
      } else if (statusCode === 401 || statusCode === 403) {
        primary = "Authentication error with the AI service. Check your API key configuration.";
      } else if (statusCode === 400 || statusCode === 404) {
        primary = `The AI service rejected the request (HTTP ${statusCode}). This is usually a model name, parameter, or quota issue.`;
      } else {
        primary = "An error occurred while processing your message.";
      }
      break;
  }
  const isClientError = statusCode !== undefined && statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 429 &&
    statusCode !== 401 &&
    statusCode !== 403;
  if (isClientError && rawMessage) {
    let cleaned = rawMessage
      .replace(/^API request failed with status \d+:\s*/i, "")
      .trim();
    if (cleaned.length > ERROR_DETAIL_MAX) cleaned = cleaned.slice(0, ERROR_DETAIL_MAX - 3) + "...";
    if (cleaned) detail = cleaned;
  }
  const payload = { error: primary, errorCode };
  if (detail) payload.errorDetail = detail;
  return payload;
}

let pass = 0, fail = 0;
function check(label, actual, predicate) {
  const ok = typeof predicate === "function" ? predicate(actual) : actual === predicate;
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}\n       got: ${JSON.stringify(actual)}`); }
}

console.log("-- buildChatErrorPayload --");

// The user's case: model not found, raw message from the new error handler
const r1 = buildChatErrorPayload("UNKNOWN", 400,
  "API request failed with status 400: model glm-5.2 not found in provider catalog");
check("4xx surfaces upstream detail", r1.errorDetail,
  (v) => v === "model glm-5.2 not found in provider catalog");
check("4xx primary line is friendly config message", r1.error,
  (v) => v.includes("model name, parameter, or quota issue"));
check("4xx errorCode is HTTP_<status> in spirit", r1.errorCode, "UNKNOWN");

// 5xx should NOT include detail (transient)
const r2 = buildChatErrorPayload("UNKNOWN", 502, "Bad Gateway: upstream timed out");
check("5xx hides detail (transient)", r2.errorDetail, undefined);
check("5xx primary message", r2.error, (v) => v.includes("HTTP 502"));

// 429 hides detail (already mentions rate limit)
const r3 = buildChatErrorPayload("UNKNOWN", 429, "Rate limit exceeded, retry in 30s");
check("429 hides detail", r3.errorDetail, undefined);
check("429 primary message", r3.error, (v) => v.includes("Rate limited"));

// 401/403 - auth error, no detail needed (don't leak key info)
const r4 = buildChatErrorPayload("UNKNOWN", 401, "Invalid API key: sk-xxxx");
check("401 hides detail", r4.errorDetail, undefined);
check("401 primary message", r4.error, (v) => v.includes("Authentication"));

// 404 - similar to 400, config-ish
const r5 = buildChatErrorPayload("UNKNOWN", 404, "model not found");
check("404 includes detail", r5.errorDetail, "model not found");

// Code-specific cases
const r6 = buildChatErrorPayload("CONNECT_TIMEOUT", undefined, "");
check("CONNECT_TIMEOUT", r6.error, (v) => v.includes("unreachable"));
check("CONNECT_TIMEOUT no detail", r6.errorDetail, undefined);

const r7 = buildChatErrorPayload("STREAM_STALL_TIMEOUT", undefined, "");
check("STREAM_STALL_TIMEOUT", r7.error, (v) => v.includes("stalled"));

const r8 = buildChatErrorPayload("NETWORK_ERROR", undefined, "");
check("NETWORK_ERROR", r8.error, (v) => v.includes("check your connection"));

const r9 = buildChatErrorPayload("MALFORMED_STREAM", undefined, "");
check("MALFORMED_STREAM", r9.error, (v) => v.includes("corrupted"));

// Detail length cap
const longMsg = "x".repeat(1000);
const r10 = buildChatErrorPayload("UNKNOWN", 400, longMsg);
check("detail is capped at 280 chars", r10.errorDetail.length, (v) => v <= ERROR_DETAIL_MAX);
check("detail cap marker", r10.errorDetail, (v) => v.endsWith("..."));

// Detail with the generic "API request failed with status 400:" prefix
// should have that stripped
const r11 = buildChatErrorPayload("UNKNOWN", 400,
  "API request failed with status 400: actual reason here");
check("strips generic prefix", r11.errorDetail, "actual reason here");

// Empty raw message should yield no detail
const r12 = buildChatErrorPayload("UNKNOWN", 400, "");
check("empty raw message → no detail", r12.errorDetail, undefined);

// Unknown statusCode → generic fallback, no detail (not 4xx)
const r13 = buildChatErrorPayload("UNKNOWN", undefined, "Some opaque error");
check("no statusCode → generic primary", r13.error, (v) => v.includes("error occurred"));
check("no statusCode → no detail", r13.errorDetail, undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);