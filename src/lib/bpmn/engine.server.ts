import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pySource from "./ir_to_bpmn.py?raw";
import type { Lang } from "./lang";
import { translateIr, type TranslateResult } from "./translate";

export type EngineResult = TranslateResult & { engine: "python" | "javascript" };

async function translateWithPython(ir: string, lang: Lang): Promise<TranslateResult | null> {
  const file = join(tmpdir(), "luong-ir-to-bpmn.py");
  try {
    await writeFile(file, pySource, "utf8");
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const child = spawn("python3", [file], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LUONG_LANG: lang },
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 8000);
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > 2_000_000) child.kill("SIGKILL");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out) as TranslateResult;
        if (parsed && typeof parsed === "object" && "ok" in parsed) resolve(parsed);
        else resolve(null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.write(ir);
    child.stdin.end();
  });
}

export async function translatePreferPython(ir: string, lang: Lang = "vi"): Promise<EngineResult> {
  const py = await translateWithPython(ir, lang);
  if (py) return { ...py, engine: "python" };
  return { ...translateIr(ir, lang), engine: "javascript" };
}
