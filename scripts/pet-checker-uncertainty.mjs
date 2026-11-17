/**
 * Recompute document-clustered uncertainty from the saved PET benchmark results.
 * Offline only: this script reads results.jsonl and makes no network/API calls.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIR = path.join(ROOT, "docs/experiments/pet-flow-checker-v3");
const INPUT = path.join(DIR, "results.jsonl");
const OUTPUT = path.join(DIR, "uncertainty.json");
const REPLICATES = 20_000;
const SEED = 0x50455433;
const CONDITIONS = ["B0-E0", "B1-E0", "B0-E1", "B1-E1"];
const TIERS = ["light", "strong"];

const rows = (await fs.readFile(INPUT, "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
const testRows = rows.filter((row) => row.split === "test");
const docs = [...new Set(testRows.map((row) => row.documentId))].sort();
if (rows.length !== 720 || docs.length !== 36) {
  throw new Error(`Expected 720 calls and 36 test documents; found ${rows.length} and ${docs.length}.`);
}

function record(docId, tier, condition, kind) {
  const row = testRows.find((item) => item.documentId === docId && item.tier === tier && item.condition.id === condition && item.candidateKind === kind);
  if (!row) throw new Error(`Missing result: ${docId}/${tier}/${condition}/${kind}`);
  const usable = row.status === "pass" || row.status === "fail";
  return {
    exact: Number(usable && row.status === row.expectedStatus),
    covered: Number(usable),
    falsePass: Number(row.expectedStatus === "fail" && row.status === "pass"),
    falseFail: Number(row.expectedStatus === "pass" && row.status === "fail"),
  };
}

const metrics = {};
for (const tier of TIERS) for (const condition of CONDITIONS) {
  metrics[`${tier}/${condition}`] = docs.map((docId) => {
    const positive = record(docId, tier, condition, "supported-order");
    const negative = record(docId, tier, condition, "verified-counterexample");
    return Object.fromEntries(Object.keys(positive).map((key) => [key, (positive[key] + negative[key]) / 2]));
  });
}

let randomState = SEED;
function randomIndex(max) {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return Math.floor((randomState / 0x1_0000_0000) * max);
}
function percentile(sorted, p) {
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
function interval(values) {
  const estimate = values.reduce((sum, value) => sum + value, 0) / values.length;
  const samples = Array.from({ length: REPLICATES }, () => {
    let sum = 0;
    for (let i = 0; i < docs.length; i += 1) sum += values[randomIndex(values.length)];
    return sum / docs.length;
  }).sort((a, b) => a - b);
  return { estimate, lower95: percentile(samples, 0.025), upper95: percentile(samples, 0.975) };
}

const estimates = {};
for (const [key, perDoc] of Object.entries(metrics)) {
  estimates[key] = Object.fromEntries(["exact", "covered", "falsePass", "falseFail"].map((metric) => [metric, interval(perDoc.map((value) => value[metric]))]));
}
const pairedDeltas = {};
for (const condition of CONDITIONS) {
  const light = metrics[`light/${condition}`], strong = metrics[`strong/${condition}`];
  pairedDeltas[`strong-minus-light/${condition}`] = Object.fromEntries(["exact", "covered", "falsePass", "falseFail"].map((metric) => [metric, interval(strong.map((value, i) => value[metric] - light[i][metric]))]));
}

const output = {
  method: "Paired nonparametric percentile bootstrap resampling the 36 held-out source documents as clusters; each sampled document contributes its supported-order and verified-counterexample candidates together. 20,000 replicates; fixed LCG seed 0x50455433; two-sided 95% percentile intervals. Per-document scores are averages over the two candidates. No model/candidate call is repeated.",
  unit: "source document (36 independent held-out documents; 72 candidates per model/condition)",
  replicateCount: REPLICATES,
  seed: "0x50455433",
  estimates,
  pairedDeltas,
};
await fs.writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} from ${rows.length} saved calls (${docs.length} test-document clusters).`);
