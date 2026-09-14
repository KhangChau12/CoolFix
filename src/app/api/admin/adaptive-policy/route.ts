import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";
import {
  ADAPTIVE_COMPANY_ID,
  analyzeAdaptivePolicy,
  analyzeAndStoreAdaptivePolicy,
  applyAdaptiveRecommendation,
} from "@/lib/adaptivePolicy";

export const dynamic = "force-dynamic";

/** Adaptive policy is deliberately scoped to the demo company until the app
 * has authenticated company identity and tenant isolation. The browser never
 * supplies a company id for reads or writes. */
export async function GET() {
  try {
    const [config, jobs, feedback, recommendations, history] = await Promise.all([
      repo.getConfig(),
      repo.listJobs(),
      repo.listFeedback(),
      repo.listAdaptiveRecommendations(),
      repo.listAdaptiveHistory(),
    ]);
    const analysis = analyzeAdaptivePolicy(feedback, jobs, config);
    return NextResponse.json({
      companyId: ADAPTIVE_COMPANY_ID,
      demoScope: true,
      config,
      analyses: analysis.analyses,
      recommendations,
      history,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST() {
  try {
    const result = await analyzeAndStoreAdaptivePolicy();
    const applied: Awaited<ReturnType<typeof applyAdaptiveRecommendation>>[] = [];
    const config = await repo.getConfig();
    if (config.adaptivePolicy.enabled && config.adaptivePolicy.mode === "automatic") {
      for (const recommendation of result.recommendations) {
        try {
          applied.push(await applyAdaptiveRecommendation(recommendation.recommendation_id, "automatic adaptive policy", true));
        } catch {
          // A concurrent policy change or a safety check must not make the
          // whole analysis fail; the recommendation remains reviewable.
        }
      }
    }
    return NextResponse.json({
      companyId: ADAPTIVE_COMPANY_ID,
      demoScope: true,
      ...result,
      applied,
      config: await repo.getConfig(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Adaptive policy operation failed.";
  const status = /not found/i.test(message) ? 404 : /must|refused|changed|approved|enabled|insufficient/i.test(message) ? 409 : 500;
  return NextResponse.json({ error: message }, { status });
}
