import { useEffect, useRef, useState } from "react";
import { FileDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiagramCanvas, type DiagramHandle } from "@/components/diagram-canvas";
import { ScenarioPanel } from "@/components/scenario-panel";
import { buildFromText, translateOnly } from "@/lib/bpmn/functions";
import { copy } from "@/lib/bpmn/copy";
import { type Lang } from "@/lib/bpmn/lang";
import { IR_HINT, SAMPLE_IR, SAMPLES } from "@/lib/bpmn/samples";
import type { DiagramFile } from "@/lib/bpmn/translate";

const STORAGE_KEY = "luong.v1";
const LANG_KEY = "luong.lang";

type EngineName = "python" | "javascript" | null;

function fileSlug(name: string) {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "quy-trinh"}.bpmn`;
}

function download(filename: string, xml: string) {
  const blob = new Blob([xml], { type: "application/bpmn+xml" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function Studio() {
  const [lang, setLang] = useState<Lang>("vi");
  const [text, setText] = useState("");
  const [ir, setIr] = useState("");
  const [diagrams, setDiagrams] = useState<DiagramFile[]>([]);
  const [combined, setCombined] = useState("");
  const [active, setActive] = useState(0);
  const [engine, setEngine] = useState<EngineName>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"draft" | "translate" | null>(null);
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState(0);
  const canvasRef = useRef<DiagramHandle>(null);

  useEffect(() => {
    let nextLang: Lang = "vi";
    try {
      const stored = localStorage.getItem(LANG_KEY);
      if (stored === "en" || stored === "vi") nextLang = stored;
      setLang(nextLang);
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { text?: unknown; ir?: unknown };
        if (typeof saved.text === "string") setText(saved.text);
        if (typeof saved.ir === "string") {
          setIr(saved.ir);
          if (saved.ir.trim()) void restore(saved.ir, nextLang);
        }
      }
    } catch {
      /* keep the empty studio */
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, ir }));
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* private mode */
    }
  }, [ready, text, ir, lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", copy[lang].meta);
  }, [lang]);

  async function restore(savedIr: string, savedLang: Lang) {
    try {
      const result = await translateOnly({ data: { ir: savedIr, lang: savedLang } });
      if (result.ok) apply(result.diagrams, result.combinedXml, result.engine);
    } catch {
      /* the saved IR can be translated again by hand */
    }
  }

  function apply(next: DiagramFile[], combinedXml: string, nextEngine: EngineName) {
    setDiagrams(next);
    setCombined(combinedXml);
    setEngine(nextEngine);
    setActive(0);
    setToken((value) => value + 1);
    setError(null);
  }

  async function onBuild() {
    setBusy("draft");
    setError(null);
    try {
      const result = await buildFromText({ data: { text, lang } });
      if (result.ir) setIr(result.ir);
      if (!result.ok) {
        setError(result.error ?? copy[lang].buildFailed);
        return;
      }
      apply(result.diagrams, result.combinedXml, result.engine);
    } catch (error) {
      setError(messageOf(error, copy[lang].failed));
    } finally {
      setBusy(null);
    }
  }

  async function onTranslate(source = ir) {
    setBusy("translate");
    setError(null);
    try {
      const result = await translateOnly({ data: { ir: source, lang } });
      if (result.ir) setIr(result.ir);
      if (!result.ok) {
        setError(result.error ?? copy[lang].translateFailed);
        return;
      }
      apply(result.diagrams, result.combinedXml, result.engine);
    } catch (error) {
      setError(messageOf(error, copy[lang].failed));
    } finally {
      setBusy(null);
    }
  }

  async function selectTab(index: number) {
    if (index === active) return;
    const xml = await canvasRef.current?.getXml();
    if (xml) {
      setDiagrams((prev) => prev.map((item, i) => (i === active ? { ...item, xml } : item)));
    }
    setActive(index);
  }

  async function onDownload() {
    const current = diagrams[active];
    if (!current) return;
    const xml = (await canvasRef.current?.getXml()) ?? current.xml;
    download(fileSlug(current.name), xml);
  }

  const current = diagrams[active];
  const warnings = current?.warnings ?? [];
  const t = copy[lang];
  const samples = SAMPLES[lang];

  return (
    <main className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6 sm:flex-row sm:items-start sm:justify-between sm:py-8">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-muted">{t.eyebrow}</p>
            <h1 className="text-3xl font-semibold tracking-tight">text2BPMN</h1>
            <a className="w-fit text-sm font-medium underline" href="/text2BPMN-source.zip" download="text2BPMN-source.zip">
              Tải mã nguồn
            </a>
            <p className="max-w-2xl text-sm leading-relaxed text-muted">{t.lead}</p>
          </div>
          <div role="group" aria-label={t.language} className="flex shrink-0 gap-2">
            {(["vi", "en"] as const).map((code) => (
              <button
                key={code}
                type="button"
                aria-pressed={lang === code}
                onClick={() => setLang(code)}
                className={
                  lang === code
                    ? "min-h-11 min-w-11 rounded-sm bg-ink px-3 text-sm font-medium text-sheet"
                    : "min-h-11 min-w-11 rounded-sm border border-line bg-sheet px-3 text-sm font-medium text-ink"
                }
              >
                {code === "vi" ? "VI" : "EN"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
        <section className="flex flex-col gap-4 rounded-xl border border-line bg-sheet p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">
              <span className="mr-2 text-muted">1</span>
              {t.stepDescribe}
            </h2>
            <p className="text-sm text-muted">{t.describeHint}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {samples.map((sample) => (
              <Button key={sample.id} variant="ghost" onClick={() => setText(sample.text)} disabled={busy !== null}>
                {sample.title}
              </Button>
            ))}
          </div>
          <label className="sr-only" htmlFor="process-text">
            {t.describeLabel}
          </label>
          <textarea
            id="process-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t.placeholder}
            className="min-h-36 w-full resize-y rounded-sm border border-line bg-paper px-3 py-3 text-sm leading-relaxed text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => void onBuild()} disabled={busy !== null || !text.trim()}>
              {busy === "draft" ? t.drafting : t.build}
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => {
                setText(samples[0].text);
                setIr(SAMPLE_IR[lang]);
                void onTranslate(SAMPLE_IR[lang]);
              }}
            >
              {t.openSample}
            </Button>
          </div>
          <details className="text-sm text-muted">
            <summary className="cursor-pointer font-medium text-ink">{t.stepList}</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p>{t.irHint}</p>
              <label className="sr-only" htmlFor="process-ir">
                {t.irLabel}
              </label>
              <textarea
                id="process-ir"
                value={ir}
                spellCheck={false}
                onChange={(event) => setIr(event.target.value)}
                placeholder={IR_HINT[lang]}
                className="min-h-40 w-full resize-y rounded-sm border border-line bg-paper px-3 py-3 font-mono text-sm leading-relaxed text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              />
              <Button variant="secondary" onClick={() => void onTranslate()} disabled={busy !== null || !ir.trim()}>
                <RefreshCw className="size-4" aria-hidden="true" />
                {busy === "translate" ? t.translating : t.translate}
              </Button>
              <details>
                <summary className="cursor-pointer font-medium text-ink">{t.syntax}</summary>
                <pre className="mt-3 overflow-auto rounded-sm border border-line bg-paper p-3 font-mono text-sm leading-relaxed text-ink">
                  {IR_HINT[lang]}
                </pre>
              </details>
            </div>
          </details>
        </section>

        <section className="flex flex-col gap-4 rounded-xl border border-line bg-sheet p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">
                <span className="mr-2 text-muted">2</span>
                {t.stepDiagram}
              </h2>
              <p className="text-sm text-muted">{t.diagramHint}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => canvasRef.current?.fit()} disabled={!current}>
                {t.fit}
              </Button>
              <Button onClick={() => void onDownload()} disabled={!current}>
                <FileDown className="size-4" aria-hidden="true" />
                {t.download}
              </Button>
              {diagrams.length > 1 ? (
                <Button variant="secondary" onClick={() => download(t.downloadAllFile, combined)}>
                  {t.downloadAll}
                </Button>
              ) : null}
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-sm border border-ink px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}

          {diagrams.length > 1 ? (
            <div role="tablist" aria-label={t.tabs} className="flex flex-wrap gap-2">
              {diagrams.map((diagram, index) => (
                <button
                  key={`${diagram.name}-${index}`}
                  type="button"
                  role="tab"
                  aria-selected={index === active}
                  onClick={() => void selectTab(index)}
                  className={
                    index === active
                      ? "min-h-11 rounded-sm bg-ink px-3 text-sm font-medium text-sheet"
                      : "min-h-11 rounded-sm border border-line bg-sheet px-3 text-sm font-medium text-ink"
                  }
                >
                  {diagram.name}
                </button>
              ))}
            </div>
          ) : null}

          {current ? (
            <DiagramCanvas key={`${token}:${active}`} ref={canvasRef} xml={current.xml} failLabel={t.canvasFailed} />
          ) : (
            <div className="diagram-frame flex items-center justify-center rounded-sm border border-dashed border-line bg-paper px-6 text-center">
              <p className="max-w-sm text-sm text-muted">{t.empty}</p>
            </div>
          )}

          <div className="text-sm text-muted">
            {warnings.length > 0 ? (
              <ul className="mb-2 list-disc pl-5">
                {warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {current ? (
              <details>
                <summary className="cursor-pointer font-medium text-ink">{t.fileDetails}</summary>
                <div className="mt-2 flex flex-col gap-2">
                  {engine ? <p>{t.enginePython}</p> : null}
                  {diagrams.length > 1 ? <p>{t.combinedNote}</p> : null}
                  <p>{t.openIn}</p>
                </div>
              </details>
            ) : null}
          </div>
        </section>

        {current ? (
          <ScenarioPanel
            lang={lang}
            diagramKey={`${token}:${active}:${current.name}`}
            xml={current.xml}
            getXml={async () => (await canvasRef.current?.getXml()) ?? current.xml}
          />
        ) : null}
      </div>
    </main>
  );
}
