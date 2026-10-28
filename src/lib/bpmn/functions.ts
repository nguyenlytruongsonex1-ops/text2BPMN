import { createServerFn } from "@tanstack/react-start";
import { asLang } from "./lang";

const LIMITS = {
  vi: {
    needText: "Hãy nhập mô tả quy trình.",
    textCap: "Mô tả tối đa 8000 ký tự.",
    needIr: "Bản IR đang trống.",
    irCap: "IR tối đa 24000 ký tự.",
  },
  en: {
    needText: "Enter a process description.",
    textCap: "Description is limited to 8000 characters.",
    needIr: "The IR draft is empty.",
    irCap: "IR is limited to 24000 characters.",
  },
} as const;

export const buildFromText = createServerFn({ method: "POST" })
  .validator((data: { text?: unknown; lang?: unknown }) => {
    const lang = asLang(data?.lang);
    const note = LIMITS[lang];
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) throw new Error(note.needText);
    if (text.length > 8000) throw new Error(note.textCap);
    return { text, lang };
  })
  .handler(async ({ data }) => {
    const { buildFromDescription } = await import("./build.server");
    return buildFromDescription(data.text, data.lang);
  });

export const translateOnly = createServerFn({ method: "POST" })
  .validator((data: { ir?: unknown; lang?: unknown }) => {
    const lang = asLang(data?.lang);
    const note = LIMITS[lang];
    const ir = typeof data?.ir === "string" ? data.ir : "";
    if (!ir.trim()) throw new Error(note.needIr);
    if (ir.length > 24000) throw new Error(note.irCap);
    return { ir, lang };
  })
  .handler(async ({ data }) => {
    const { runTranslate } = await import("./build.server");
    return runTranslate(data.ir, data.lang);
  });