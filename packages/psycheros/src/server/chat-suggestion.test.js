// Tests for the prompt-construction logic in handleChatSuggestion.
// Replicates the relevant slice in plain JS so we can run under Node.

const SYSTEM_PROMPT_TEMPLATE = (userName, entityName) =>
  `You are helping ${userName} draft their next reply to ${entityName} in an ongoing chat. ` +
  `Read the conversation below and write what ${userName} would naturally say next. ` +
  `Constraints: ` +
  `(1) Output ONLY the message text — no preamble, no quotes, no "Here's a draft:", no role labels. ` +
  `(2) Stay in character — match the tone, length, and vocabulary ${userName} has been using. ` +
  `(3) Keep it under 150 words unless the conversation clearly warrants more. ` +
  `(4) If the previous message asked a question, ${userName}'s reply should answer it. ` +
  `(5) Do not include tool calls, code fences, or markdown structure unless ${userName} has been using them. ` +
  `(6) Write in the same language as the conversation.`;

// Replica of the prompt-building logic
function buildSuggestionMessages(filteredMessages, userName, entityName) {
  return [
    { role: "system", content: SYSTEM_PROMPT_TEMPLATE(userName, entityName) },
    ...filteredMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: `Now write ${userName}'s next message in this conversation.` },
  ];
}

// Replica of contextCount clamping
function clampContextCount(input, fallback = 5) {
  return Math.max(1, Math.min(10, Number(input) || fallback));
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = typeof expected === "function" ? expected(actual) : actual === expected;
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}\n       got: ${JSON.stringify(actual)}`); }
}

console.log("-- chat-suggestion prompt construction --");

// Empty history — should still produce a valid messages array with just the system + final user
const m1 = buildSuggestionMessages([], "Alice", "Bot");
check("empty history → 2 messages (system + final user)", m1.length, 2);
check("empty history → first is system", m1[0].role, "system");
check("empty history → system prompt names user", m1[0].content.includes("Alice"), true);
check("empty history → system prompt names entity", m1[0].content.includes("Bot"), true);
check("empty history → last is the final user prompt", m1[1].content, "Now write Alice's next message in this conversation.");

// 3-message history — should produce 5 messages (system + 3 history + final user)
const history = [
  { role: "user", content: "Hey, what's up?" },
  { role: "assistant", content: "Not much. Working on some code." },
  { role: "user", content: "Cool. Want to grab coffee?" },
];
const m2 = buildSuggestionMessages(history, "Alice", "Bot");
check("3-history → 5 messages total", m2.length, 5);
check("3-history → system first", m2[0].role, "system");
check("3-history → history verbatim", m2[1].content, "Hey, what's up?");
check("3-history → assistant message preserved", m2[2].role, "assistant");
check("3-history → last message from user", m2[3].content, "Cool. Want to grab coffee?");
check("3-history → final user prompt last", m2[4].role, "user");
check("3-history → final prompt uses user name", m2[4].content.includes("Alice"), true);

// System messages in history should be filtered out (server-side responsibility,
// but we test the input here)
const withSystem = [
  { role: "system", content: "You are a helpful bot" },  // filtered by caller
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
];
const filtered = withSystem.filter((m) => m.role === "user" || m.role === "assistant");
const m3 = buildSuggestionMessages(filtered, "Alice", "Bot");
check("system messages are filtered before prompt", m3.length, 4); // 1 system + 2 hist + 1 final user
check("system content not in prompt", m3.some((m) => m.content === "You are a helpful bot"), false);

// Special characters in user names shouldn't break the prompt
const m4 = buildSuggestionMessages([{ role: "user", content: "test" }], "O'Brien", "Bot");
check("apostrophe in user name doesn't crash", m4[0].content.includes("O'Brien"), true);

// Default names when settings are empty — caller (route handler) does the
// fallback with `|| "You"` / `|| "Assistant"` before calling buildSuggestionMessages.
const m5 = buildSuggestionMessages([], "You", "Assistant");
check("default user name 'You' surfaces in prompt", m5[0].content.includes("You"), true);
check("default entity name 'Assistant' surfaces in prompt", m5[0].content.includes("Assistant"), true);

console.log("\n-- contextCount clamping --");
check("default 5 on undefined", clampContextCount(undefined), 5);
check("default 5 on null", clampContextCount(null), 5);
check("default 5 on 0", clampContextCount(0), 5);
check("negative clamped to 1", clampContextCount(-3), 1);
check("above 10 clamped to 10", clampContextCount(20), 10);
check("valid 5 stays 5", clampContextCount(5), 5);
check("valid 1 stays 1", clampContextCount(1), 1);
check("valid 10 stays 10", clampContextCount(10), 10);
check("non-number coerced to default", clampContextCount("abc"), 5);
check("string '7' coerced", clampContextCount("7"), 7);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);