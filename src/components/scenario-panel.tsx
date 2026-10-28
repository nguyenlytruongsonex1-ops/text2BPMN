import { useEffect, useState } from "react";
import { FileDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copy, type Copy } from "@/lib/bpmn/copy";
import type { Lang } from "@/lib/bpmn/lang";
import { BranchSplit, CompareBars, PaceColumns, StepBars } from "@/components/sim-picture";
import {
  applyPreset,
  defaultSemantics,
  resolveSemantics,
  parseBpmn,
  simulate,
  toCsv,
  toXes,
  type Preset,
  type Problem,
  type RunResult,
  type Semantics,
  type SimGraph,
} from "@/lib/bpmn/sim";
import { verifyLog, type VerifyResult } from "@/lib/bpmn/verify";

type Mode = Preset | "custom";

function fill(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""));
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function slug(name: string) {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario"
  );
}

function problemText(t: Copy, problem: Problem) {
  if (problem.code === "incomplete") return fill(t.problemIncomplete, { count: problem.count });
  if (problem.code === "rework") return fill(t.problemRework, { label: problem.label, rate: problem.rate });
  if (problem.code === "rare") {
    return fill(t.problemRare, { gateway: problem.gateway, label: problem.label, share: problem.share });
  }
  return fill(t.problemDead, { label: problem.label });
}

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ScenarioPanel({
  lang,
  diagramKey,
  xml,
  suggested,
  getXml,
}: {
  lang: Lang;
  diagramKey: string;
  xml: string;
  suggested?: Partial<Semantics> | null; // LLM call-2 features; prefill the semantics JSON
  getXml: () => Promise<string | null>;
}) {
  const t = copy[lang];
  const [graph, setGraph] = useState<SimGraph | null>(null);
  const [mode, setMode] = useState<Mode>("happy");
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [rework, setRework] = useState<Record<string, number>>({});
  const [probability, setProbability] = useState<Record<string, number>>({});
  const [cases, setCases] = useState(200);
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [latest, setLatest] = useState<RunResult | null>(null);
  const [check, setCheck] = useState<VerifyResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [semText, setSemText] = useState("");
  const [semError, setSemError] = useState(false);

  function currentSemantics(): Partial<Semantics> | null {
    try {
      return semText.trim() ? (JSON.parse(semText) as Partial<Semantics>) : null;
    } catch {
      return null;
    }
  }

  function adopt(next: SimGraph, nextMode: Mode, keepCustom: boolean) {
    const base = applyPreset(next, nextMode === "edge" ? "edge" : "happy", currentSemantics());
    if (keepCustom && nextMode === "custom") {
      const minuteIds = new Set(next.nodes.map((node) => node.id));
      const flowIds = new Set(next.flows.map((flow) => flow.id));
      setMinutes({ ...base.minutes, ...Object.fromEntries(Object.entries(minutes).filter(([id]) => minuteIds.has(id))) });
      setRework({ ...base.rework, ...Object.fromEntries(Object.entries(rework).filter(([id]) => minuteIds.has(id))) });
      setProbability({
        ...base.probability,
        ...Object.fromEntries(Object.entries(probability).filter(([id]) => flowIds.has(id))),
      });
    } else {
      setMinutes(base.minutes);
      setRework(base.rework);
      setProbability(base.probability);
    }
    setGraph(next);
  }

  useEffect(() => {
    try {
      const next = parseBpmn(xml);
      if (!next.nodes.length) {
        setGraph(null);
        setMessage("empty");
        return;
      }
      const sem = suggested ? resolveSemantics(next, suggested) : defaultSemantics(next);
      const base = applyPreset(next, "happy", sem);
      setSemText(JSON.stringify(sem, null, 2));
      setSemError(false);
      setGraph(next);
      setMode("happy");
      setMinutes(base.minutes);
      setRework(base.rework);
      setProbability(base.probability);
      setRuns([]);
      setLatest(null);
      setCheck(null);
      setMessage(null);
    } catch {
      setGraph(null);
      setMessage("empty");
    }
  }, [diagramKey, xml, suggested]);

  async function readLive(nextMode: Mode) {
    try {
      const live = (await getXml()) ?? xml;
      const next = parseBpmn(live);
      if (!next.nodes.length) {
        setMessage("empty");
        return;
      }
      adopt(next, nextMode, nextMode === "custom");
      setMode(nextMode);
      setMessage(null);
    } catch {
      setMessage("empty");
    }
  }

  function choose(nextMode: Preset) {
    if (!graph) return;
    adopt(graph, nextMode, false);
    setMode(nextMode);
  }

  function onRun() {
    if (!graph) return;
    const scenario = mode === "edge" ? t.edge : mode === "custom" ? t.custom : t.happy;
    let semantics: Semantics | undefined;
    try {
      semantics = semText.trim() ? (JSON.parse(semText) as Semantics) : undefined;
      setSemError(false);
    } catch {
      setSemError(true);
      return;
    }
    const result = simulate(graph, { scenario, cases, minutes, rework, probability, semantics });
    const verified = verifyLog(graph, result.rows, semantics);
    if (verified.errors.length) console.error(`${t.verifyLabel} (${scenario})`, verified.errors);
    setCheck(verified);
    setLatest(result);
    setRuns((current) => {
      const index = current.findIndex((item) => item.scenario === scenario);
      if (index < 0) return [...current, result];
      return current.map((item, itemIndex) => (itemIndex === index ? result : item));
    });
  }

  const work = graph?.nodes.filter((node) => node.kind === "task" || node.kind === "user" || node.kind === "service") ?? [];
  const gateways = graph?.nodes.filter((node) => node.kind === "xor" || node.kind === "or" || node.kind === "and") ?? [];
  const hasOr = graph?.nodes.some((node) => node.kind === "or") ?? false;

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-sheet p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">
          <span className="mr-2 text-muted">3</span>
          {t.stepScenario}
        </h2>
        <p className="max-w-3xl text-sm text-muted">{t.scenarioHint}</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant={mode === "happy" ? "primary" : "secondary"} onClick={() => choose("happy")} disabled={!graph}>
          {t.happy}
        </Button>
        <Button variant={mode === "edge" ? "primary" : "secondary"} onClick={() => choose("edge")} disabled={!graph}>
          {t.edge}
        </Button>
      </div>
      <p className="text-sm text-muted">
        {mode === "edge" ? t.presetEdge : mode === "custom" ? t.presetCustom : t.presetHappy}
      </p>

      {message ? (
        <p role="alert" className="rounded-sm border border-ink px-3 py-2 text-sm text-ink">
          {t.emptyGraph}
        </p>
      ) : null}

      {graph ? (
        <>
          <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
            {t.cases}
            <input
              type="number"
              min={1}
              max={2000}
              value={cases}
              onChange={(event) => setCases(Math.max(1, Math.min(2000, numberValue(event.target.value, 200))))}
              className="h-11 rounded-sm border border-line bg-paper px-3 text-sm font-normal text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            />
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-ink">{t.people}</summary>
            <p className="mt-2 text-muted">{t.peopleHint}</p>
            <textarea
              value={semText}
              onChange={(event) => setSemText(event.target.value)}
              rows={10}
              spellCheck={false}
              className="mt-2 w-full rounded-sm border border-line bg-paper p-2 font-mono text-xs text-ink"
            />
            {semError ? <p className="text-red-700">{t.peopleBad}</p> : null}
          </details>
          <Button onClick={onRun}>{t.runSim}</Button>

          <details className="text-sm">
            <summary className="cursor-pointer font-medium text-ink">{t.adjust}</summary>
            <div className="mt-3 flex flex-col gap-4">
              <Button variant="secondary" onClick={() => void readLive(mode)} disabled={!xml}>
                {t.reread}
              </Button>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-2 pr-3 font-medium">{t.stepCol}</th>
                      <th className="py-2 pr-3 font-medium">{t.roleCol}</th>
                      <th className="py-2 pr-3 font-medium">{t.minutesCol}</th>
                      <th className="py-2 font-medium">{t.reworkCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {work.map((node) => (
                      <tr key={node.id} className="border-t border-line">
                        <td className="py-2 pr-3">{node.label}</td>
                        <td className="py-2 pr-3 text-muted">{node.role === "Unassigned" ? t.unassigned : node.role}</td>
                        <td className="py-2 pr-3">
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            aria-label={`${node.label} ${t.minutesCol}`}
                            value={minutes[node.id] ?? 0}
                            onChange={(event) => {
                              setMode("custom");
                              setMinutes((current) => ({
                                ...current,
                                [node.id]: Math.max(0, numberValue(event.target.value, 0)),
                              }));
                            }}
                            className="h-11 w-24 rounded-sm border border-line bg-paper px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                          />
                        </td>
                        <td className="py-2">
                          <input
                            type="number"
                            min={0}
                            max={80}
                            aria-label={`${node.label} ${t.reworkCol}`}
                            value={rework[node.id] ?? 0}
                            onChange={(event) => {
                              setMode("custom");
                              setRework((current) => ({
                                ...current,
                                [node.id]: Math.max(0, Math.min(80, numberValue(event.target.value, 0))),
                              }));
                            }}
                            className="h-11 w-24 rounded-sm border border-line bg-paper px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {gateways.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {hasOr ? <p className="text-muted">{t.orNote}</p> : null}
                  {gateways.map((gateway) => {
                    const outs = graph.flows.filter((flow) => flow.source === gateway.id);
                    const sum = outs.reduce((total, flow) => total + (probability[flow.id] ?? 0), 0);
                    return (
                      <div key={gateway.id} className="flex flex-col gap-2">
                        <p className="font-medium">
                          {t.gatewayCol}: {gateway.label}
                        </p>
                        {gateway.kind === "and" ? (
                          <p className="text-muted">{t.allBranches}</p>
                        ) : (
                          <>
                            {outs.map((flow) => (
                              <label key={flow.id} className="flex items-center justify-between gap-3">
                                <span>{flow.label || flow.target}</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  aria-label={`${gateway.label} ${flow.label || flow.target}`}
                                  value={probability[flow.id] ?? 0}
                                  onChange={(event) => {
                                    setMode("custom");
                                    setProbability((current) => ({
                                      ...current,
                                      [flow.id]: Math.max(0, Math.min(100, numberValue(event.target.value, 0))),
                                    }));
                                  }}
                                  className="h-11 w-24 rounded-sm border border-line bg-paper px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                                />
                              </label>
                            ))}
                            {sum !== 100 ? <p className="text-muted">{fill(t.chanceSum, { sum })}</p> : null}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </details>
        </>
      ) : null}

      {latest ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          {latest.completed < latest.cases ? (
            <p className="text-sm text-muted">{fill(t.completedOf, { done: latest.completed, cases: latest.cases })}</p>
          ) : null}
          {check?.warnings?.map((w) => (
            <p key={w} className="text-sm font-medium text-ink">⚠ {t.verifyLabel}: {w}</p>
          ))}
          {check ? (
            check.errors.length ? (
              <div role="alert" className="flex flex-col gap-1 rounded-sm border border-ink px-3 py-2 text-sm text-ink">
                <p className="font-medium">
                  {t.verifyLabel}: {fill(t.verifyBad, { valid: check.valid, total: check.total, bad: check.errors.length })}
                </p>
                <ul className="list-disc pl-5">
                  {check.errors.slice(0, 20).map((error) => (
                    <li key={error.caseId}>
                      {error.caseId}: {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm" data-testid="verify-ok">
                <span className="font-medium">{t.verifyLabel}: </span>
                {fill(t.verifyOk, { valid: check.valid, total: check.total })}
              </p>
            )
          ) : null}
          <p className="text-sm">
            <span className="font-medium">{t.avgLabel} </span>
            {latest.avgMinutes} {t.minuteUnit}.
          </p>
          <p className="text-sm">
            <span className="font-medium">{t.bottleneckLabel}: </span>
            {latest.bottleneck
              ? fill(t.bottleneckLine, {
                  label: latest.bottleneck.label,
                  share: latest.bottleneck.share,
                  minutes: latest.bottleneck.minutes,
                })
              : "—"}
          </p>
          <StepBars steps={latest.steps} hint={t.pictureTime} />
          <p className="text-sm">
            <span className="font-medium">{t.outlierLabel}: </span>
            {latest.outliers.length
              ? fill(t.outlierLine, {
                  count: latest.outliers.length,
                  caseId: latest.outliers[0]?.caseId ?? "",
                  minutes: latest.outliers[0]?.minutes ?? 0,
                })
              : t.noOutlier}
          </p>
          <PaceColumns pace={latest.pace} hint={t.picturePace} />
          {latest.problems.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm">
              <p className="font-medium">{t.problemLabel}</p>
              <ul className="list-disc pl-5">
                {latest.problems.map((problem, index) => (
                  <li key={`${problem.code}-${index}`}>{problemText(t, problem)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <BranchSplit branches={latest.branches} hint={t.pictureBranch} />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="secondary"
              onClick={() => download(`${slug(latest.scenario)}.csv`, toCsv(latest.rows), "text/csv")}
            >
              <FileDown className="size-4" aria-hidden="true" />
              {t.downloadCsv}
            </Button>
            <Button
              variant="secondary"
              onClick={() => download(`${slug(latest.scenario)}.xes`, toXes(latest.rows, latest.scenario), "application/xml")}
            >
              <FileDown className="size-4" aria-hidden="true" />
              {t.downloadXes}
            </Button>
          </div>
          <p className="max-w-3xl text-sm text-muted">{t.noteQueue}</p>
        </div>
      ) : null}

      {runs.length > 1 ? (
        <div className="overflow-x-auto border-t border-line pt-4">
          <p className="mb-2 text-sm font-medium">{t.compare}</p>
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">{t.stepScenario}</th>
                <th className="py-2 pr-3 font-medium">{t.compareTime}</th>
                <th className="py-2 pr-3 font-medium">{t.bottleneckLabel}</th>
                <th className="py-2 font-medium">{t.compareOdd}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.scenario} className="border-t border-line">
                  <td className="py-2 pr-3">{run.scenario}</td>
                  <td className="py-2 pr-3">{run.avgMinutes}</td>
                  <td className="py-2 pr-3">{run.bottleneck?.label ?? "—"}</td>
                  <td className="py-2">{run.outliers.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <CompareBars runs={runs} hint={t.pictureCompare} unit={t.minuteUnit} />
        </div>
      ) : null}
    </section>
  );
}
