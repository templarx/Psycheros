// Tests for the prompt-construction logic in handleChatSuggestion.
// Replicates the relevant slice in plain JS so we can run under Node.

const SYSTEM_PROMPT_TEMPLATE = (userName, entityName, contextCount) =>
  `You are helping ${userName} draft their next message in response to ` +
  `${entityName} (the AI Bot). ` +
  `Below are the last ${contextCount} exchanges from the conversation. ` +
  `Each exchange shows what ${userName} said and what ${entityName} replied. ` +
  `Write what ${userName} would naturally say NEXT, on their own behalf, ` +
  `in response to the most recent ${entityName} reply. ` +
  `Constraints: ` +
  `(1) Output ONLY the message text — no preamble, no quotes, no "Here's a draft:", no role labels. ` +
  `(2) Stay in character — match the tone, length, vocabulary, and style ${userName} has been using in the user messages shown above. ` +
  `(3) Keep it under 150 words unless the conversation clearly warrants more. ` +
  `(4) The reply should respond to the LAST ${entityName} message (the most recent bot reply). ` +
  `(5) If the last ${entityName} message asked a question, ${userName}'s reply should answer it. ` +
  `(6) Do not include tool calls, code fences, or markdown structure unless ${userName} has been using them. ` +
  `(7) Write in the same language as the conversation.`;

// Replica of selectAssistantContext — picks the last `assistantCount`
// assistant messages from a filtered history, each paired with the user
// message that immediately preceded it.
function selectAssistantContext(filtered, assistantCount) {
  const result = [];
  let picked = 0;

  for (let i = filtered.length - 1; i >= 0 && picked < assistantCount; i--) {
    const m = filtered[i];
    if (m.role !== "assistant") continue;

    result.unshift({ role: "assistant", content: String(m.content || "") });

    if (i > 0 && filtered[i - 1].role === "user") {
      result.unshift({ role: "user", content: String(filtered[i - 1].content || "") });
    }
    picked++;
  }

  return result;
}

// Replica of the prompt-building logic — receives the *selected* context
// (already narrowed by selectAssistantContext) plus the user/entity names.
function buildSuggestionMessages(contextMessages, userName, entityName, contextCount) {
  return [
    { role: "system", content: SYSTEM_PROMPT_TEMPLATE(userName, entityName, contextCount) },
    ...contextMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: `Now write ${userName}'s next message, responding to ${entityName}'s most recent reply.` },
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

console.log("-- selectAssistantContext: last N assistant + paired user --");

// Empty history
const empty = selectAssistantContext([], 5);
check("empty history → empty context", empty.length, 0);

// Only user messages (no assistant yet) — common when the user just sent a message
const userOnly = selectAssistantContext(
  [{ role: "user", content: "Hi bot" }],
  5,
);
check("only user messages → empty context (no assistant to respond to)", userOnly.length, 0);

// Single exchange: 1 user + 1 assistant → context = [user, assistant]
const onePair = selectAssistantContext(
  [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
  ],
  5,
);
check("1 exchange → 2 messages", onePair.length, 2);
check("1 exchange → starts with user", onePair[0].role, "user");
check("1 exchange → user content preserved", onePair[0].content, "Hi");
check("1 exchange → ends with assistant", onePair[1].role, "assistant");
check("1 exchange → assistant content preserved", onePair[1].content, "Hello!");

// Two exchanges (4 messages) with assistantCount=2 → both pairs included
const twoExchanges = selectAssistantContext(
  [
    { role: "user", content: "First user" },
    { role: "assistant", content: "First assistant" },
    { role: "user", content: "Second user" },
    { role: "assistant", content: "Second assistant" },
  ],
  2,
);
check("2 exchanges, count=2 → 4 messages (both pairs)", twoExchanges.length, 4);
check("2 exchanges → starts with first user (chronological order)", twoExchanges[0].content, "First user");
check("2 exchanges → first assistant follows", twoExchanges[1].content, "First assistant");
check("2 exchanges → second user third", twoExchanges[2].content, "Second user");
check("2 exchanges → last is second assistant (so draft responds to it)", twoExchanges[3].content, "Second assistant");
check("2 exchanges → last role is assistant", twoExchanges[3].role, "assistant");

// 2 exchanges but only ask for 1 most recent assistant → just the latest pair
const justLatest = selectAssistantContext(
  [
    { role: "user", content: "First user" },
    { role: "assistant", content: "First assistant" },
    { role: "user", content: "Second user" },
    { role: "assistant", content: "Second assistant" },
  ],
  1,
);
check("2 exchanges, count=1 → 2 messages (latest pair only)", justLatest.length, 2);
check("2 exchanges, count=1 → starts with second user", justLatest[0].content, "Second user");
check("2 exchanges, count=1 → ends with second assistant", justLatest[1].content, "Second assistant");

// Many exchanges, count=5 → only the most recent 5 pairs included
const manyExchanges = [];
for (let i = 1; i <= 10; i++) {
  manyExchanges.push({ role: "user", content: `user-${i}` });
  manyExchanges.push({ role: "assistant", content: `assistant-${i}` });
}
const recentFive = selectAssistantContext(manyExchanges, 5);
check("10 exchanges, count=5 → 10 messages (5 pairs)", recentFive.length, 10);
check("recent 5 → first is user-6", recentFive[0].content, "user-6");
check("recent 5 → second is assistant-6", recentFive[1].content, "assistant-6");
check("recent 5 → last is assistant-10", recentFive[9].content, "assistant-10");

// Conversation ending with a user message (rare but possible): the trailing
// user message has no assistant reply yet, so it shouldn't appear in context
const trailingUser = selectAssistantContext(
  [
    { role: "user", content: "First user" },
    { role: "assistant", content: "First assistant" },
    { role: "user", content: "Unanswered user" },
  ],
  5,
);
check("trailing user (no assistant reply) → only the prior pair", trailingUser.length, 2);
check("trailing user → pair is [user, assistant]", trailingUser[0].content, "First user");
check("trailing user → trailing user dropped", trailingUser.some((m) => m.content === "Unanswered user"), false);

// System messages are filtered before this function is called (caller's job)
const withSystem = [
  { role: "system", content: "You are a helpful bot" },
  { role: "user", content: "Hi" },
  { role: "assistant", content: "Hello!" },
];
const preFiltered = withSystem.filter((m) => m.role === "user" || m.role === "assistant");
const sysResult = selectAssistantContext(preFiltered, 5);
check("system messages are filtered upstream", sysResult.some((m) => m.role === "system"), false);

console.log("\n-- chat-suggestion prompt construction --");

// Empty context (no assistant messages yet) — should produce just system + final user
const m1 = buildSuggestionMessages([], "Alice", "Bot", 5);
check("empty context → 2 messages (system + final user)", m1.length, 2);
check("empty context → first is system", m1[0].role, "system");
check("empty context → system prompt names user", m1[0].content.includes("Alice"), true);
check("empty context → system prompt names entity", m1[0].content.includes("Bot"), true);
check("empty context → system prompt mentions context count", m1[0].content.includes("last 5"), true);
check("empty context → last is the final user prompt", m1[1].content, "Now write Alice's next message, responding to Bot's most recent reply.");

// A typical 5-exchange context
const ctx = selectAssistantContext(
  [
    { role: "user", content: "Hey, what's up?" },
    { role: "assistant", content: "Not much. Working on some code." },
    { role: "user", content: "Cool. Want to grab coffee?" },
    { role: "assistant", content: "Sure, when?" },
    { role: "user", content: "How about 3pm?" },
    { role: "assistant", content: "Sounds good. See you then." },
  ],
  5,
);
const m2 = buildSuggestionMessages(ctx, "Alice", "Bot", 5);
check("typical ctx → system + 6 history + final user = 8 messages", m2.length, 8);
check("typical ctx → system first", m2[0].role, "system");
check("typical ctx → history starts with user message", m2[1].role, "user");
check("typical ctx → last history is the most recent assistant", m2[m2.length - 2].role, "assistant");
check("typical ctx → last assistant content preserved", m2[m2.length - 2].content, "Sounds good. See you then.");
check("typical ctx → final user prompt last", m2[m2.length - 1].role, "user");
check("typical ctx → final prompt uses user name", m2[m2.length - 1].content.includes("Alice"), true);
check("typical ctx → final prompt names entity", m2[m2.length - 1].content.includes("Bot"), true);

// Special characters in user names shouldn't break the prompt
const m4 = buildSuggestionMessages([{ role: "user", content: "test" }, { role: "assistant", content: "ok" }], "O'Brien", "Bot", 5);
check("apostrophe in user name doesn't crash", m4[0].content.includes("O'Brien"), true);

// Default names when settings are empty
const m5 = buildSuggestionMessages([{ role: "user", content: "x" }, { role: "assistant", content: "y" }], "You", "Assistant", 5);
check("default user name 'You' surfaces in prompt", m5[0].content.includes("You"), true);
check("default entity name 'Assistant' surfaces in prompt", m5[0].content.includes("Assistant"), true);

// System prompt mentions contextCount dynamically
const m6 = buildSuggestionMessages([{ role: "user", content: "x" }, { role: "assistant", content: "y" }], "Alice", "Bot", 3);
check("contextCount=3 surfaces in prompt", m6[0].content.includes("last 3"), true);

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