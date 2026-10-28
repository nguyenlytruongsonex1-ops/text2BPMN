import { askModel } from "./build.server";
import { FEATURE_SYSTEM, extractJson, featureInput, validateFeatures, type FeatureReport } from "./features";
import type { Lang } from "./lang";
import type { Semantics } from "./sim";

export type FeatureResult = { semantics: Partial<Semantics> | null; report: FeatureReport & { error?: string } };

// Call 2: never throws; on failure the app falls back to lane-derived defaults.
export async function extractFeatures(text: string, ir: string, lang: Lang): Promise<FeatureResult> {
  try {
    const answer = await askModel(featureInput(text, ir, lang), "grok-4.20-0309-non-reasoning", lang, FEATURE_SYSTEM[lang]);
    if (!answer.ok) throw new Error(answer.error);
    const { semantics, report } = validateFeatures(extractJson(answer.text), ir);
    if (report.dropped.length) console.warn("[features] dropped invalid entries:", report.dropped.join(", "));
    return { semantics, report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[features] call 2 failed, using defaults:", message);
    return { semantics: null, report: { parsed: false, dropped: [], error: message } };
  }
}
