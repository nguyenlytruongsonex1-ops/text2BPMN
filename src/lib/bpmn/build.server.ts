import { translatePreferPython, type EngineResult } from "./engine.server";
import { asLang, type Lang } from "./lang";
import type { DiagramFile } from "./translate";

const DRAFT_MODEL = "grok-4.20-0309-non-reasoning";
const REPAIR_MODEL = "grok-4.5";

export type StudioResult = {
  ok: boolean;
  ir: string;
  engine: "python" | "javascript" | null;
  diagrams: DiagramFile[];
  combinedXml: string;
  error: string | null;
};

const SYSTEM = `Output text IR for basic BPMN only. No XML, no markdown, no explanation. Keep labels in the language of the description: English text gives English labels, even though the example below is Vietnamese.

Bạn chỉ xuất IR văn bản cho BPMN cơ bản. Không XML, không markdown, không giải thích.

Mỗi dòng một lệnh (<ma> là mã bước do bạn đặt, KHÔNG viết chữ "id"):
process "Tên quy trình"
lane "Vai trò"
start <ma> "Nhãn" lane "Vai trò"
end <ma> "Nhãn" lane "Vai trò"
task <ma> "Nhãn" lane "Vai trò"
user <ma> "Nhãn" lane "Vai trò"
service <ma> "Nhãn" lane "Vai trò"
xor <ma> "Câu hỏi?" lane "Vai trò"
and <ma> "Nhãn" lane "Vai trò"
<ma_nguon> -> <ma_dich> "Nhãn nhánh"

Quy tắc:
- Nhiều quy trình trong một văn bản thì mỗi quy trình bắt đầu bằng một dòng process.
- Mã bước là duy nhất, chỉ gồm chữ không dấu, số và _ (ví dụ s1, kiem_tra, g_dat). Nhãn giữ ngôn ngữ của người dùng, đặt trong ngoặc kép. Thoát " bằng \\".
- Mỗi dòng bước PHẢI bắt đầu bằng loại (start/end/task/user/service/xor/and), không bao giờ bắt đầu bằng mã.
- Khai báo mọi bước trước, rồi mới viết luồng. Luồng chỉ dùng mã đã khai báo, không dùng nhãn, không nối một bước với chính nó.
- user: việc do người làm. service: việc do hệ thống làm. task: việc chung.
- xor khi rẽ loại trừ: mỗi luồng ra khỏi xor phải có nhãn điều kiện ngắn ("Có", "Không"...). Các nhánh xor gặp lại nhau thì hội tụ bằng một xor khác, KHÔNG bao giờ bằng and.
- and khi làm song song: các nhánh and phải hội tụ ở một and khác trước khi đi tiếp. Luồng của and không cần nhãn.
- Lặp lại/làm lại: nối luồng từ nhánh xor quay về bước trước đó (không cần gateway mới).
- Đúng một start. Một end, trừ khi các nhánh thật sự kết thúc khác nhau.
- Có vai trò thì khai báo lane và gắn lane cho từng bước. Không có vai trò thì bỏ lane.
- Không thêm bước ngoài mô tả. Tối đa 30 bước mỗi quy trình.
- Nhãn theo ngôn ngữ của mô tả (mô tả tiếng Anh thì nhãn tiếng Anh). Mã bước vẫn không dấu.
- Mơ hồ thì chọn cách diễn giải ngắn nhất.

Ví dụ:
process "Duyệt đơn nghỉ phép"
lane "Nhân viên"
lane "Quản lý"
start s1 "Có nhu cầu nghỉ" lane "Nhân viên"
user nop_don "Nộp đơn nghỉ phép" lane "Nhân viên"
and g_song "Tách song song" lane "Quản lý"
user xem_lich "Xem lịch nhóm" lane "Quản lý"
service tra_phep "Tra số ngày phép" lane "Quản lý"
and g_hop "Gộp song song" lane "Quản lý"
xor g_duyet "Duyệt đơn?" lane "Quản lý"
user sua_don "Sửa đơn" lane "Nhân viên"
service ghi_nhan "Ghi nhận ngày nghỉ" lane "Quản lý"
end e1 "Xong" lane "Quản lý"
s1 -> nop_don
nop_don -> g_song
g_song -> xem_lich
g_song -> tra_phep
xem_lich -> g_hop
tra_phep -> g_hop
g_hop -> g_duyet
g_duyet -> ghi_nhan "Đồng ý"
g_duyet -> sua_don "Cần sửa"
sua_don -> nop_don
ghi_nhan -> e1

Tự kiểm tra trước khi in: mỗi dòng bước có loại ở đầu; mã duy nhất và không phải "id"; mọi luồng dùng mã đã khai báo; không luồng tự thân; mọi nhánh xor có nhãn; xor hội tụ bằng xor, and bằng and; đúng một start.
Chỉ in IR.`;

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
  },
  en: {
    aiDown: "AI is not available in this environment. You can still paste IR and translate it again.",
    offline: "Could not reach the model. Try again.",
    unreadable: (status: number, suffix: string) => `Could not read the description (${status}).${suffix}`,
    empty: "The model did not return an IR draft.",
    draft: (text: string) => `Process description:\n${text}`,
    repair: (error: string, ir: string, text: string) =>
      `The IR below did not translate.\nError: ${error}\n\nIR:\n${ir}\n\nOriginal description:\n${text}\n\nOutput the full corrected IR. IR only.`,
  },
} as const;

async function askModel(
  user: string,
  model: string,
  lang: Lang,
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
          { role: "system", content: SYSTEM },
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
  const lang = asLang(langInput);
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
  const warnings = translated.ok ? translated.diagrams.flatMap((d) => d.warnings) : [];
  if (warnings.length) {
    const fixed = await askModel(note.repair(warnings.slice(0, 8).join("\n"), ir, text), REPAIR_MODEL, lang);
    if (fixed.ok) {
      const fixedIr = extractIr(fixed.text);
      const retry = await translatePreferPython(fixedIr, lang);
      if (retry.ok && retry.diagrams.flatMap((d) => d.warnings).length < warnings.length) {
        ir = fixedIr;
        translated = retry;
      }
    }
  }
  return pack(ir, translated);
}
