import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Lang } from "@/lib/bpmn/lang";
import type {
  CheckInput,
  CheckReport,
  CheckStatus,
  CheckerUsage,
  PromptVariant,
  RepairProposal,
  Requirement,
} from "@/lib/bpmn/checker-types";
import {
  extractRequirements,
  proposeSemanticRepair,
  runCheckerAblation,
  runSemanticCheck,
} from "@/lib/bpmn/checker-functions";

type Snapshot = CheckInput & { diagramKey: string };
type Result = {
  snapshot: Snapshot;
  reports: CheckReport[];
  createdAt: string;
  requirementExtraction: { model: string | null; usage: CheckerUsage | null };
};
const field =
  "w-full min-h-11 rounded-sm border border-line bg-paper px-3 py-2 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function saveFile(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function CheckerPanel({
  text,
  lang,
  diagramKey,
  getXml,
}: {
  text: string;
  lang: Lang;
  diagramKey: string;
  getXml: () => Promise<string | null>;
}) {
  const vi = lang === "vi";
  const tr = (a: string, b: string) => (vi ? a : b);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [requirementSource, setRequirementSource] = useState(text);
  const [requirementModel, setRequirementModel] = useState<string | null>(null);
  const [requirementUsage, setRequirementUsage] = useState<CheckerUsage | null>(null);
  const [strategy, setStrategy] = useState<CheckInput["strategy"]>("strong");
  const [variant, setVariant] = useState<PromptVariant>("P1");
  const [busy, setBusy] = useState<
    "extract" | "check" | "ablation" | "repair" | "reviewRepair" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [proposal, setProposal] = useState<RepairProposal | null>(null);
  const [proposalReview, setProposalReview] = useState<{
    snapshot: Snapshot;
    report: CheckReport;
    createdAt: string;
  } | null>(null);
  const [liveXml, setLiveXml] = useState<string | null>(null);
  const getXmlRef = useRef(getXml);
  getXmlRef.current = getXml;
  const latest = useRef({ text, requirements, strategy, variant, diagramKey });
  latest.current = { text, requirements, strategy, variant, diagramKey };
  const sourceChanged = requirementSource !== text;
  const validRequirements =
    requirements.length > 0 &&
    requirements.length <= 20 &&
    requirements.every(
      (r) => r.assertion.trim() && r.sourceQuote.trim() && text.includes(r.sourceQuote),
    );
  const canRun = !!text.trim() && validRequirements && !sourceChanged && !busy;
  const stale =
    !!result &&
    (result.snapshot.text !== text ||
      JSON.stringify(result.snapshot.requirements) !== JSON.stringify(requirements) ||
      result.snapshot.strategy !== strategy ||
      result.snapshot.variant !== variant ||
      result.snapshot.diagramKey !== diagramKey ||
      liveXml !== result.snapshot.xml);

  // Observe the actual edited canvas, not the IR or the originally generated XML.
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const xml = await getXmlRef.current();
        if (!cancelled) setLiveXml(xml);
      } catch {
        if (!cancelled) setLiveXml(null);
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [result, diagramKey]);

  function failed(e: unknown) {
    setError(
      e instanceof Error
        ? e.message
        : tr("Không thể hoàn tất. Vui lòng thử lại.", "Unable to complete. Please try again."),
    );
  }

  function editRequirement(index: number, key: "assertion" | "sourceQuote", value: string) {
    setRequirements((all) => all.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  async function extract() {
    const source = text;
    setBusy("extract");
    setError(null);
    setProposal(null);
    setProposalReview(null);
    try {
      const response = await extractRequirements({ data: { text: source } });
      setRequirements(response.requirements);
      setRequirementSource(source);
      setRequirementModel(response.model);
      setRequirementUsage(response.usage ?? null);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  async function snapshot(): Promise<Snapshot> {
    const before = latest.current;
    const xml = await getXmlRef.current();
    if (!xml)
      throw new Error(
        tr("Chưa đọc được sơ đồ hiện tại.", "The current diagram could not be read."),
      );
    if (JSON.stringify(before) !== JSON.stringify(latest.current))
      throw new Error(
        tr(
          "Dữ liệu đã đổi. Hãy chạy lại trên bản mới.",
          "Inputs changed. Run again on the current version.",
        ),
      );
    setLiveXml(xml);
    return {
      text: before.text,
      xml,
      requirements: structuredClone(before.requirements),
      variant: before.variant,
      strategy: before.strategy,
      diagramKey: before.diagramKey,
    };
  }

  async function check(ablation: boolean) {
    setBusy(ablation ? "ablation" : "check");
    setError(null);
    setProposal(null);
    setProposalReview(null);
    try {
      const input = await snapshot();
      const reports = ablation
        ? (
            await runCheckerAblation({
              data: { text: input.text, xml: input.xml, requirements: input.requirements },
            })
          ).reports
        : [
            await runSemanticCheck({
              data: {
                text: input.text,
                xml: input.xml,
                requirements: input.requirements,
                variant: input.variant,
                strategy: input.strategy,
              },
            }),
          ];
      setResult({
        snapshot: input,
        reports,
        createdAt: new Date().toISOString(),
        requirementExtraction: { model: requirementModel, usage: requirementUsage },
      });
      setLiveXml(await getXmlRef.current());
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  async function assertOriginalCurrent() {
    if (!result) throw new Error(tr("Chưa có kết quả gốc.", "No original result is available."));
    const xml = await getXmlRef.current();
    setLiveXml(xml);
    const current = latest.current;
    if (
      xml !== result.snapshot.xml ||
      current.text !== result.snapshot.text ||
      current.diagramKey !== result.snapshot.diagramKey ||
      JSON.stringify(current.requirements) !== JSON.stringify(result.snapshot.requirements) ||
      current.strategy !== result.snapshot.strategy ||
      current.variant !== result.snapshot.variant
    ) {
      throw new Error(
        tr(
          "Sơ đồ hoặc yêu cầu đã đổi. Cần kiểm tra lại bản gốc trước khi sửa hoặc kiểm bản sửa.",
          "The diagram or inputs changed. Recheck the original before proposing or reviewing a repair.",
        ),
      );
    }
  }

  async function reviewRepair() {
    if (!result || !proposal || busy || stale || sourceChanged) return;
    setBusy("reviewRepair");
    setError(null);
    setProposalReview(null);
    try {
      await assertOriginalCurrent();
      const input: Snapshot = {
        ...result.snapshot,
        xml: proposal.xml,
        requirements: structuredClone(result.snapshot.requirements),
      };
      const report = await runSemanticCheck({
        data: {
          text: input.text,
          xml: input.xml,
          requirements: input.requirements,
          strategy: input.strategy,
          variant: input.variant,
        },
      });
      setProposalReview({ snapshot: input, report, createdAt: new Date().toISOString() });
      setLiveXml(await getXmlRef.current());
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  async function repair() {
    if (!result || stale || result.reports.length !== 1 || result.reports[0].status !== "fail")
      return;
    setBusy("repair");
    setError(null);
    setProposal(null);
    setProposalReview(null);
    try {
      await assertOriginalCurrent();
      const response = await proposeSemanticRepair({
        data: {
          text: result.snapshot.text,
          xml: result.snapshot.xml,
          requirements: result.snapshot.requirements,
          report: result.reports[0],
        },
      });
      setProposal(response);
      setLiveXml(await getXmlRef.current());
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  async function exportRun() {
    if (!result) return;
    try {
      const xml = await getXmlRef.current();
      setLiveXml(xml);
      const current = latest.current;
      const exportStale =
        xml !== result.snapshot.xml ||
        current.text !== result.snapshot.text ||
        current.diagramKey !== result.snapshot.diagramKey ||
        current.strategy !== result.snapshot.strategy ||
        current.variant !== result.snapshot.variant ||
        JSON.stringify(current.requirements) !== JSON.stringify(result.snapshot.requirements);
      saveFile(
        "text2bpmn-checker-run.json",
        JSON.stringify(
          { version: 1, ...result, stale: exportStale, proposal, proposalReview },
          null,
          2,
        ),
        "application/json",
      );
    } catch (e) {
      failed(e);
    }
  }

  function statusLabel(status: CheckStatus) {
    return status === "pass"
      ? tr("Chưa phát hiện vi phạm", "No violation identified")
      : status === "fail"
        ? tr("Có cảnh báo vi phạm", "Violation flagged")
        : tr("Chưa kết luận", "Unknown");
  }

  return (
    <section
      aria-labelledby="checker-heading"
      aria-busy={busy !== null}
      className="flex flex-col gap-4 rounded-xl border border-line bg-sheet p-4"
    >
      <div className="flex flex-col gap-2">
        <h2 id="checker-heading" className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {tr("Kiểm tra theo yêu cầu", "Requirement-based review")}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {tr(
            "Đối chiếu mô tả với sơ đồ đang chỉnh sửa. Kết quả là đánh giá của LLM, không phải chứng minh đúng ngữ nghĩa.",
            "Compare the description with the currently edited diagram. This is an LLM assessment, not a proof of semantic correctness.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => void extract()}
          disabled={!!busy || !text.trim()}
        >
          {busy === "extract"
            ? tr("Đang trích yêu cầu…", "Extracting requirements…")
            : tr("Trích yêu cầu từ mô tả · 1 lượt API", "Extract requirements · 1 API call")}
        </Button>
        <Button
          variant="ghost"
          disabled={!!busy || requirements.length >= 20}
          onClick={() => {
            setRequirements((all) => [
              ...all,
              { id: `R-${crypto.randomUUID()}`, sourceQuote: "", assertion: "" },
            ]);
            if (!requirements.length) setRequirementSource(text);
          }}
        >
          {tr("Thêm yêu cầu thủ công", "Add a requirement manually")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {tr(
          "Yêu cầu trích xuất là bản nháp cần rà lại, không phải nhãn chuẩn. Câu nguồn phải xuất hiện nguyên văn trong mô tả. Các nút API sử dụng hạn mức của chủ ứng dụng; không tự động gọi model.",
          "Extracted requirements are provisional, not ground-truth labels. Source quotes must appear verbatim in the description. API actions use the app owner's quota; no model runs automatically.",
        )}
        {requirementModel ? ` (${requirementModel})` : ""}
      </p>

      {requirementUsage ? (
        <p className="text-xs text-muted">
          {tr("Lượt trích yêu cầu", "Requirement extraction")}:{" "}
          {(requirementUsage.latencyMs / 1000).toFixed(2)}s · {requirementUsage.inputTokens}/
          {requirementUsage.outputTokens} tokens ·{" "}
          {requirementUsage.costUsd === null
            ? tr("Chưa có chi phí", "Cost unavailable")
            : `$${requirementUsage.costUsd.toFixed(6)}`}
        </p>
      ) : null}
      {requirements.map((r, index) => (
        <fieldset
          key={r.id}
          disabled={!!busy}
          className="flex min-w-0 flex-col gap-2 rounded-sm border border-line p-3"
        >
          <legend className="px-1 text-sm font-medium">
            {tr("Yêu cầu", "Requirement")} {index + 1} · {tr("Tạm thời", "Provisional")}
          </legend>
          <label htmlFor={`req-assert-${r.id}`} className="text-sm">
            {tr("Điều cần kiểm", "Assertion to check")}
          </label>
          <textarea
            id={`req-assert-${r.id}`}
            className={field}
            rows={2}
            value={r.assertion}
            onChange={(e) => editRequirement(index, "assertion", e.target.value)}
          />
          <label htmlFor={`req-source-${r.id}`} className="text-sm">
            {tr("Câu nguồn nguyên văn", "Exact source quote")}
          </label>
          <textarea
            id={`req-source-${r.id}`}
            className={field}
            rows={2}
            value={r.sourceQuote}
            onChange={(e) => editRequirement(index, "sourceQuote", e.target.value)}
          />
          {r.sourceQuote.trim() && !text.includes(r.sourceQuote) ? (
            <p role="alert" className="text-sm font-medium">
              {tr(
                "Câu trích không khớp mô tả hiện tại.",
                "This quote does not match the current description.",
              )}
            </p>
          ) : null}
          <Button
            className="self-start"
            variant="ghost"
            onClick={() => setRequirements((all) => all.filter((_, i) => i !== index))}
          >
            {tr("Bỏ yêu cầu này", "Remove requirement")}
          </Button>
        </fieldset>
      ))}

      {sourceChanged && requirements.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-sm border border-line bg-paper p-3 text-sm">
          <p>
            {tr(
              "Mô tả đã đổi. Trích lại hoặc rà từng yêu cầu trước khi chạy.",
              "The description changed. Extract again or review every requirement before running.",
            )}
          </p>
          <Button
            variant="secondary"
            disabled={!!busy || !validRequirements}
            onClick={() => setRequirementSource(text)}
          >
            {tr(
              "Tôi đã rà yêu cầu theo mô tả mới",
              "I reviewed the requirements against the new description",
            )}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-sm" htmlFor="checker-strategy">
          {tr("Cách kiểm", "Review strategy")}
          <select
            id="checker-strategy"
            className={field}
            value={strategy}
            disabled={!!busy}
            onChange={(e) => setStrategy(e.target.value as CheckInput["strategy"])}
          >
            <option value="light">{tr("Checker nhẹ", "Light checker")}</option>
            <option value="strong">{tr("Checker mạnh hơn", "Stronger checker")}</option>
            <option value="cascade">
              {tr("RiskGate · nhẹ rồi chuyển cấp", "RiskGate · light with escalation")}
            </option>
          </select>
        </label>
        <label className="flex flex-col gap-2 text-sm" htmlFor="checker-variant">
          {tr("Cấu hình hướng dẫn", "Prompt configuration")}
          <select
            id="checker-variant"
            className={field}
            value={variant}
            disabled={!!busy}
            onChange={(e) => setVariant(e.target.value as PromptVariant)}
          >
            <option value="P0">{tr("P0 · Cơ bản", "P0 · Basic")}</option>
            <option value="P1">{tr("P1 · Có rubric", "P1 · With rubric")}</option>
            <option value="P2">
              {tr("P2 · Kiểm từng yêu cầu", "P2 · Requirement-by-requirement")}
            </option>
          </select>
        </label>
      </div>
      <p className="text-xs text-muted">
        {tr(
          "Checker mạnh là mặc định sau benchmark PET flow-order. RiskGate vẫn là chế độ thăm dò vì checker nhẹ chưa đạt ngưỡng làm cổng tự động. P2 yêu cầu bằng chứng ngắn, không bảo đảm kết luận đúng.",
          "The stronger checker is the default after the PET flow-order benchmark. RiskGate remains experimental because the light checker did not qualify as an automatic gate. P2 requests concise evidence, not a guarantee of correctness.",
        )}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button disabled={!canRun} onClick={() => void check(false)}>
          {busy === "check"
            ? tr("Đang kiểm tra…", "Reviewing…")
            : tr("Kiểm tra sơ đồ hiện tại", "Review current diagram")}
        </Button>
        <Button variant="secondary" disabled={!canRun} onClick={() => void check(true)}>
          {busy === "ablation"
            ? tr("Đang chạy 6 cấu hình…", "Running 6 configurations…")
            : tr("Thí nghiệm 6 cấu hình · 6 lượt API", "Run 6 configurations · 6 API calls")}
        </Button>
      </div>
      {!requirements.length ? (
        <p className="text-sm text-muted">
          {tr(
            "Trích hoặc thêm yêu cầu để bắt đầu. Chưa có kết quả kiểm tra.",
            "Extract or add requirements to begin. No review results yet.",
          )}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        {tr(
          "Một lượt kiểm gọi 1 model; cascade có thể gọi 2. Đề xuất sửa gọi thêm 1 model. Retry có thể phát sinh thêm lượt và chi phí.",
          "A review calls 1 model; cascade may call 2. A repair proposal calls 1 more model. Retries may add calls and cost.",
        )}
      </p>
      {busy ? (
        <p role="status" className="text-sm">
          {tr(
            "Đang xử lý yêu cầu. Kết quả sẽ gắn với bản chụp dữ liệu lúc chạy.",
            "Processing. Results will be attached to the input snapshot used for this run.",
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words rounded-sm border border-ink p-3 text-sm">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold">
                {tr("Kết quả đánh giá LLM", "LLM review results")}
              </h3>
              <p className="break-all text-xs text-muted">{result.createdAt}</p>
            </div>
            <Button variant="secondary" onClick={() => void exportRun()}>
              <Download className="size-4" aria-hidden="true" />
              {tr("Xuất bản ghi JSON", "Export JSON snapshot")}
            </Button>
          </div>
          {stale ? (
            <p
              role="status"
              className="rounded-sm border border-ink bg-paper p-3 text-sm font-medium"
            >
              {tr(
                "Kết quả cũ: mô tả, yêu cầu, cấu hình hoặc sơ đồ đã đổi. Chạy lại trước khi sử dụng; không đề xuất sửa trên kết quả này.",
                "Stale results: the description, requirements, configuration or diagram changed. Recheck before use; repairs are disabled for this result.",
              )}
            </p>
          ) : null}
          {result.reports.map((report, ri) => (
            <article
              key={ri}
              className="flex min-w-0 flex-col gap-3 rounded-sm border border-line p-3"
            >
              <p className="text-sm font-semibold">{statusLabel(report.status)}</p>
              <p className="break-words text-xs text-muted">{report.scope}</p>
              {report.routingReason ? (
                <p className="break-words text-sm">
                  {tr("Định tuyến", "Routing")}:{" "}
                  {report.escalated
                    ? tr("Đã chuyển cấp", "Escalated")
                    : tr("Không chuyển cấp", "Not escalated")}{" "}
                  · {report.routingReason}
                </p>
              ) : null}
              {report.runs.map((run, i) => (
                <div key={i} className="flex min-w-0 flex-col gap-2 border-t border-line pt-3">
                  <p className="break-words text-sm font-medium">
                    {run.tier === "light" ? tr("Nhẹ", "Light") : tr("Mạnh hơn", "Stronger")} ·{" "}
                    {run.variant}
                  </p>
                  <p className="break-words text-xs text-muted">
                    {tr("Model yêu cầu", "Requested model")}: {run.model} · {tr("Model thực tế", "Effective model")}: {run.effectiveModel ?? tr("Không được báo cáo", "Not reported")}
                  </p>
                  <p className="break-words text-xs text-muted">
                    {tr("Nhà cung cấp", "Provider")}:{" "}
                    {run.provider ?? tr("Không xác định", "Not reported")} ·{" "}
                    {(run.latencyMs / 1000).toFixed(2)}s · {run.inputTokens}/{run.outputTokens}{" "}
                    {tr("token vào/ra", "input/output tokens")} ·{" "}
                    {run.costUsd === null
                      ? tr("Chưa có chi phí", "Cost unavailable")
                      : `$${run.costUsd.toFixed(6)}`}
                  </p>
                  {run.error ? (
                    <p role="alert" className="break-words text-sm">
                      {run.error}
                    </p>
                  ) : null}
                  {run.assessments.map((a, ai) => {
                    const requirement = result.snapshot.requirements.find(
                      (r) => r.id === a.requirementId,
                    );
                    return (
                      <div
                        key={`${a.requirementId}-${ai}`}
                        className="flex min-w-0 flex-col gap-1 rounded-sm bg-paper p-3 text-sm"
                      >
                        <p className="font-medium">
                          {statusLabel(a.status)} · {requirement?.assertion ?? a.requirementId}
                        </p>
                        {requirement ? (
                          <blockquote className="break-words border-l-2 border-line pl-2 text-muted">
                            {requirement.sourceQuote}
                          </blockquote>
                        ) : null}
                        <p className="break-words">{a.explanation}</p>
                        {a.evidence.length ? (
                          <ul className="list-disc break-words pl-5">
                            {a.evidence.map((e, ei) => (
                              <li key={ei}>{e}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="text-xs text-muted">
                            {tr(
                              "Model chưa cung cấp bằng chứng.",
                              "No evidence provided by the model.",
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </article>
          ))}
          {result.reports.length === 1 ? (
            <Button
              variant="secondary"
              className="self-start"
              disabled={!!busy || stale || sourceChanged || result.reports[0].status !== "fail"}
              onClick={() => void repair()}
            >
              {busy === "repair"
                ? tr("Đang đề xuất sửa…", "Proposing a repair…")
                : tr("Đề xuất bản sửa · không tự áp dụng", "Propose repair · never auto-applied")}
            </Button>
          ) : null}
          {proposal ? (
            <div className="flex flex-col gap-3 rounded-sm border border-line bg-paper p-3">
              <h3 className="text-sm font-semibold">
                {tr("Bản sửa đề xuất · CHƯA KIỂM CHỨNG", "Repair proposal · UNVERIFIED")}
              </h3>
              <p className="break-words text-sm">{proposal.note}</p>
              <p className="break-words text-xs text-muted">
                {proposal.model} ·{" "}
                {tr(
                  "Không thay đổi sơ đồ hiện tại. Bản sửa có thể tạo lỗi mới; phải kiểm lại mọi yêu cầu bắt buộc trước khi sử dụng.",
                  "The current diagram is unchanged. This proposal may introduce new errors; recheck all mandatory requirements before use.",
                )}
              </p>
              {proposal.usage ? (
                <p className="text-xs text-muted">
                  {tr("Lượt đề xuất sửa", "Repair proposal call")}:{" "}
                  {(proposal.usage.latencyMs / 1000).toFixed(2)}s · {proposal.usage.inputTokens}/
                  {proposal.usage.outputTokens} tokens ·{" "}
                  {proposal.usage.costUsd === null
                    ? tr("Chưa có chi phí", "Cost unavailable")
                    : `$${proposal.usage.costUsd.toFixed(6)}`}
                </p>
              ) : null}
              <Button
                variant="secondary"
                className="self-start"
                disabled={!!busy || stale || sourceChanged}
                onClick={() => void reviewRepair()}
              >
                {busy === "reviewRepair"
                  ? tr("Đang kiểm lại bản sửa…", "Reviewing repair…")
                  : tr(
                      "Kiểm lại bản sửa theo toàn bộ yêu cầu · API",
                      "Recheck repair against all requirements · API",
                    )}
              </Button>
              <p className="text-xs text-muted">
                {tr(
                  "Kiểm lại bằng checker đã chọn, trên toàn bộ yêu cầu của lượt gốc; không áp dụng bản sửa và không biến kết quả thành chứng minh hình thức.",
                  "Uses the selected checker against every original requirement. The proposal is not applied, and this review is not a formal proof.",
                )}
              </p>
              {proposalReview ? (
                <section
                  aria-label={tr("Đánh giá riêng bản sửa", "Separate repair assessment")}
                  className="flex min-w-0 flex-col gap-3 rounded-sm border border-line bg-sheet p-3"
                >
                  <h4 className="text-sm font-semibold">
                    {tr(
                      "Đánh giá LLM trên bản sửa · vẫn CHƯA KIỂM CHỨNG",
                      "LLM assessment of repair · still UNVERIFIED",
                    )}
                  </h4>
                  {stale ? (
                    <p className="text-sm font-medium">
                      {tr(
                        "Kết quả cũ do dữ liệu hoặc sơ đồ gốc đã đổi.",
                        "Stale assessment: the original inputs or diagram changed.",
                      )}
                    </p>
                  ) : null}
                  <p className="text-sm font-medium">{statusLabel(proposalReview.report.status)}</p>
                  <p className="break-all text-xs text-muted">
                    {proposalReview.createdAt} · {proposalReview.report.candidateFingerprint}
                  </p>
                  <p className="break-words text-xs text-muted">{proposalReview.report.scope}</p>
                  <p className="break-words text-sm">
                    {tr("Định tuyến", "Routing")}: {proposalReview.report.routingReason}
                  </p>
                  {proposalReview.report.runs.map((run, runIndex) => (
                    <div
                      key={runIndex}
                      className="flex min-w-0 flex-col gap-2 border-t border-line pt-3"
                    >
                      <p className="break-words text-sm font-medium">
                        {run.model} · {run.variant} ·{" "}
                        {run.provider ?? tr("Nhà cung cấp chưa rõ", "Provider not reported")}
                      </p>
                      <p className="text-xs text-muted">
                        {(run.latencyMs / 1000).toFixed(2)}s · {run.inputTokens}/{run.outputTokens}{" "}
                        tokens ·{" "}
                        {run.costUsd === null
                          ? tr("Chưa có chi phí", "Cost unavailable")
                          : `$${run.costUsd.toFixed(6)}`}
                      </p>
                      {run.error ? (
                        <p role="alert" className="break-words text-sm">
                          {run.error}
                        </p>
                      ) : null}
                      {run.assessments.map((assessment, assessmentIndex) => (
                        <div
                          key={`${assessment.requirementId}-${assessmentIndex}`}
                          className="flex min-w-0 flex-col gap-1 rounded-sm bg-paper p-3 text-sm"
                        >
                          <p className="font-medium">
                            {statusLabel(assessment.status)} ·{" "}
                            {proposalReview.snapshot.requirements.find(
                              (r) => r.id === assessment.requirementId,
                            )?.assertion ?? assessment.requirementId}
                          </p>
                          <p className="break-words">{assessment.explanation}</p>
                          {assessment.evidence.length ? (
                            <ul className="list-disc break-words pl-5">
                              {assessment.evidence.map((e, ei) => (
                                <li key={ei}>{e}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-xs text-muted">
                              {tr(
                                "Model chưa cung cấp bằng chứng.",
                                "No evidence provided by the model.",
                              )}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              ) : null}
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  {tr("Xem XML đề xuất", "Inspect proposed XML")}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {proposal.xml}
                </pre>
              </details>
              <Button
                variant="secondary"
                className="self-start"
                onClick={() =>
                  saveFile("text2bpmn-repair-unverified.bpmn", proposal.xml, "application/bpmn+xml")
                }
              >
                <Download className="size-4" aria-hidden="true" />
                {tr("Tải bản sửa chưa kiểm chứng", "Download unverified proposal")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
