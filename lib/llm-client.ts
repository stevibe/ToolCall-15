import { SYSTEM_PROMPT, UNIVERSAL_TOOLS } from "@/lib/benchmark";
import type { ModelConfig } from "@/lib/models";

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
};

export type ProviderToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type AssistantResponse = {
  content: string;
  toolCalls: ProviderToolCall[];
};

export type GenerationParams = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
};

const DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS = 30;

type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string | Record<string, unknown>;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type ProviderMessage = NonNullable<NonNullable<ChatResponse["choices"]>[number]["message"]>;
type ProviderContent = ProviderMessage["content"];

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeContent(content: ProviderContent): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" ? part.text ?? "" : ""))
      .join("")
      .trim();
  }

  return "";
}

function normalizeToolCalls(message: ProviderMessage): ProviderToolCall[] {
  return (
    message?.tool_calls?.map((call: NonNullable<ProviderMessage["tool_calls"]>[number], index: number) => ({
      id: call.id ?? `tool_call_${index + 1}`,
      type: "function",
      function: {
        name: call.function?.name ?? "unknown_tool",
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {})
      }
    })) ?? []
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError";
}

function resolveRequestTimeoutMs(): number {
  const rawTimeout = process.env.MODEL_REQUEST_TIMEOUT_SECONDS?.trim();

  if (!rawTimeout) {
    return DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS * 1000;
  }

  const parsed = Number.parseInt(rawTimeout, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS * 1000;
  }

  return parsed * 1000;
}

export async function callModel(model: ModelConfig, messages: ModelMessage[], params?: GenerationParams): Promise<AssistantResponse> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const requestTimeoutMs = resolveRequestTimeoutMs();
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (model.apiKey) {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: model.model,
    temperature: params?.temperature ?? 0,
    parallel_tool_calls: true,
    tool_choice: "auto",
    messages,
    tools: UNIVERSAL_TOOLS
  };

  if (params?.top_p !== undefined) {
    body.top_p = params.top_p;
  }

  if (params?.top_k !== undefined) {
    body.top_k = params.top_k;
  }

  if (params?.min_p !== undefined) {
    body.min_p = params.min_p;
  }

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`Request timed out after ${requestTimeoutMs / 1000}s.`);
    }

    throw error;
  }

  const payload = (await response.json()) as ChatResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message || `Provider request failed with ${response.status}.`);
  }

  const message = payload.choices?.[0]?.message;

  if (!message) {
    throw new Error("Provider returned no assistant message.");
  }

  return {
    content: normalizeContent(message.content),
    toolCalls: normalizeToolCalls(message)
  };
}

const WARMUP_TIMEOUT_MS = 120_000;

export async function warmupModel(model: ModelConfig): Promise<void> {
  const baseUrl = normalizeBaseUrl(model.baseUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (model.apiKey) {
    headers.Authorization = `Bearer ${model.apiKey}`;
  }

  const body = {
    model: model.model,
    temperature: 0,
    max_tokens: 1,
    messages: [{ role: "user", content: "Hi" }]
  };

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS)
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as ChatResponse;
      throw new Error(payload.error?.message || `Warmup failed with ${response.status}.`);
    }

    await response.json();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`Warmup timed out after ${WARMUP_TIMEOUT_MS / 1000}s — model may be too large for available GPU memory.`);
    }

    throw error;
  }
}

export function createInitialMessages(userMessage: string): ModelMessage[] {
  return [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nBenchmark context: today is 2026-03-20 (Friday). Use this date for any relative time request.` },
    { role: "user", content: userMessage }
  ];
}
