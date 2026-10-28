// Call 2 (simulation features): prompt + strict validation of the LLM JSON into label-keyed Semantics.
import { parseIr, type Step } from "./ircheck.ts";
import type { Lang } from "./lang";
import type { Semantics } from "./sim";

const WORK = new Set(["task", "user", "service"]);
const SYSTEM_LANE = /(hệ thống|he thong|system|website|app)/i;

export const FEATURE_SYSTEM: Record<Lang, string> = {
  en: `You read a process description and its BPMN steps and output simulation settings as ONE JSON object. No markdown, no explanation.
Schema (use the step ids exactly as given; omit what the text gives no hint for):
{
 "roles": {"<lane>": {"count": <1-20 people>, "names": ["<person>", ...]}},
 "customerRole": "<lane whose tasks are done by the requester/customer of each case, or null>",
 "customers": ["<customer name>", ...],
 "minutes": {"<task_id>": <typical minutes, 1-2880>},
 "rework": {"<task_id>": <probability 0-0.5 that the task must be redone>},
 "branches": {"<xor_id>": {"<target_id>": <probability 0-1>}},
 "bottlenecks": ["<task_id likely to be slow when things go badly>"]
}
Rules: only ids from the list; only lanes from the list; system lanes need no people; rework only for tasks that can really be redone (checks, reviews, corrections); branch probabilities per xor sum to 1, the normal/successful path most likely; at most 5 bottlenecks. Output JSON only.`,
  vi: `Bạn đọc mô tả quy trình và danh sách bước BPMN, rồi xuất cấu hình mô phỏng dưới dạng MỘT đối tượng JSON. Không markdown, không giải thích.
Lược đồ (dùng đúng mã bước đã cho; bỏ qua mục mô tả không gợi ý):
{
 "roles": {"<lane>": {"count": <1-20 người>, "names": ["<tên người>", ...]}},
 "customerRole": "<lane có việc do chính khách/người gửi yêu cầu của mỗi case làm, hoặc null>",
 "customers": ["<tên khách>", ...],
 "minutes": {"<ma_task>": <số phút thường gặp, 1-2880>},
 "rework": {"<ma_task>": <xác suất 0-0.5 phải làm lại>},
 "branches": {"<ma_xor>": {"<ma_dich>": <xác suất 0-1>}},
 "bottlenecks": ["<ma_task dễ chậm khi tình huống xấu>"]
}
Quy tắc: chỉ dùng mã trong danh sách; chỉ lane trong danh sách; lane hệ thống không cần người; rework chỉ cho việc thật sự có thể làm lại (kiểm tra, duyệt, sửa); xác suất các nhánh của mỗi xor cộng bằng 1, nhánh bình thường/thành công cao nhất; tối đa 5 bottleneck. Chỉ in JSON.`,
};

export function featureInput(text: string, ir: string, lang: Lang) {
  const { steps, flows } = parseIr(ir);
  const lanes = laneList(ir, steps);
  const fmt = (s: Step) => `${s.id} | ${s.kind} | "${s.label}" | ${s.lane ?? "-"}`;
  const xors = [...steps.values()]
    .filter((s) => s.kind === "xor")
    .map((s) => `${s.id} -> ${flows.filter((f) => f.src === s.id).map((f) => f.dst).join(", ")}`);
  const [d, l, st, x] =
    lang === "vi" ? ["Mô tả", "Lane", "Bước (mã | loại | nhãn | lane)", "Nhánh xor"] : ["Description", "Lanes", "Steps (id | type | label | lane)", "xor branches"];
  return `${d}:\n${text}\n\n${l}: ${lanes.join(", ") || "-"}\n\n${st}:\n${[...steps.values()].filter((s) => WORK.has(s.kind) || s.kind === "xor").map(fmt).join("\n")}\n\n${x}:\n${xors.join("\n") || "-"}`;
}

function laneList(ir: string, steps: Map<string, Step>) {
  const declared = [...ir.matchAll(/^\s*lane\s+"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1]!);
  return [...new Set([...declared, ...[...steps.values()].map((s) => s.lane).filter((x): x is string => !!x)])];
}

export function extractJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object");
  return JSON.parse(text.slice(a, b + 1));
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const names = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim() && x.length <= 60).map((x) => x.trim()))] : [];
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export type FeatureReport = { parsed: boolean; dropped: string[] };

// Branch odds accept 0-1 or percentages and are normalised per xor. Invalid entries are dropped (reported); missing keys are later filled by resolveSemantics defaults.
export function validateFeatures(raw: unknown, ir: string): { semantics: Partial<Semantics>; report: FeatureReport } {
  const dropped: string[] = [];
  const root = obj(raw);
  if (!root) return { semantics: {}, report: { parsed: false, dropped: ["root is not an object"] } };
  const { steps, flows } = parseIr(ir);
  const lanes = new Set(laneList(ir, steps));
  const task = (id: string) => (WORK.has(steps.get(id)?.kind ?? "") ? steps.get(id)! : null);
  const sem: Partial<Semantics> = {};

  const cr = root.customerRole;
  if (typeof cr === "string" && lanes.has(cr)) {
    sem.customerRole = cr;
    const cs = names(root.customers).slice(0, 20);
    if (cs.length) sem.customers = cs;
    else if (root.customers !== undefined) dropped.push("customers");
  } else if (cr !== undefined && cr !== null) dropped.push(`customerRole:${String(cr)}`);

  const roles = obj(root.roles);
  if (roles) {
    sem.roles = {};
    for (const [lane, v] of Object.entries(roles)) {
      const spec = obj(v);
      if (!lanes.has(lane) || SYSTEM_LANE.test(lane) || !spec) {
        dropped.push(`roles.${lane}`);
        continue;
      }
      if (lane === sem.customerRole) {
        if (sem.customers) sem.roles[lane] = sem.customers;
        continue;
      }
      const given = names(spec.names);
      const count = num(spec.count, 1, 20) ?? (given.length >= 1 && given.length <= 20 ? given.length : null);
      if (!count) {
        dropped.push(`roles.${lane}`);
        continue;
      }
      const n = Math.round(count);
      sem.roles[lane] = Array.from({ length: n }, (_, i) => given[i] ?? `${lane} - NV${i + 1}`);
    }
  } else if (root.roles !== undefined) dropped.push("roles");

  const perTask = (key: "minutes" | "rework", lo: number, hi: number) => {
    const m = obj(root[key]);
    if (!m) {
      if (root[key] !== undefined) dropped.push(key);
      return;
    }
    const out: Record<string, number> = {};
    for (const [id, v] of Object.entries(m)) {
      const t = task(id);
      const n = num(v, lo, hi);
      if (t && n !== null) out[t.label] = key === "minutes" ? Math.round(n * 10) / 10 : n;
      else dropped.push(`${key}.${id}`);
    }
    sem[key] = out;
  };
  perTask("minutes", 0.5, 2880);
  perTask("rework", 0, 0.5);

  const br = obj(root.branches);
  if (br) {
    sem.branches = {};
    for (const [gid, v] of Object.entries(br)) {
      const g = steps.get(gid);
      const m = obj(v);
      const targets = new Set(flows.filter((f) => f.src === gid).map((f) => f.dst));
      if (!g || g.kind !== "xor" || !m) {
        dropped.push(`branches.${gid}`);
        continue;
      }
      const ok = Object.entries(m).filter(([t, p]) => targets.has(t) && num(p, 0, 100) !== null) as [string, number][];
      const sum = ok.reduce((a, [, p]) => a + p, 0);
      if (ok.length !== Object.keys(m).length) dropped.push(`branches.${gid}.*`);
      if (!ok.length || sum <= 0) continue;
      sem.branches[g.label] = Object.fromEntries(ok.map(([t, p]) => [steps.get(t)!.label, Math.round((p / sum) * 1000) / 1000]));
    }
  } else if (root.branches !== undefined) dropped.push("branches");

  if (Array.isArray(root.bottlenecks)) {
    const b = root.bottlenecks.filter((id): id is string => typeof id === "string" && !!task(id));
    if (b.length !== root.bottlenecks.length) dropped.push("bottlenecks.*");
    sem.bottlenecks = [...new Set(b.slice(0, 5).map((id) => steps.get(id)!.label))];
  } else if (root.bottlenecks !== undefined) dropped.push("bottlenecks");

  return { semantics: sem, report: { parsed: true, dropped } };
}
