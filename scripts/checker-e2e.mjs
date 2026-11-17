/** Bounded paid E2E pilot. No credentials are imported, persisted or printed. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { BpmnModdle } from "bpmn-moddle";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "docs/experiments/checker-e2e-2026-11-17");
const FIXTURES = path.join(ROOT, "docs/checker-e2e-fixtures.json");
const MAX_CALLS = 40;
const BUDGET_USD = 1;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODELS = ["qwen/qwen3.5-9b", "meta-llama/llama-3.1-8b-instruct", "qwen/qwen3-32b"];
const normalize = (v) => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const hash = (v) => createHash("sha256").update(v).digest("hex");

const SOURCE_PATHS = [
  "scripts/checker-e2e.mjs", "docs/checker-e2e-fixtures.json",
  "src/lib/bpmn/build.server.ts", "src/lib/bpmn/checker.server.ts",
  "src/lib/bpmn/checker.ts", "src/lib/bpmn/checker-types.ts",
  "src/lib/bpmn/ircheck.ts", "src/lib/bpmn/engine.server.ts",
  "src/lib/bpmn/translate.ts", "src/lib/bpmn/ir_to_bpmn.py",
  "src/lib/bpmn/features.server.ts", "src/lib/bpmn/features.ts", "src/lib/bpmn/prompts.ts",
  "package-lock.json",
];
async function sourceSnapshots() {
  const files={};
  for(const relative of SOURCE_PATHS){
    const absolute=path.join(ROOT,relative);
    const content=await fs.readFile(absolute);
    const stat=await fs.stat(absolute);
    files[relative]={sha256:hash(content),bytes:content.length,mtime:stat.mtime.toISOString()};
  }
  return {capturedAt:new Date().toISOString(),files};
}

/** Offline replay only: never regenerates candidates, calls models, or changes targets. */
async function replayOracle(fixtures) {
  const manifest=JSON.parse(await fs.readFile(path.join(OUT,"manifest.json"),"utf8"));
  if(manifest.status==="running"||!manifest.finishedAt)throw new Error("Experiment has not finished; replay refuses to touch live artifacts.");
  const auditPath=path.join(OUT,"oracle-replay-audit.json");
  try{await fs.access(auditPath);throw new Error("Oracle replay audit already exists; refusing to overwrite original replay history.");}catch(e){if(e.code!=="ENOENT")throw e;}
  const beforeText=await fs.readFile(path.join(OUT,"results.json"),"utf8");
  const records=JSON.parse(beforeText);
  const ledgerFile=JSON.parse(await fs.readFile(path.join(OUT,"api-usage.json"),"utf8"));
  const audit={
    replayedAt:new Date().toISOString(),networkCalls:0,
    disclosure:"The oracle implementation was corrected after the original paid process started: shared-end/alternative XOR merges and the translator's one-participant/no-message collaboration wrapper had been classified too conservatively. Replay permits only a single participant referencing the sole process, with no message flows; multiple pools/processes/message interaction remain unsupported. The original run did not freeze execution-source hashes at startup. These hashes are captured after the run for offline replay, not evidence of the source originally loaded. Only oracle outcomes and derived comparison/summary artifacts are recomputed; checker outputs, candidates, source requirements and billing are unchanged.",
    previousResultsSha256:hash(beforeText),previousManifest:structuredClone(manifest),
    previousOracle:records.map(r=>({fixtureId:r.fixtureId,oracle:r.oracle??null})),
    previousComparisons:JSON.parse(await fs.readFile(path.join(OUT,"comparisons.json"),"utf8")),
    finalSourceSnapshots:await sourceSnapshots(),
  };
  for(const record of records){
    const fixture=fixtures.fixtures.find(f=>f.id===record.fixtureId);
    if(!fixture||fixture.text!==record.text)throw new Error("Fixture source changed; replay must not change evaluation targets.");
    const expected=fixture.requirements.map(r=>({requirementId:r.id,...r.oracle}));
    if(JSON.stringify(expected)!==JSON.stringify(record.oracleSpecification))throw new Error("Oracle target specification changed; replay stopped.");
    const xml=record.generation?.combinedXml;
    if(!xml)continue;
    if(hash(xml)!==record.candidateSha256)throw new Error("Candidate hash mismatch; replay stopped.");
    const onDisk=await fs.readFile(path.join(OUT,record.fixtureId,"generated.bpmn"),"utf8");
    if(onDisk!==xml)throw new Error("Saved candidate differs from result snapshot; replay stopped.");
    record.oracle=await scopedOracle(xml,fixture.requirements);
  }
  audit.replayedOracle=records.map(r=>({fixtureId:r.fixtureId,oracle:r.oracle??null}));
  // Write history first. A partial replay remains identifiable and never hides old outcomes.
  await fs.writeFile(auditPath,JSON.stringify(audit,null,2),{flag:"wx"});
  manifest.oracleReplay={replayedAt:audit.replayedAt,disclosure:audit.disclosure,auditFile:"oracle-replay-audit.json"};
  manifest.sourceFreezeStatus=manifest.sourceSnapshotsAtStart?"startup snapshots present; see replay audit":"not frozen at original startup; final-source hashes only";
  manifest.sourceSnapshotsAtFinal=audit.finalSourceSnapshots;
  await fs.writeFile(path.join(OUT,"results.json"),JSON.stringify(records,null,2));
  await fs.writeFile(path.join(OUT,"manifest.json"),JSON.stringify(manifest,null,2));
  const {comparisons}=await writeSummary(records,ledgerFile.requests,manifest);
  console.log(JSON.stringify({mode:"offline-oracle-replay",networkCalls:0,fixtures:records.length,comparisonRows:comparisons.length,audit:auditPath}));
}

/** Exhaustive only for this small, acyclic, single-process sequential/XOR graph subset. */
export async function scopedOracle(xml, requirements) {
  const unknown = (reason) => requirements.map((r) => ({ requirementId: r.id, status: "unknown", reason, witness: null }));
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return unknown("Entities/DOCTYPE unsupported.");
  let parsed;
  try { parsed = await new BpmnModdle().fromXML(xml); } catch { return unknown("BPMN XML could not be parsed."); }
  if (parsed.warnings?.length) return unknown("BPMN parser warnings make the graph uncertain.");
  const roots = parsed.rootElement.rootElements ?? [];
  const processes = roots.filter((e) => e.$type === "bpmn:Process");
  const collaborations = roots.filter((e) => e.$type === "bpmn:Collaboration");
  if (processes.length !== 1 || collaborations.length > 1) return unknown("Only one process and at most one single-pool wrapper are supported.");
  // The translator wraps a sole process in a collaboration/pool even without
  // interactions. That wrapper adds no token semantics and is supported only
  // when it references this process and has no messages or other participants.
  if (collaborations.some((c) => c.participants?.length !== 1 || c.participants[0].processRef?.id !== processes[0].id || c.messageFlows?.length)) return unknown("Multiple pools, message flows or unresolved pool-process links are unsupported.");
  const elements = processes[0].flowElements ?? [];
  const supported = new Set(["bpmn:StartEvent", "bpmn:EndEvent", "bpmn:Task", "bpmn:UserTask", "bpmn:ServiceTask", "bpmn:ExclusiveGateway", "bpmn:SequenceFlow"]);
  if (!elements.length || elements.length > 120 || elements.some((e) => !supported.has(e.$type) || e.eventDefinitions?.length || e.loopCharacteristics)) return unknown("Unsupported element, event/loop semantics, or graph size.");
  const flows = elements.filter((e) => e.$type === "bpmn:SequenceFlow");
  if (flows.some((e) => e.conditionExpression)) return unknown("Executable data guards are outside this oracle.");
  const nodes = elements.filter((e) => e.$type !== "bpmn:SequenceFlow");
  const nodeMap = new Map(nodes.map((e) => [e.id, e]));
  if (nodes.length !== nodeMap.size || nodes.length > 60 || flows.some((e) => !nodeMap.has(e.sourceRef?.id) || !nodeMap.has(e.targetRef?.id))) return unknown("Ambiguous identifiers, dangling flow, or excessive nodes.");
  const starts = nodes.filter((e) => e.$type === "bpmn:StartEvent");
  if (starts.length !== 1) return unknown("Exactly one plain start event is required.");
  const outgoing = (id) => flows.filter((f) => f.sourceRef.id === id);
  // With one start, no AND/inclusive gateways and no loops, exactly one token
  // follows a path; alternative incoming flows into a task/end are safe merges.
  if (nodes.some((n) => outgoing(n.id).length > 1 && n.$type !== "bpmn:ExclusiveGateway")) return unknown("Implicit branching is not supported.");
  const paths = [];
  let reason = null;
  let visits = 0;
  function visit(id, ids, edgeIds) {
    if (reason) return;
    visits += 1;
    if (visits > 2000 || paths.length >= 256) { reason = "Path enumeration bound reached."; return; }
    if (ids.includes(id)) { reason = "Cycles are not supported."; return; }
    const next = [...ids, id];
    const out = outgoing(id);
    if (nodeMap.get(id).$type === "bpmn:EndEvent") {
      if (out.length) reason = "End event has outgoing flow.";
      else paths.push({ nodes: next, flows: edgeIds });
    } else if (!out.length) reason = "Reachable non-end dead end; termination assumptions unsupported.";
    else for (const edge of out) visit(edge.targetRef.id, next, [...edgeIds, edge.id]);
  }
  visit(starts[0].id, [], []);
  if (reason || !paths.length) return unknown(reason ?? "No complete execution found.");
  const reached = new Set(paths.flatMap((p) => p.nodes));
  if (nodes.some((n) => !reached.has(n.id))) return unknown("Unreachable graph elements require separate analysis.");
  const witness = (p) => ({ ...p, edgeReplayVerified: p.flows.every((fid, i) => flows.some((f) => f.id === fid && f.sourceRef.id === p.nodes[i] && f.targetRef.id === p.nodes[i + 1])) });
  return requirements.map((req) => {
    const rule = req.oracle;
    const mapping = rule?.labels.map((label) => nodes.filter((n) => normalize(n.name) === normalize(label) && /Task$/.test(n.$type))) ?? [];
    if (!rule || mapping.some((m) => m.length !== 1)) return { requirementId: req.id, status: "unknown", reason: "Exact task-label mapping absent or ambiguous; no guessed match.", witness: null };
    const ids = mapping.map((m) => m[0].id);
    if (rule.kind === "conditional-eventual" && !paths.some((p) => p.nodes.includes(ids[0]))) return { requirementId: req.id, status: "unknown", reason: "Antecedent has no reachable witness; no vacuous pass.", witness: null };
    const bad = paths.find((p) => {
      const positions = ids.map((id) => p.nodes.indexOf(id));
      if (rule.kind === "mandatory-sequence") return positions.some((pos, i) => pos < 0 || (i > 0 && pos <= positions[i - 1]));
      if (rule.kind === "forbidden-order") return positions[0] >= 0 && positions[1] > positions[0];
      if (rule.kind === "conditional-eventual") return positions[0] >= 0 && positions[1] <= positions[0];
      if (rule.kind === "requires-prior") return positions[0] >= 0 && (positions[1] < 0 || positions[1] >= positions[0]);
      return false;
    });
    if (!["mandatory-sequence", "forbidden-order", "conditional-eventual", "requires-prior"].includes(rule.kind)) return { requirementId: req.id, status: "unknown", reason: "Unsupported assertion kind.", witness: null };
    return { requirementId: req.id, status: bad ? "fail" : "pass", reason: "All complete paths enumerated under published sequential/XOR assumptions; not whole-model or text-interpretation correctness.", mappedTaskIds: ids, completePaths: paths.length, witness: bad ? witness(bad) : null, pathWitnesses: paths.map(witness) };
  });
}

async function selfTest() {
  const xml = (edges, middle = '<bpmn:task id="a" name="Receive"/><bpmn:task id="b" name="Pay"/>') => `<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="test"><bpmn:process id="p"><bpmn:startEvent id="s"/>${middle}<bpmn:endEvent id="e"/>${edges.map(([s,t],i)=>`<bpmn:sequenceFlow id="f${i}" sourceRef="${s}" targetRef="${t}"/>`).join("")}</bpmn:process></bpmn:definitions>`;
  const req = [{id:"R1",oracle:{kind:"mandatory-sequence",labels:["Receive","Pay"]}}];
  assert.equal((await scopedOracle(xml([["s","a"],["a","b"],["b","e"]]),req))[0].status,"pass");
  const failed = (await scopedOracle(xml([["s","b"],["b","a"],["a","e"]]),req))[0];
  assert.equal(failed.status,"fail");assert.equal(failed.witness.edgeReplayVerified,true);
  assert.equal((await scopedOracle(xml([["s","a"],["a","b"],["b","a"]]),req))[0].status,"unknown");
  assert.equal((await scopedOracle(xml([["s","a"],["a","b"],["b","e"]]),[{id:"R2",oracle:{kind:"mandatory-sequence",labels:["Missing"]}}]))[0].status,"unknown");
  const branches='<bpmn:exclusiveGateway id="x"/><bpmn:task id="a" name="Reject"/><bpmn:task id="b" name="Pay"/><bpmn:task id="n" name="Notify"/>';
  const xorReq=[{id:"X1",oracle:{kind:"forbidden-order",labels:["Reject","Pay"]}},{id:"X2",oracle:{kind:"conditional-eventual",labels:["Reject","Notify"]}}];
  const xorPass=await scopedOracle(xml([["s","x"],["x","a"],["a","n"],["n","e"],["x","b"],["b","e"]],branches),xorReq);
  assert.deepEqual(xorPass.map(r=>r.status),["pass","pass"]);
  const xorFail=await scopedOracle(xml([["s","x"],["x","a"],["a","b"],["b","e"],["x","n"],["n","e"]],branches),xorReq);
  assert.deepEqual(xorFail.map(r=>r.status),["fail","fail"]);
  assert.ok(xorFail.every(r=>r.witness.edgeReplayVerified));
  const plain=xml([["s","a"],["a","b"],["b","e"]]);
  const wrapper=(participants,messages="")=>plain.replace("</bpmn:definitions>",`<bpmn:collaboration id="c">${participants}${messages}</bpmn:collaboration></bpmn:definitions>`);
  const participant='<bpmn:participant id="pool" processRef="p"/>';
  assert.equal((await scopedOracle(wrapper(participant),req))[0].status,"pass");
  assert.equal((await scopedOracle(wrapper(participant+'<bpmn:participant id="pool2"/>'),req))[0].status,"unknown");
  assert.equal((await scopedOracle(wrapper(participant,'<bpmn:messageFlow id="m" sourceRef="a" targetRef="b"/>'),req))[0].status,"unknown");
  console.log("Oracle self-test passed: order/XOR pass/fail, replay, cycle/missing labels, single-pool wrapper and rejected multipool/messages.");
}

async function writeSummary(records, ledger, manifest) {
  const config=manifest.config;
  const comparisons=[];
  for(const record of records)for(const report of record.reports??[])for(const run of report.runs)for(const a of run.assessments){const oracle=record.oracle?.find(o=>o.requirementId===a.requirementId);comparisons.push({fixtureId:record.fixtureId,requirementId:a.requirementId,tier:run.tier,variant:run.variant,checkerStatus:a.status,oracleStatus:oracle?.status??"unknown",supported:oracle?.status==="pass"||oracle?.status==="fail",agreement:oracle?.status==="unknown"||!oracle?null:a.status===oracle.status});}
  const cost=ledger.reduce((s,r)=>s+(r.costUsd??0),0);const supported=comparisons.filter(c=>c.supported);
  const summary=`# Bounded Text2BPMN E2E pilot\n\nStatus: ${manifest.status}. ${records.filter(r=>r.status==="completed").length}/3 controlled synthetic fixtures completed.\n\nGenerator: ${config.generator}. Checkers: ${config.light} and ${config.strong}, P0/P1/P2 on identical emitted BPMN snapshots. Provider fixed to DeepInfra, fallback disabled.\n\n${ledger.length} API calls; provider-reported cost $${cost.toFixed(8)}; ${ledger.filter(r=>r.costUsd===null).length} calls with unknown cost. Unknown cost is not free. Token/latency/request settings are in api-usage.json, including generation retries and feature extraction. The $1 guard is conservative admission estimation, not a provider-side billing guarantee.\n\nScoped oracle comparison: ${supported.length} supported requirement/configuration rows, ${supported.filter(c=>c.agreement).length} exact verdict agreements, ${comparisons.length-supported.length} rows outside oracle coverage. These are repeated judgments on only three sources, not independent examples or a global accuracy estimate. No model-superiority or statistical-significance claim.\n\nThe oracle inspects actual generated BPMN paths under explicit sequential/XOR assumptions. Exact-label mismatch, parsing warnings, cycles, data guards, concurrency and unsupported elements yield unknown; witnesses replay against actual sequence-flow IDs. It does not establish whole-model correctness or the correctness of text interpretation.\n\nThese are genuine outputs of the existing generator for controlled synthetic input, not mutations, PET, or a real-business dataset. No repair was performed in this first run; before/after repair benefit remains unmeasured. App/browser delivery is verified separately.\n`;
  await fs.writeFile(path.join(OUT,"comparisons.json"),JSON.stringify(comparisons,null,2));
  await fs.writeFile(path.join(OUT,"README.md"),summary + (manifest.oracleReplay ? `\n## Oracle implementation replay\n\n${manifest.oracleReplay.disclosure}\n\nReplay timestamp: ${manifest.oracleReplay.replayedAt}. The generated candidates, paid checker judgments, prompts and API ledger were not rerun or reselected. Old oracle outcomes remain in oracle-replay-audit.json.\n` : ""));
  return {comparisons,cost};

}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const fixtures = JSON.parse(await fs.readFile(FIXTURES,"utf8"));
  assert.equal(fixtures.fixtures.length,3);
  for (const f of fixtures.fixtures) for (const r of f.requirements) assert.ok(f.text.includes(r.sourceQuote));
  if (process.argv.includes("--replay-oracle")) return replayOracle(fixtures);
  const config = {generator:process.env.OPENROUTER_MODEL || MODELS[0],light:process.env.OPENROUTER_LIGHT_MODEL || MODELS[1],strong:process.env.OPENROUTER_STRONG_MODEL || MODELS[2],provider:"DeepInfra",maxCalls:MAX_CALLS,budgetUsd:BUDGET_USD,fixtureVersion:fixtures.version};
  if (!process.argv.includes("--run")) {
    console.log(JSON.stringify({mode:"dry-run",fixtures:fixtures.fixtures.map(f=>f.id),config,notes:"No network or API calls. Run --self-test for oracle checks, --run explicitly for paid calls. Three generated candidates; 18 checker calls plus bounded generator retries/features. No repair calls in this pilot."},null,2));return;
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing; no model calls started.");
  if (!Object.values(config).filter(v=>typeof v==="string"&&v.includes("/")).every(v=>MODELS.includes(v))) throw new Error("Unexpected model; fixed-budget admission supports only the three declared IDs.");
  process.env.OPENROUTER_MODEL=config.generator;
  process.env.OPENROUTER_CHECKER_ENABLED="true";
  process.env.OPENROUTER_CHECKER_PROVIDER="DeepInfra";
  process.env.OPENROUTER_CHECKER_MAX_TOKENS="1200";
  process.env.OPENROUTER_CHECKER_REQUEST_BUDGET="30";
  await fs.mkdir(OUT,{recursive:true});
  try { await fs.access(path.join(OUT,"manifest.json")); throw new Error("Existing experiment artifacts found; preserve them rather than overwrite or pay twice."); } catch(e) { if(e.code!=="ENOENT")throw e; }
  const ledger=[];const records=[];let stage="setup";let fixtureId=null;let reservedUnknown=0;
  const manifest={startedAt:new Date().toISOString(),config,fixtureSha256:hash(await fs.readFile(FIXTURES)),sourceSnapshotsAtStart:await sourceSnapshots(),sourceSnapshotPhase:"Startup file contents before Vite SSR import; execution sources must remain frozen until completion.",scope:fixtures.scope,assumptions:"Oracle reads actual emitted BPMN, with exact task-label mapping, one acyclic sequential/XOR process, unconstrained external XOR choices, no data guards/concurrency/events. Unknown otherwise. No new human annotation. Not a PET or real-business benchmark.",status:"running"};
  const checkpoint=async()=>{
    await fs.writeFile(path.join(OUT,"manifest.json"),JSON.stringify(manifest,null,2));
    await fs.writeFile(path.join(OUT,"api-usage.json"),JSON.stringify({calls:ledger.length,reportedCostUsd:ledger.reduce((s,r)=>s+(r.costUsd??0),0),unknownCostCalls:ledger.filter(r=>r.costUsd===null).length,unknownCostConservativeReservationUsd:reservedUnknown,requests:ledger},null,2));
    await fs.writeFile(path.join(OUT,"results.json"),JSON.stringify(records,null,2));
  };
  await checkpoint();
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const target=typeof url==="string"?url:url instanceof URL?url.href:url.url;
    if(target!==ENDPOINT)throw new Error("Unexpected runner network target; blocked.");
    const body=JSON.parse(init.body);
    if(!MODELS.includes(body.model))throw new Error("Unbudgeted model blocked.");
    if(ledger.length>=MAX_CALLS)throw new Error("40-call safety cap reached.");
    body.provider={order:["DeepInfra"],allow_fallbacks:false,require_parameters:true};
    const promptBytes=Buffer.byteLength(JSON.stringify(body.messages),"utf8");
    // Deliberately above the pinned models' catalog rates: $1/M input, $2/M output.
    // UTF-8 bytes + 8192 overhead is an admission estimate, not a billing guarantee.
    const reservation=(promptBytes+8192)/1e6+(Number(body.max_tokens)||4000)*2/1e6;
    const spent=ledger.reduce((s,r)=>s+(r.costUsd??0),0)+reservedUnknown;
    if(spent+reservation>BUDGET_USD)throw new Error("Conservative $1 admission budget would be exceeded.");
    const entry={index:ledger.length+1,fixtureId,stage,requestedModel:body.model,providerRequested:"DeepInfra",temperature:body.temperature,maxTokens:body.max_tokens,reasoning:body.reasoning??null,promptSha256:hash(JSON.stringify(body.messages)),promptBytes,admissionReservationUsd:reservation,costUsd:null};
    ledger.push(entry);const began=performance.now();
    try {
      const response=await nativeFetch(url,{...init,body:JSON.stringify(body)});
      entry.httpStatus=response.status;entry.latencyMs=Math.round(performance.now()-began);
      try{const raw=await response.clone().json();entry.effectiveModel=raw.model??null;entry.provider=raw.provider??null;entry.usage=raw.usage??null;entry.finishReason=raw.choices?.[0]?.finish_reason??null;entry.costUsd=typeof raw.usage?.cost==="number"&&raw.usage.cost>=0?raw.usage.cost:null;}catch{entry.parseError=true;}
      if(entry.costUsd===null)reservedUnknown+=reservation;
      await checkpoint();return response;
    }catch(e){entry.latencyMs=Math.round(performance.now()-began);entry.errorType=e.name;reservedUnknown+=reservation;await checkpoint();throw new Error("Upstream E2E request failed; see sanitized ledger.");}
  };
  let server;
  try{
    server=await createServer({root:ROOT,configFile:false,server:{middlewareMode:true},appType:"custom",logLevel:"error"});
    const build=await server.ssrLoadModule("/src/lib/bpmn/build.server.ts");
    const checker=await server.ssrLoadModule("/src/lib/bpmn/checker.server.ts");
    const {parseIr}=await server.ssrLoadModule("/src/lib/bpmn/ircheck.ts");
    for(const fixture of fixtures.fixtures){
      fixtureId=fixture.id;stage="generation";
      const requirementInput=fixture.requirements.map(({oracle:_oracle,...r})=>r);
      const record={fixtureId,text:fixture.text,requirements:requirementInput,oracleSpecification:fixture.requirements.map(r=>({requirementId:r.id,...r.oracle})),generatedAt:new Date().toISOString()};records.push(record);
      console.log(`Generating ${fixtureId}…`);
      const generated=await build.buildFromDescription(fixture.text,"en");
      record.generation=generated;
      const ir=parseIr(generated.ir);record.irAudit={steps:[...ir.steps.values()],flows:ir.flows};
      const dir=path.join(OUT,fixtureId);await fs.mkdir(dir,{recursive:true});
      await fs.writeFile(path.join(dir,"generated.ir.txt"),generated.ir);
      await fs.writeFile(path.join(dir,"generated.bpmn"),generated.combinedXml);
      if(!generated.ok||!generated.combinedXml){record.status="generation-failed";await checkpoint();continue;}
      record.candidateSha256=hash(generated.combinedXml);
      record.oracle=await scopedOracle(generated.combinedXml,fixture.requirements);
      stage="checker-ablation";console.log(`Checking ${fixtureId}: six paired configurations…`);
      record.reports=(await checker.checkerAblation({text:fixture.text,xml:generated.combinedXml,requirements:requirementInput},{admission:{busy:false,requests:0}})).reports;
      record.status="completed";await checkpoint();
    }
    manifest.status="completed";
  }catch(e){manifest.status="stopped";manifest.error=e instanceof Error?e.message:"Experiment stopped";}
  finally{globalThis.fetch=nativeFetch;await server?.close();manifest.finishedAt=new Date().toISOString();await checkpoint();}
  const {cost}=await writeSummary(records,ledger,manifest);
  console.log(JSON.stringify({status:manifest.status,fixtures:records.length,calls:ledger.length,reportedCostUsd:cost,output:OUT}));
  if(manifest.status!=="completed")process.exitCode=1;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
