export const SYSTEM_PROMPT = `You are a helpful assistant with access to the tools provided.

Rules:
- Use a tool ONLY when it is necessary to fulfill the user's request.
- If you can answer directly from your own knowledge, do so without calling a tool.
- If a tool call fails, explain the failure and suggest an alternative approach.
- Never invent information that a tool should provide.`;

export const BENCHMARK_REFERENCE_DATE = "2026-03-20";
export const BENCHMARK_REFERENCE_DAY = "Friday";

export type BenchmarkCategory = "A" | "B" | "C" | "D" | "E";
export type ScenarioStatus = "pass" | "partial" | "fail";
export type UniversalToolName =
  | "web_search"
  | "get_weather"
  | "calculator"
  | "send_email"
  | "search_files"
  | "read_file"
  | "create_calendar_event"
  | "get_contacts"
  | "translate_text"
  | "get_stock_price"
  | "set_reminder"
  | "run_code";

export type ToolDefinition = {
  type: "function";
  function: {
    name: UniversalToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
};

export type ToolCallRecord = {
  id: string;
  name: string;
  rawArguments: string;
  arguments: Record<string, unknown>;
  turn: number;
};

export type ToolResultRecord = {
  callId: string;
  name: string;
  result: unknown;
};

export type ScenarioState = {
  toolCalls: ToolCallRecord[];
  toolResults: ToolResultRecord[];
  assistantMessages: string[];
  finalAnswer: string;
  meta: Record<string, unknown>;
};

export type ScenarioEvaluation = {
  status: ScenarioStatus;
  points: 0 | 1 | 2;
  summary: string;
  note?: string;
};

export type ScenarioDefinition = {
  id: string;
  title: string;
  category: BenchmarkCategory;
  userMessage: string;
  description: string;
  handleToolCall: (state: ScenarioState, call: ToolCallRecord) => Promise<unknown> | unknown;
  evaluate: (state: ScenarioState) => ScenarioEvaluation;
};

function parseMathExpression(expression: string): number | null {
  const sanitized = expression.replaceAll(",", "").trim();

  if (!/^[\d\s()+\-*/.%]+$/.test(sanitized)) {
    return null;
  }

  try {
    const result = Function(`"use strict"; return (${sanitized});`)();
    return typeof result === "number" && Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function includesText(value: unknown, expected: string): boolean {
  return asString(value).toLowerCase().includes(expected.toLowerCase());
}

function mentionsAll(text: string, values: string[]): boolean {
  const normalizedText = normalize(text);
  return values.every((value) => normalizedText.includes(normalize(value)));
}

function answerContainsNumber(answer: string, value: string): boolean {
  const collapsed = answer.replaceAll(",", "").toLowerCase();
  return collapsed.includes(value.replaceAll(",", "").toLowerCase());
}

function toolCallsByName(state: ScenarioState, name: string): ToolCallRecord[] {
  return state.toolCalls.filter((call) => call.name === name);
}

function hasToolCall(state: ScenarioState, name: string, predicate?: (call: ToolCallRecord) => boolean): boolean {
  return toolCallsByName(state, name).some((call) => (predicate ? predicate(call) : true));
}

function firstCall(state: ScenarioState, name: string): ToolCallRecord | undefined {
  return toolCallsByName(state, name)[0];
}

function isOnlyTool(state: ScenarioState, name: string): boolean {
  return state.toolCalls.length > 0 && state.toolCalls.every((call) => call.name === name);
}

function containsRefusal(answer: string): boolean {
  const lowered = answer.toLowerCase();
  return (
    lowered.includes("cannot") ||
    lowered.includes("can't") ||
    lowered.includes("do not have") ||
    lowered.includes("don't have") ||
    lowered.includes("not able")
  );
}

function asksForClarification(answer: string): boolean {
  const lowered = answer.toLowerCase();
  return lowered.includes("which") || lowered.includes("clarify") || lowered.includes("could you");
}

function hasCurrentToolMisuse(state: ScenarioState, allowedTools: string[]): boolean {
  return state.toolCalls.some((call) => !allowedTools.includes(call.name));
}

export const UNIVERSAL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", default: 5 }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather for a specific location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string" },
          units: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" }
        },
        required: ["location"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Perform mathematical calculations",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string" }
        },
        required: ["expression"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email to a recipient",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          attachments: { type: "array", items: { type: "string" }, default: [] }
        },
        required: ["to", "subject", "body"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files by name or content",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          file_type: { type: "string", enum: ["pdf", "docx", "xlsx", "any"], default: "any" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a specific file",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "string" }
        },
        required: ["file_id"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create a new calendar event",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string", format: "YYYY-MM-DD" },
          time: { type: "string", format: "HH:MM" },
          duration_minutes: { type: "integer", default: 60 },
          attendees: { type: "array", items: { type: "string" }, default: [] }
        },
        required: ["title", "date", "time"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_contacts",
      description: "Look up contacts by name or group",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "translate_text",
      description: "Translate text from one language to another",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          source_language: { type: "string" },
          target_language: { type: "string" }
        },
        required: ["text", "source_language", "target_language"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description: "Get the current stock price for a ticker symbol",
      parameters: {
        type: "object",
        properties: {
          ticker: { type: "string" }
        },
        required: ["ticker"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Set a reminder for a future time",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          datetime: { type: "string", format: "ISO 8601" }
        },
        required: ["message", "datetime"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description: "Execute a code snippet and return the output",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["python", "javascript"] },
          code: { type: "string" }
        },
        required: ["language", "code"],
        additionalProperties: false
      }
    }
  }
];

function genericToolFallback(call: ToolCallRecord): unknown {
  switch (call.name) {
    case "calculator": {
      const result = parseMathExpression(asString(call.arguments.expression));
      return result === null ? { error: "Invalid expression." } : { result };
    }
    case "web_search":
      return { results: [{ snippet: `Search results for ${asString(call.arguments.query)}` }] };
    case "run_code":
      return { error: "Code execution is disabled in benchmark mocks." };
    default:
      return { error: `Tool ${call.name} is not relevant for this scenario.` };
  }
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: "TC-01",
    title: "Direct Specialist Match",
    category: "A",
    userMessage: "What's the weather like in Berlin right now?",
    description: "Use get_weather instead of falling back to web_search.",
    handleToolCall(_state, call) {
      if (call.name === "get_weather") {
        return {
          location: "Berlin",
          temperature: 8,
          units: "celsius",
          condition: "Overcast",
          humidity: 72
        };
      }

      if (call.name === "web_search") {
        return {
          results: [{ snippet: "Berlin weather right now: 8C and overcast." }]
        };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const usedWeather = hasToolCall(state, "get_weather", (call) => includesText(call.arguments.location, "berlin"));
      const usedWeb = hasToolCall(state, "web_search");

      if (usedWeather && !usedWeb && state.toolCalls.length === 1) {
        return { status: "pass", points: 2, summary: "Used get_weather with Berlin only." };
      }

      if (!usedWeather && usedWeb && isOnlyTool(state, "web_search")) {
        return { status: "partial", points: 1, summary: "Answered functionally via web_search, but missed the specialist tool." };
      }

      return { status: "fail", points: 0, summary: "Did not cleanly route the request to get_weather." };
    }
  },
  {
    id: "TC-02",
    title: "Distractor Resistance",
    category: "A",
    userMessage: "What is the current price of AAPL stock?",
    description: "Use get_stock_price without extra tools.",
    handleToolCall(_state, call) {
      if (call.name === "get_stock_price") {
        return {
          ticker: "AAPL",
          price: 187.42,
          currency: "USD",
          change: "+1.23",
          change_percent: "+0.66%"
        };
      }

      if (call.name === "web_search") {
        return { results: [{ snippet: "AAPL is trading around $187.42." }] };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const stockCall = hasToolCall(state, "get_stock_price", (call) => normalize(asString(call.arguments.ticker)) === "aapl");
      const webCall = hasToolCall(state, "web_search");

      if (stockCall && !webCall && state.toolCalls.length === 1) {
        return { status: "pass", points: 2, summary: "Used only get_stock_price for AAPL." };
      }

      if (stockCall && webCall) {
        return { status: "partial", points: 1, summary: "Called the right tool, but added unnecessary web_search." };
      }

      return { status: "fail", points: 0, summary: "Did not isolate the request to get_stock_price." };
    }
  },
  {
    id: "TC-03",
    title: "Implicit Tool Need",
    category: "A",
    userMessage: "I need to let Sarah know the meeting moved to 3pm.",
    description: "Infer get_contacts followed by send_email.",
    handleToolCall(_state, call) {
      if (call.name === "get_contacts") {
        return {
          results: [{ name: "Sarah Chen", email: "sarah.chen@company.com" }]
        };
      }

      if (call.name === "send_email") {
        return { status: "sent", message_id: "msg_8821" };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const contactCall = firstCall(state, "get_contacts");
      const emailCall = firstCall(state, "send_email");

      if (
        contactCall &&
        emailCall &&
        contactCall.turn < emailCall.turn &&
        includesText(contactCall.arguments.query, "sarah") &&
        normalize(asString(emailCall.arguments.to)) === "sarah.chen@company.com"
      ) {
        return { status: "pass", points: 2, summary: "Looked up Sarah before sending the email." };
      }

      if (!contactCall && !emailCall && /email/i.test(state.finalAnswer) && /\?/.test(state.finalAnswer)) {
        return { status: "partial", points: 1, summary: "Asked for Sarah's email instead of inferring the tool chain." };
      }

      return { status: "fail", points: 0, summary: "Did not complete the contact lookup to email chain correctly." };
    }
  },
  {
    id: "TC-04",
    title: "Unit Handling",
    category: "B",
    userMessage: "What's the temperature in Tokyo in Fahrenheit?",
    description: "Pass the requested units parameter instead of ignoring it.",
    handleToolCall(_state, call) {
      if (call.name === "get_weather") {
        const units = normalize(asString(call.arguments.units)) || "celsius";

        if (units === "fahrenheit") {
          return { location: "Tokyo", temperature: 64, units: "fahrenheit", condition: "Clear" };
        }

        return { location: "Tokyo", temperature: 18, units: "celsius", condition: "Clear" };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const weatherCall = firstCall(state, "get_weather");

      if (
        weatherCall &&
        includesText(weatherCall.arguments.location, "tokyo") &&
        normalize(asString(weatherCall.arguments.units)) === "fahrenheit"
      ) {
        return { status: "pass", points: 2, summary: "Requested Tokyo weather in Fahrenheit explicitly." };
      }

      if (
        weatherCall &&
        includesText(weatherCall.arguments.location, "tokyo") &&
        !asString(weatherCall.arguments.units) &&
        (state.finalAnswer.toLowerCase().includes("fahrenheit") || answerContainsNumber(state.finalAnswer, "64"))
      ) {
        return { status: "partial", points: 1, summary: "Omitted the units parameter and converted manually." };
      }

      return { status: "fail", points: 0, summary: "Did not preserve the Fahrenheit instruction." };
    }
  },
  {
    id: "TC-05",
    title: "Date and Time Parsing",
    category: "B",
    userMessage: "Schedule a team standup for next Monday at 9:30am, 30 minutes, with Alex and Jamie.",
    description: "Parse relative date and structured event parameters correctly.",
    handleToolCall(_state, call) {
      if (call.name === "get_contacts") {
        return {
          results: [
            { name: "Alex Stone", email: "alex.stone@company.com" },
            { name: "Jamie Liu", email: "jamie.liu@company.com" }
          ]
        };
      }

      if (call.name === "create_calendar_event") {
        return {
          event_id: "evt_4412",
          status: "created",
          title: asString(call.arguments.title) || "Team Standup",
          date: asString(call.arguments.date)
        };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const eventCall = firstCall(state, "create_calendar_event");

      if (!eventCall) {
        return { status: "fail", points: 0, summary: "Did not create the calendar event." };
      }

      const attendees = asStringArray(eventCall.arguments.attendees);
      const hasDuration = Number(eventCall.arguments.duration_minutes) === 30;
      const hasAttendees = attendees.some((value) => includesText(value, "alex")) && attendees.some((value) => includesText(value, "jamie"));
      const correctDate = asString(eventCall.arguments.date) === "2026-03-23";
      const correctTime = asString(eventCall.arguments.time) === "09:30";

      if (correctDate && correctTime && hasDuration && hasAttendees) {
        return { status: "pass", points: 2, summary: "Parsed next Monday and included the requested meeting details." };
      }

      if (correctDate && correctTime) {
        return { status: "partial", points: 1, summary: "Got the date and time right, but missed some optional structure." };
      }

      return { status: "fail", points: 0, summary: "Relative date or time parsing was incorrect." };
    }
  },
  {
    id: "TC-06",
    title: "Multi-Value Extraction",
    category: "B",
    userMessage: "Translate 'Where is the nearest hospital?' from English to both Spanish and Japanese.",
    description: "Split a one-to-many translation request into two tool calls.",
    handleToolCall(_state, call) {
      if (call.name === "translate_text") {
        const target = normalize(asString(call.arguments.target_language));

        if (target === "spanish") {
          return { translated: "¿Dónde está el hospital más cercano?" };
        }

        if (target === "japanese") {
          return { translated: "最寄りの病院はどこですか？" };
        }

        return { error: `Unsupported target language ${target}.` };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const translateCalls = toolCallsByName(state, "translate_text");
      const hasSpanish = translateCalls.some(
        (call) =>
          normalize(asString(call.arguments.source_language)) === "english" &&
          normalize(asString(call.arguments.target_language)) === "spanish" &&
          asString(call.arguments.text) === "Where is the nearest hospital?"
      );
      const hasJapanese = translateCalls.some(
        (call) =>
          normalize(asString(call.arguments.source_language)) === "english" &&
          normalize(asString(call.arguments.target_language)) === "japanese" &&
          asString(call.arguments.text) === "Where is the nearest hospital?"
      );
      const invalidBundledTarget = translateCalls.some((call) =>
        /spanish.*japanese|japanese.*spanish/i.test(asString(call.arguments.target_language))
      );

      if (translateCalls.length >= 2 && hasSpanish && hasJapanese && !invalidBundledTarget) {
        return { status: "pass", points: 2, summary: "Issued separate translate_text calls for both languages." };
      }

      return { status: "fail", points: 0, summary: "Did not split the translation request into two valid tool calls." };
    }
  },
  {
    id: "TC-07",
    title: "Search → Read → Act",
    category: "C",
    userMessage: "Find the Q3 budget report and email the total to my manager.",
    description: "Thread file search, file read, contact lookup, and send_email end to end.",
    handleToolCall(_state, call) {
      if (call.name === "search_files") {
        return {
          results: [{ file_id: "file_091", name: "Q3_Budget_Report_2025.xlsx" }]
        };
      }

      if (call.name === "read_file") {
        return {
          content: "Department budgets: Engineering $2.1M, Marketing $800K, Sales $1.5M. Total: $4.4M"
        };
      }

      if (call.name === "get_contacts") {
        return {
          results: [{ name: "Jordan Park", email: "jordan.park@company.com", role: "manager" }]
        };
      }

      if (call.name === "send_email") {
        return { status: "sent" };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      let completedSteps = 0;

      if (hasToolCall(state, "search_files", (call) => includesText(call.arguments.query, "q3 budget report"))) {
        completedSteps += 1;
      }

      if (hasToolCall(state, "read_file", (call) => normalize(asString(call.arguments.file_id)) === "file_091")) {
        completedSteps += 1;
      }

      if (hasToolCall(state, "get_contacts", (call) => includesText(call.arguments.query, "manager"))) {
        completedSteps += 1;
      }

      if (
        hasToolCall(
          state,
          "send_email",
          (call) =>
            normalize(asString(call.arguments.to)) === "jordan.park@company.com" &&
            (includesText(call.arguments.body, "4.4m") || includesText(call.arguments.body, "$4.4m"))
        )
      ) {
        completedSteps += 1;
      }

      if (completedSteps === 4) {
        return { status: "pass", points: 2, summary: "Completed the full four-step chain with the right data." };
      }

      if (completedSteps >= 3) {
        return { status: "partial", points: 1, summary: "Completed most of the chain, but missed one dependent step." };
      }

      return { status: "fail", points: 0, summary: "Did not carry the file and contact data across the chain correctly." };
    }
  },
  {
    id: "TC-08",
    title: "Conditional Branching",
    category: "C",
    userMessage: "Check the weather in Paris. If it's raining, remind me to bring an umbrella tomorrow at 8am.",
    description: "Branch off the weather result instead of setting the reminder blindly.",
    handleToolCall(_state, call) {
      if (call.name === "get_weather") {
        return { location: "Paris", temperature: 11, condition: "Light rain", humidity: 89 };
      }

      if (call.name === "set_reminder") {
        return { reminder_id: "rem_553", status: "set" };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const weatherCall = firstCall(state, "get_weather");
      const reminderCall = firstCall(state, "set_reminder");

      if (
        weatherCall &&
        reminderCall &&
        weatherCall.turn < reminderCall.turn &&
        includesText(reminderCall.arguments.message, "umbrella") &&
        asString(reminderCall.arguments.datetime).startsWith("2026-03-21T08:00:00")
      ) {
        return { status: "pass", points: 2, summary: "Checked the weather first, then set the rainy-day reminder." };
      }

      if (weatherCall && !reminderCall && asksForClarification(state.finalAnswer)) {
        return { status: "partial", points: 1, summary: "Read the weather correctly, but stopped short of setting the reminder." };
      }

      return { status: "fail", points: 0, summary: "Did not respect the weather-first conditional flow." };
    }
  },
  {
    id: "TC-09",
    title: "Parallel Independence",
    category: "C",
    userMessage: "What's the weather in London and the stock price of MSFT?",
    description: "Handle two independent requests without missing either one.",
    handleToolCall(_state, call) {
      if (call.name === "get_weather") {
        return { location: "London", temperature: 12, condition: "Cloudy" };
      }

      if (call.name === "get_stock_price") {
        return { ticker: "MSFT", price: 412.78, currency: "USD" };
      }

      if (call.name === "web_search") {
        return { results: [{ snippet: "London is cloudy at 12C and MSFT is around $412.78." }] };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const weatherCall = hasToolCall(state, "get_weather", (call) => includesText(call.arguments.location, "london"));
      const stockCall = hasToolCall(state, "get_stock_price", (call) => normalize(asString(call.arguments.ticker)) === "msft");
      const firstAssistantBatch = state.toolCalls.filter((call) => call.turn === 1);
      const parallel = firstAssistantBatch.some((call) => call.name === "get_weather") &&
        firstAssistantBatch.some((call) => call.name === "get_stock_price");

      if (weatherCall && stockCall) {
        return {
          status: "pass",
          points: 2,
          summary: "Handled both independent tasks.",
          note: parallel ? "Both tools were called in the same assistant turn." : undefined
        };
      }

      if (hasToolCall(state, "web_search")) {
        return { status: "partial", points: 1, summary: "Covered the request, but fell back to web_search." };
      }

      return { status: "fail", points: 0, summary: "Missed one side of the two-part request." };
    }
  },
  {
    id: "TC-10",
    title: "Trivial Knowledge",
    category: "D",
    userMessage: "What year did World War II end?",
    description: "Avoid tools for basic knowledge.",
    handleToolCall(_state, call) {
      return genericToolFallback(call);
    },
    evaluate(state) {
      if (state.toolCalls.length === 0 && answerContainsNumber(state.finalAnswer, "1945")) {
        return { status: "pass", points: 2, summary: "Answered directly without tool use." };
      }

      return { status: "fail", points: 0, summary: "Used tools or missed the basic fact." };
    }
  },
  {
    id: "TC-11",
    title: "Simple Math",
    category: "D",
    userMessage: "What is 15% of 200?",
    description: "Avoid calculator for easy arithmetic.",
    handleToolCall(_state, call) {
      return genericToolFallback(call);
    },
    evaluate(state) {
      const correctAnswer = answerContainsNumber(state.finalAnswer, "30");

      if (state.toolCalls.length === 0 && correctAnswer) {
        return { status: "pass", points: 2, summary: "Did the math directly." };
      }

      if (hasToolCall(state, "calculator") && correctAnswer && !hasToolCall(state, "web_search")) {
        return { status: "partial", points: 1, summary: "Used calculator correctly, but unnecessarily." };
      }

      return { status: "fail", points: 0, summary: "Failed the easy-arithmetic restraint test." };
    }
  },
  {
    id: "TC-12",
    title: "Impossible Request",
    category: "D",
    userMessage: "Delete all my emails from last month.",
    description: "Refuse cleanly when no suitable tool exists.",
    handleToolCall(_state, call) {
      return genericToolFallback(call);
    },
    evaluate(state) {
      if (
        state.toolCalls.length === 0 &&
        containsRefusal(state.finalAnswer) &&
        (/delete/i.test(state.finalAnswer) || /available tool/i.test(state.finalAnswer))
      ) {
        return { status: "pass", points: 2, summary: "Refused cleanly because no delete-email tool exists." };
      }

      return { status: "fail", points: 0, summary: "Did not refuse the unsupported email-deletion request correctly." };
    }
  },
  {
    id: "TC-13",
    title: "Empty Results",
    category: "E",
    userMessage: "Find the Johnson proposal document.",
    description: "Retry or ask for clarification when the first search returns nothing.",
    handleToolCall(state, call) {
      if (call.name === "search_files") {
        const query = normalize(asString(call.arguments.query));
        const attempts = Number(state.meta.searchAttempts ?? 0) + 1;
        state.meta.searchAttempts = attempts;

        if (query.includes("johnson proposal") && attempts === 1) {
          return { results: [] };
        }

        if (query.includes("johnson")) {
          return {
            results: [{ file_id: "file_117", name: "Johnson_Project_Proposal_v2.docx" }]
          };
        }
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const searches = toolCallsByName(state, "search_files");
      const retried = searches.length >= 2;
      const clarified = searches.length === 1 && asksForClarification(state.finalAnswer);

      if (retried) {
        return { status: "pass", points: 2, summary: "Retried after the empty result and recovered." };
      }

      if (clarified) {
        return { status: "pass", points: 2, summary: "Asked for clarification after the empty result." };
      }

      return { status: "fail", points: 0, summary: "Did not adapt after the empty search response." };
    }
  },
  {
    id: "TC-14",
    title: "Malformed Response",
    category: "E",
    userMessage: "What's Apple's stock price?",
    description: "Surface tool errors instead of hallucinating a price.",
    handleToolCall(_state, call) {
      if (call.name === "get_stock_price") {
        return { error: "Service temporarily unavailable. Rate limit exceeded." };
      }

      if (call.name === "web_search") {
        return { results: [{ snippet: "Apple (AAPL) is trading around $187.42." }] };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const stockCalls = toolCallsByName(state, "get_stock_price");
      const usedSearch = hasToolCall(state, "web_search");
      const acknowledgedError =
        /temporarily unavailable|rate limit|service/i.test(state.finalAnswer) ||
        /couldn't|get_stock_price/i.test(state.finalAnswer);

      if (stockCalls.length >= 1 && acknowledgedError && (!usedSearch || /web search|try again|fallback/i.test(state.finalAnswer))) {
        return { status: "pass", points: 2, summary: "Acknowledged the stock tool failure and handled it gracefully." };
      }

      if (stockCalls.length >= 1 && usedSearch) {
        return { status: "partial", points: 1, summary: "Recovered with web_search, but did not clearly surface the original error." };
      }

      return { status: "fail", points: 0, summary: "Did not handle the tool error with enough integrity." };
    }
  },
  {
    id: "TC-15",
    title: "Conflicting Information",
    category: "E",
    userMessage: "Search for the population of Iceland and calculate what 2% of it would be.",
    description: "Carry the exact searched value into the calculator.",
    handleToolCall(_state, call) {
      if (call.name === "web_search") {
        return {
          results: [{ snippet: "Iceland has a population of approximately 372,520 as of 2025." }]
        };
      }

      if (call.name === "calculator") {
        const result = parseMathExpression(asString(call.arguments.expression));
        return result === null ? { error: "Invalid expression." } : { result };
      }

      return genericToolFallback(call);
    },
    evaluate(state) {
      const searchCall = firstCall(state, "web_search");
      const calculatorCall = firstCall(state, "calculator");

      if (
        searchCall &&
        calculatorCall &&
        includesText(searchCall.arguments.query, "population of iceland") &&
        asString(calculatorCall.arguments.expression).replaceAll(",", "").includes("372520")
      ) {
        return { status: "pass", points: 2, summary: "Used the searched population value in the calculator." };
      }

      if (!calculatorCall && searchCall && answerContainsNumber(state.finalAnswer, "7450.4")) {
        return { status: "partial", points: 1, summary: "Computed the right answer mentally after searching." };
      }

      return { status: "fail", points: 0, summary: "Did not preserve the exact searched value across tool calls." };
    }
  }
];

export const CATEGORY_LABELS: Record<BenchmarkCategory, string> = {
  A: "Tool Selection",
  B: "Parameter Precision",
  C: "Multi-Step Chains",
  D: "Restraint & Refusal",
  E: "Error Recovery"
};

export type ScenarioDisplayDetail = {
  successCase: string;
  failureCase: string;
};

export const SCENARIO_DISPLAY_DETAILS: Record<string, ScenarioDisplayDetail> = {
  "TC-01": {
    successCase: "Pass if it calls get_weather for Berlin and avoids web_search.",
    failureCase: "Fail if it searches the web, calls multiple tools, or answers from memory."
  },
  "TC-02": {
    successCase: "Pass if it uses only get_stock_price with ticker AAPL.",
    failureCase: "Fail if it uses distractor tools or answers without a stock lookup."
  },
  "TC-03": {
    successCase: "Pass if it looks up Sarah first, then sends the message with the resolved address.",
    failureCase: "Fail if it invents Sarah's email or never completes the contact-to-email chain."
  },
  "TC-04": {
    successCase: "Pass if it requests Tokyo weather with units set to fahrenheit.",
    failureCase: "Fail if it ignores the Fahrenheit instruction."
  },
  "TC-05": {
    successCase: "Pass if it creates the event for 2026-03-23 at 09:30 with 30 minutes and Alex plus Jamie.",
    failureCase: "Fail if it misparses next Monday or drops core event details."
  },
  "TC-06": {
    successCase: "Pass if it makes two translate_text calls, one for Spanish and one for Japanese.",
    failureCase: "Fail if it combines both languages into one call or only translates one of them."
  },
  "TC-07": {
    successCase: "Pass if it searches, reads, resolves the manager, and emails the real total.",
    failureCase: "Fail if it invents the total or the manager address."
  },
  "TC-08": {
    successCase: "Pass if it checks Paris weather first and only then sets the umbrella reminder.",
    failureCase: "Fail if it skips the weather lookup or ignores the condition."
  },
  "TC-09": {
    successCase: "Pass if it handles both London weather and MSFT price in the same response flow.",
    failureCase: "Fail if it misses one side of the request."
  },
  "TC-10": {
    successCase: "Pass if it answers 1945 directly with no tool call.",
    failureCase: "Fail if it uses any tool for basic history."
  },
  "TC-11": {
    successCase: "Pass if it answers 30 directly with no calculator.",
    failureCase: "Fail if it overuses tools for simple arithmetic."
  },
  "TC-12": {
    successCase: "Pass if it clearly refuses because no delete-email tool exists.",
    failureCase: "Fail if it hallucinates a delete action or misuses another tool."
  },
  "TC-13": {
    successCase: "Pass if it retries the search or asks for clarification after empty results.",
    failureCase: "Fail if it gives up or invents a file."
  },
  "TC-14": {
    successCase: "Pass if it surfaces the stock tool error and handles it honestly.",
    failureCase: "Fail if it hides the error and fabricates a price."
  },
  "TC-15": {
    successCase: "Pass if it searches first, then calculates 2% using the exact searched population value.",
    failureCase: "Fail if it skips the search or uses a memorized rounded number."
  }
};

export type ScenarioMetrics = {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  turns: number;
  toolCallCount: number;
};

export type ModelScenarioResult = {
  scenarioId: string;
  status: ScenarioStatus;
  points: 0 | 1 | 2;
  summary: string;
  note?: string;
  rawLog: string;
  metrics?: ScenarioMetrics;
};

export type CategoryScore = {
  category: BenchmarkCategory;
  label: string;
  earned: number;
  max: number;
  percent: number;
};

export type AggregateMetrics = {
  totalDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgDurationMs: number;
  tokensPerSecond: number;
};

export type ModelScoreSummary = {
  scenarioResults: ModelScenarioResult[];
  categoryScores: CategoryScore[];
  finalScore: number;
  totalPoints: number;
  maxPoints: number;
  rating: string;
  metrics: AggregateMetrics;
};

function ratingForScore(score: number): string {
  if (score >= 90) {
    return "★★★★★ Excellent";
  }

  if (score >= 75) {
    return "★★★★ Good";
  }

  if (score >= 60) {
    return "★★★ Adequate";
  }

  if (score >= 40) {
    return "★★ Weak";
  }

  return "★ Poor";
}

export function scoreModelResults(results: ModelScenarioResult[]): ModelScoreSummary {
  const categoryScores = (Object.keys(CATEGORY_LABELS) as BenchmarkCategory[]).map((category) => {
    const earned = results
      .filter((result) => SCENARIOS.find((scenario) => scenario.id === result.scenarioId)?.category === category)
      .reduce((sum, result) => sum + result.points, 0);

    return {
      category,
      label: CATEGORY_LABELS[category],
      earned,
      max: 6,
      percent: Math.round((earned / 6) * 100)
    };
  });

  const finalScore = Math.round(
    categoryScores.reduce((sum, categoryScore) => sum + categoryScore.percent, 0) / categoryScores.length
  );
  const totalPoints = results.reduce((sum, result) => sum + result.points, 0);

  const totalDurationMs = results.reduce((sum, r) => sum + (r.metrics?.durationMs ?? 0), 0);
  const totalPromptTokens = results.reduce((sum, r) => sum + (r.metrics?.promptTokens ?? 0), 0);
  const totalCompletionTokens = results.reduce((sum, r) => sum + (r.metrics?.completionTokens ?? 0), 0);
  const scenariosWithMetrics = results.filter((r) => r.metrics).length;
  const avgDurationMs = scenariosWithMetrics > 0 ? totalDurationMs / scenariosWithMetrics : 0;
  const tokensPerSecond = totalDurationMs > 0 ? (totalCompletionTokens / totalDurationMs) * 1000 : 0;

  return {
    scenarioResults: results,
    categoryScores,
    finalScore,
    totalPoints,
    maxPoints: SCENARIOS.length * 2,
    rating: ratingForScore(finalScore),
    metrics: {
      totalDurationMs,
      totalPromptTokens,
      totalCompletionTokens,
      avgDurationMs,
      tokensPerSecond
    }
  };
}
