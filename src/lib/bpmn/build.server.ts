import { translatePreferPython, type EngineResult } from "./engine.server";
import { asLang, type Lang } from "./lang";
import type { DiagramFile } from "./translate";
import { checkIr, mergeStarts } from "./ircheck";
import { SYSTEMS, detectLang } from "./prompts";
import type { Semantics } from "./sim";
import type { FeatureResult } from "./features.server";

const DRAFT_MODEL = "grok-4.20-0309-non-reasoning";
const REPAIR_MODEL = "grok-4.5";

export type StudioResult = {
  ok: boolean;
  ir: string;
  engine: "python" | "javascript" | null;
  diagrams: DiagramFile[];
  combinedXml: string;
  error: string | null;
  attempts?: number[]; // error count of each LLM attempt (first draft, then retries)
  semantics?: Partial<Semantics> | null; // call 2: simulation features (null = use defaults)
  features?: FeatureResult["report"];
};

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export function extractIr(text: string): string {
  let source = text.trim();
  if (source.includes("```")) {
    const parts = source.split("```").map((part) => part.replace(/^[a-z0-9_-]+\s*/i, "").trim());
    source =
      parts
        .filter(Boolean)
        .sort((a, b) => Number(/\bprocess\b/i.test(b)) - Number(/\bprocess\b/i.test(a)) || b.length - a.length)[0] ??
      source;
  }
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^(process|lane|start|end|task|user|service|xor|and|or|pool)\b/i.test(line.trim()) || line.includes("->"),
  );
  if (start > 0) return lines.slice(start).join("\n").trim();
  return source.trim();
}

const API_COPY = {
  vi: {
    aiDown: "AI chưa sẵn sàng trong môi trường này. Bạn vẫn có thể dán IR và bấm Dịch lại.",
    offline: "Không kết nối được để đọc mô tả. Thử lại.",
    unreadable: (status: number, suffix: string) => `Không đọc được mô tả (${status}).${suffix}`,
    empty: "Mô hình không trả về bản IR.",
    draft: (text: string) => `Mô tả quy trình:\n${text}`,
    repair: (error: string, ir: string, text: string) =>
      `IR sau không dịch được.\nLỗi: ${error}\n\nIR:\n${ir}\n\nMô tả gốc:\n${text}\n\nXuất lại toàn bộ IR đã sửa. Chỉ IR.`,
    fix: (errors: string[], ir: string, text: string) =>
      `Sửa các lỗi sau:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nIR hiện tại:\n${ir}\n\nMô tả gốc:\n${text}\n\nXuất lại toàn bộ IR đã sửa. Chỉ IR.`,
  },
  en: {
    aiDown: "AI is not available in this environment. You can still paste IR and translate it again.",
    offline: "Could not reach the model. Try again.",
    unreadable: (status: number, suffix: string) => `Could not read the description (${status}).${suffix}`,
    empty: "The model did not return an IR draft.",
    draft: (text: string) => `Process description:\n${text}`,
    repair: (error: string, ir: string, text: string) =>
      `The IR below did not translate.\nError: ${error}\n\nIR:\n${ir}\n\nOriginal description:\n${text}\n\nOutput the full corrected IR. IR only.`,
    fix: (errors: string[], ir: string, text: string) =>
      `Fix these errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nCurrent IR:\n${ir}\n\nOriginal description:\n${text}\n\nOutput the full corrected IR. IR only.`,
  },
} as const;

export async function askModel(
  user: string,
  model: string,
  lang: Lang,
  system: string = SYSTEMS[lang],
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const note = API_COPY[lang];
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const apiKey = openRouterKey || process.env.XAI_API_KEY;
  const endpoint = openRouterKey
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.x.ai/v1/chat/completions";
  if (openRouterKey) model = process.env.OPENROUTER_MODEL || "qwen/qwen3.5-9b";
  if (!apiKey) {
    return { ok: false, error: note.aiDown };
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 1800,
        ...(openRouterKey ? { reasoning: { enabled: false } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    return { ok: false, error: note.offline };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } | string };
      detail = typeof body.error === "string" ? body.error : (body.error?.message ?? "");
    } catch {
      detail = "";
    }
    const suffix = detail ? ` ${detail.slice(0, 180)}` : "";
    return { ok: false, error: note.unreadable(response.status, suffix) };
  }

  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const text = asText(body.choices?.[0]?.message?.content).trim();
  if (!text) return { ok: false, error: note.empty };
  return { ok: true, text };
}

function pack(ir: string, translated: EngineResult): StudioResult {
  if (!translated.ok) {
    return {
      ok: false,
      ir,
      engine: translated.engine,
      diagrams: [],
      combinedXml: "",
      error: translated.error,
    };
  }
  return {
    ok: true,
    ir,
    engine: translated.engine,
    diagrams: translated.diagrams,
    combinedXml: translated.combinedXml,
    error: null,
  };
}

export async function runTranslate(ir: string, lang: Lang = "vi"): Promise<StudioResult> {
  const translated = await translatePreferPython(ir, lang);
  return pack(ir, translated);
}

export async function buildFromDescription(text: string, langInput?: unknown): Promise<StudioResult> {
  void asLang(langInput);
  const lang = detectLang(text); // prompt, retries and labels follow the description's language
  const note = API_COPY[lang];
  const drafted = await askModel(note.draft(text), DRAFT_MODEL, lang);
  if (!drafted.ok) {
    return { ok: false, ir: "", engine: null, diagrams: [], combinedXml: "", error: drafted.error };
  }
  let ir = extractIr(drafted.text);
  let translated = await translatePreferPython(ir, lang);
  if (!translated.ok) {
    const repaired = await askModel(note.repair(translated.error, ir, text), REPAIR_MODEL, lang);
    if (repaired.ok) {
      ir = extractIr(repaired.text);
      translated = await translatePreferPython(ir, lang);
    }
  }
  const problems = (candidate: string, result: EngineResult) => [
    ...checkIr(candidate, lang),
    ...(result.ok ? result.diagrams.flatMap((d) => d.warnings) : [result.error]),
  ];
  let errors = problems(ir, translated);
  const attempts = [errors.length];
  // Up to 2 retries with the exact error list; keep the version with the fewest errors.
  for (let attempt = 0; attempt < 2 && errors.length; attempt += 1) {
    const fixed = await askModel(note.fix(errors.slice(0, 12), ir, text), REPAIR_MODEL, lang);
    if (!fixed.ok) break;
    const fixedIr = extractIr(fixed.text);
    const retry = await translatePreferPython(fixedIr, lang);
    const retryErrors = problems(fixedIr, retry);
    attempts.push(retryErrors.length);
    if (retry.ok && retryErrors.length < errors.length) {
      ir = fixedIr;
      translated = retry;
      errors = retryErrors;
    }
  }
  // Safety net: several starts left after retries -> one start + xor.
  const merged = mergeStarts(ir, lang);
  if (merged !== ir) {
    const again = await translatePreferPython(merged, lang);
    if (again.ok) {
      ir = merged;
      translated = again;
      translated.diagrams[0]?.warnings.push(
        lang === "vi" ? "Mô hình có nhiều start — đã gộp thành một start + xor." : "Several starts — merged into one start + xor.",
      );
    }
  }
  const result: StudioResult = { ...pack(ir, translated), attempts };
  if (result.ok) {
    const { extractFeatures } = await import("./features.server");
    const features = await extractFeatures(text, ir, lang);
    result.semantics = features.semantics;
    result.features = features.report;
  }
  return result;
}
