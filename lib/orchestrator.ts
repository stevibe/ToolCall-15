import {
  type ModelScenarioResult,
  type ScenarioDefinition,
  type ScenarioState,
  SCENARIOS,
  scoreModelResults
} from "@/lib/benchmark";
import { callModel, createInitialMessages, warmupModel, type GenerationParams, type ModelMessage, type ProviderToolCall } from "@/lib/llm-client";
import type { ModelConfig } from "@/lib/models";

export type RunEvent =
  | {
      type: "run_started";
      models: Array<{ id: string; label: string }>;
      totalScenarios: number;
    }
  | {
      type: "model_warmup";
      modelId: string;
      message: string;
    }
  | {
      type: "scenario_started";
      scenarioId: string;
      title: string;
      index: number;
      total: number;
    }
  | {
      type: "model_progress";
      modelId: string;
      scenarioId: string;
      message: string;
    }
  | {
      type: "scenario_result";
      modelId: string;
      scenarioId: string;
      result: ModelScenarioResult;
    }
  | {
      type: "scenario_finished";
      scenarioId: string;
    }
  | {
      type: "run_finished";
      scores: Record<string, ReturnType<typeof scoreModelResults>>;
    }
  | {
      type: "run_error";
      message: string;
    };

type Emit = (event: RunEvent) => Promise<void> | void;
const PROVIDER_ERROR_RETRY_PATTERN = /provider returned error/i;
const MAX_PROVIDER_ERROR_ATTEMPTS = 3;

function resolveScenarios(requestedScenarioIds?: string[]): ScenarioDefinition[] {
  if (!requestedScenarioIds || requestedScenarioIds.length === 0) {
    return SCENARIOS;
  }

  const requested = new Set(requestedScenarioIds);
  const selected = SCENARIOS.filter((scenario) => requested.has(scenario.id));

  if (selected.length !== requested.size) {
    const found = new Set(selected.map((scenario) => scenario.id));
    const missing = requestedScenarioIds.filter((scenarioId) => !found.has(scenarioId));
    throw new Error(`Unknown scenario id${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }

  return selected;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseToolArguments(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyToolResult(result: unknown): string {
  return JSON.stringify(result);
}

function toAssistantMessage(response: { content: string; toolCalls: ProviderToolCall[] }): ModelMessage {
  return {
    role: "assistant",
    content: response.content,
    tool_calls: response.toolCalls
  };
}

function formatScenarioTrace(
  model: ModelConfig,
  scenario: ScenarioDefinition,
  evaluation: { status: string; summary: string; note?: string },
  traceLines: string[]
): string {
  return [
    `model=${model.model}`,
    `scenario=${scenario.id} ${scenario.title}`,
    `prompt=${scenario.userMessage}`,
    "",
    ...traceLines,
    "",
    `verdict=${evaluation.status}`,
    `summary=${evaluation.summary}`,
    evaluation.note ? `note=${evaluation.note}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function runScenarioForModel(
  model: ModelConfig,
  scenario: ScenarioDefinition,
  emit: Emit,
  params?: GenerationParams
): Promise<ModelScenarioResult> {
  const state: ScenarioState = {
    toolCalls: [],
    toolResults: [],
    assistantMessages: [],
    finalAnswer: "",
    meta: {}
  };
  const messages = createInitialMessages(scenario.userMessage);
  const maxTurns = 8;
  const traceLines = ["assistant=starting"];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let turnCount = 0;
  const startTime = performance.now();

  await emit({
    type: "model_progress",
    modelId: model.id,
    scenarioId: scenario.id,
    message: "Calling model"
  });

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      let response: Awaited<ReturnType<typeof callModel>> | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= MAX_PROVIDER_ERROR_ATTEMPTS; attempt += 1) {
        try {
          response = await callModel(model, messages, params);
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Unknown model execution error.");

          if (!PROVIDER_ERROR_RETRY_PATTERN.test(lastError.message) || attempt === MAX_PROVIDER_ERROR_ATTEMPTS) {
            throw lastError;
          }

          traceLines.push(`retry_attempt_${attempt}=${lastError.message}`);
          await emit({
            type: "model_progress",
            modelId: model.id,
            scenarioId: scenario.id,
            message: `Provider returned error, retrying (${attempt + 1}/${MAX_PROVIDER_ERROR_ATTEMPTS})`
          });
          await sleep(750 * attempt);
        }
      }

      if (!response) {
        throw lastError ?? new Error("Unknown model execution error.");
      }

      turnCount = turn;
      totalPromptTokens += response.usage.promptTokens;
      totalCompletionTokens += response.usage.completionTokens;
      state.assistantMessages.push(response.content);
      messages.push(toAssistantMessage(response));
      traceLines.push(`assistant_turn_${turn}=${response.content || "[tool_calls_only]"}`);

      if (response.toolCalls.length === 0) {
        state.finalAnswer = response.content;
        break;
      }

      await emit({
        type: "model_progress",
        modelId: model.id,
        scenarioId: scenario.id,
        message: `Requested ${response.toolCalls.map((call) => call.function.name).join(", ")}`
      });

      for (const toolCall of response.toolCalls) {
        const record = {
          id: toolCall.id,
          name: toolCall.function.name,
          rawArguments: toolCall.function.arguments,
          arguments: parseToolArguments(toolCall.function.arguments),
          turn
        };

        state.toolCalls.push(record);
        traceLines.push(`tool_call=${record.name} ${record.rawArguments}`);

        const result = await scenario.handleToolCall(state, record);

        state.toolResults.push({
          callId: record.id,
          name: record.name,
          result
        });
        traceLines.push(`tool_result=${JSON.stringify(result)}`);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: stringifyToolResult(result)
        });
      }
    }
  } catch (error) {
    const durationMs = performance.now() - startTime;
    const summary = error instanceof Error ? error.message : "Unknown model execution error.";
    traceLines.push(`error=${summary}`);

    return {
      scenarioId: scenario.id,
      status: "fail",
      points: 0,
      summary,
      rawLog: formatScenarioTrace(model, scenario, { status: "fail", summary }, traceLines),
      metrics: { durationMs, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, turns: turnCount, toolCallCount: state.toolCalls.length }
    };
  }

  if (!state.finalAnswer) {
    state.finalAnswer = state.assistantMessages.at(-1) ?? "Model did not return a final answer.";
  }

  traceLines.push(`final_answer=${state.finalAnswer}`);

  const evaluation = scenario.evaluate(state);

  const durationMs = performance.now() - startTime;

  return {
    scenarioId: scenario.id,
    status: evaluation.status,
    points: evaluation.points,
    summary: evaluation.summary,
    note: evaluation.note,
    rawLog: formatScenarioTrace(model, scenario, evaluation, traceLines),
    metrics: { durationMs, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, turns: turnCount, toolCallCount: state.toolCalls.length }
  };
}

function isWarmupEnabled(): boolean {
  return process.env.WARMUP_ENABLED?.trim().toLowerCase() === "true";
}

function isModelFirstOrder(): boolean {
  return process.env.RUN_ORDER?.trim().toLowerCase() === "model";
}

async function doWarmup(model: ModelConfig, emit: Emit): Promise<void> {
  await emit({ type: "model_warmup", modelId: model.id, message: `Warming up ${model.model} (loading into GPU)…` });
  await warmupModel(model);
  await emit({ type: "model_warmup", modelId: model.id, message: `${model.model} ready.` });
}

async function runByScenario(
  models: ModelConfig[],
  scenarios: ScenarioDefinition[],
  resultsByModel: Record<string, ModelScenarioResult[]>,
  emit: Emit,
  params?: GenerationParams
): Promise<void> {
  const cloudModels = models.filter((model) => model.provider === "openrouter");
  const localModels = models.filter((model) => model.provider !== "openrouter");
  const shouldWarmup = isWarmupEnabled();

  const runScenario = async (model: ModelConfig, scenario: ScenarioDefinition) => {
    const result = await runScenarioForModel(model, scenario, emit, params);
    return { modelId: model.id, scenarioId: scenario.id, result };
  };

  const emitResult = async (modelId: string, scenarioId: string, result: ModelScenarioResult) => {
    resultsByModel[modelId].push(result);
    await emit({ type: "scenario_result", modelId, scenarioId, result });
  };

  if (shouldWarmup) {
    for (const model of localModels) {
      await doWarmup(model, emit);
    }
  }

  for (const [index, scenario] of scenarios.entries()) {
    await emit({
      type: "scenario_started",
      scenarioId: scenario.id,
      title: scenario.title,
      index: index + 1,
      total: scenarios.length
    });

    const promises: Promise<void>[] = [];

    if (cloudModels.length > 0) {
      promises.push(
        (async () => {
          const results = await Promise.all(cloudModels.map((model) => runScenario(model, scenario)));
          for (const { modelId, scenarioId, result } of results) {
            await emitResult(modelId, scenarioId, result);
          }
        })()
      );
    }

    promises.push(
      (async () => {
        for (const model of localModels) {
          const { modelId, scenarioId, result } = await runScenario(model, scenario);
          await emitResult(modelId, scenarioId, result);
        }
      })()
    );

    await Promise.all(promises);

    await emit({
      type: "scenario_finished",
      scenarioId: scenario.id
    });
  }
}

async function runByModel(
  models: ModelConfig[],
  scenarios: ScenarioDefinition[],
  resultsByModel: Record<string, ModelScenarioResult[]>,
  emit: Emit,
  params?: GenerationParams
): Promise<void> {
  const shouldWarmup = isWarmupEnabled();

  const emitResult = async (modelId: string, scenarioId: string, result: ModelScenarioResult) => {
    resultsByModel[modelId].push(result);
    await emit({ type: "scenario_result", modelId, scenarioId, result });
  };

  for (const model of models) {
    if (shouldWarmup && model.provider !== "openrouter") {
      await doWarmup(model, emit);
    }

    for (const [index, scenario] of scenarios.entries()) {
      await emit({
        type: "scenario_started",
        scenarioId: scenario.id,
        title: scenario.title,
        index: index + 1,
        total: scenarios.length
      });

      const result = await runScenarioForModel(model, scenario, emit, params);
      await emitResult(model.id, scenario.id, result);

      await emit({
        type: "scenario_finished",
        scenarioId: scenario.id
      });
    }
  }
}

export async function runBenchmark(models: ModelConfig[], emit: Emit, requestedScenarioIds?: string[], params?: GenerationParams): Promise<void> {
  const scenarios = resolveScenarios(requestedScenarioIds);
  const resultsByModel: Record<string, ModelScenarioResult[]> = Object.fromEntries(
    models.map((model) => [model.id, [] as ModelScenarioResult[]])
  );

  await emit({
    type: "run_started",
    models: models.map((model) => ({ id: model.id, label: model.label })),
    totalScenarios: scenarios.length
  });

  try {
    if (isModelFirstOrder()) {
      await runByModel(models, scenarios, resultsByModel, emit, params);
    } else {
      await runByScenario(models, scenarios, resultsByModel, emit, params);
    }

    const scores = Object.fromEntries(
      Object.entries(resultsByModel).map(([modelId, results]) => [modelId, scoreModelResults(results)])
    );

    await emit({
      type: "run_finished",
      scores
    });
  } catch (error) {
    await emit({
      type: "run_error",
      message: error instanceof Error ? error.message : "Unknown benchmark error."
    });
  }
}
