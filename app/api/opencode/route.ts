import { SCENARIOS } from "@/lib/benchmark";
import { getModelConfigs } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format") ?? "json";
  const models = getModelConfigs();

  const data = {
    name: "ToolCall-15",
    description: "Visual benchmark for comparing LLM tool use",
    scenarioCount: SCENARIOS.length,
    models: models.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model
    })),
    categories: SCENARIOS.reduce<string[]>((acc, s) => {
      if (!acc.includes(s.category)) {
        acc.push(s.category);
      }
      return acc;
    }, [])
  };

  if (format === "text") {
    return new Response(
      `ToolCall-15 Benchmark\n` +
      `Scenarios: ${data.scenarioCount}\n` +
      `Models: ${models.length}\n` +
      `Categories: ${data.categories.join(", ")}`,
      { headers: { "Content-Type": "text/plain" } }
    );
  }

  return Response.json(data);
}
