/** One verified injected order fault and bounded repair pilot. Dry-run by default. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { BpmnModdle } from "bpmn-moddle";
import { scopedOracle } from "./checker-e2e.mjs";

const ROOT=fileURLToPath(new URL("../",import.meta.url));
const OUT=path.join(ROOT,"docs/experiments/checker-fault-pilot-2026-11-17");
const BASE_DIR=path.join(ROOT,"docs/experiments/checker-e2e-2026-11-17");
const FIXTURES=path.join(ROOT,"docs/checker-e2e-fixtures.json");
const ENDPOINT="https://openrouter.ai/api/v1/chat/completions";
const MODELS=["meta-llama/llama-3.1-8b-instruct","qwen/qwen3-32b"];
const hash=(v)=>createHash("sha256").update(v).digest("hex");
const normalized=(v)=>(v??"").trim().replace(/\s+/g," ").toLowerCase();

async function sourceSnapshots(){
  const files={};
  for(const relative of ["scripts/checker-fault-pilot.mjs","scripts/checker-e2e.mjs","src/lib/bpmn/checker.server.ts","src/lib/bpmn/checker.ts","docs/checker-e2e-fixtures.json","package-lock.json"]){
    const absolute=path.join(ROOT,relative);const content=await fs.readFile(absolute);const stat=await fs.stat(absolute);
    files[relative]={sha256:hash(content),bytes:content.length,mtime:stat.mtime.toISOString()};
  }
  return {capturedAt:new Date().toISOString(),files};
}

async function makeVerifiedFault(){
  const fixtures=JSON.parse(await fs.readFile(FIXTURES,"utf8"));
  const fixture=fixtures.fixtures.find(f=>f.id==="order-sequence");
  const recorded=JSON.parse(await fs.readFile(path.join(BASE_DIR,"results.json"),"utf8"));
  const base=recorded.find(r=>r.fixtureId===fixture.id);
  assert.equal(base.status,"completed","The natural E2E base must already be completed.");
  assert.equal(base.text,fixture.text,"The source must remain exactly the same.");
  assert.deepEqual(base.requirements,fixture.requirements.map(({oracle:_oracle,...r})=>r));
  const sourceHash=hash(JSON.stringify(fixture));
  const xml=await fs.readFile(path.join(BASE_DIR,fixture.id,"generated.bpmn"),"utf8");
  assert.equal(hash(xml),base.candidateSha256,"Saved base candidate fingerprint mismatch.");
  const before=await scopedOracle(xml,fixture.requirements);
  assert.ok(before.length===2&&before.every(r=>r.status==="pass"),"Both fixed source properties must pass on the base; this is not whole-model correctness.");
  const moddle=new BpmnModdle();const parsed=await moddle.fromXML(xml);
  assert.equal(parsed.warnings.length,0);
  const process=parsed.rootElement.rootElements.find(e=>e.$type==="bpmn:Process");
  const elements=process.flowElements;
  const nodes=elements.filter(e=>e.$type!=="bpmn:SequenceFlow");
  const flows=elements.filter(e=>e.$type==="bpmn:SequenceFlow");
  const verify=nodes.filter(n=>normalized(n.name)==="verify order");
  const dispatch=nodes.filter(n=>normalized(n.name)==="dispatch order");
  assert.equal(verify.length,1);assert.equal(dispatch.length,1);
  const a=verify[0],b=dispatch[0];
  assert.ok(flows.some(f=>f.sourceRef.id===a.id&&f.targetRef.id===b.id),"Mutation requires the original adjacent Verify→Dispatch order.");
  const oldEdges=flows.map(f=>({id:f.id,source:f.sourceRef.id,target:f.targetRef.id}));
  const namesBefore=nodes.map(n=>({id:n.id,name:n.name??null}));
  const shapeBounds=(root)=>(root.diagrams??[]).flatMap(d=>(d.plane?.planeElement??[]).filter(e=>e.$type==="bpmndi:BPMNShape").map(e=>({id:e.id,elementId:e.bpmnElement?.id,x:e.bounds?.x,y:e.bounds?.y,width:e.bounds?.width,height:e.bounds?.height})));
  const originalShapeBounds=shapeBounds(parsed.rootElement);
  const swap=(node)=>node.id===a.id?b:node.id===b.id?a:node;
  for(const flow of flows){flow.sourceRef=swap(flow.sourceRef);flow.targetRef=swap(flow.targetRef);}
  for(const node of nodes){node.incoming=flows.filter(f=>f.targetRef.id===node.id);node.outgoing=flows.filter(f=>f.sourceRef.id===node.id);}
  // Retain task names, shape IDs, shape bounds and pool/lane representation.
  // Reconnect edge waypoints to the actual swapped endpoints, rather than
  // leave arrows visibly attached to nodes that their XML no longer names.
  for(const diagram of parsed.rootElement.diagrams??[]){
    const plane=diagram.plane?.planeElement??[];
    const shapes=new Map(plane.filter(e=>e.$type==="bpmndi:BPMNShape").map(e=>[e.bpmnElement?.id,e]));
    for(const edge of plane.filter(e=>e.$type==="bpmndi:BPMNEdge")){
      const flow=flows.find(f=>f.id===edge.bpmnElement?.id);if(!flow)continue;
      const src=shapes.get(flow.sourceRef.id)?.bounds,dst=shapes.get(flow.targetRef.id)?.bounds;
      if(src&&dst)edge.waypoint=[moddle.create("dc:Point",{x:src.x+src.width/2,y:src.y+src.height/2}),moddle.create("dc:Point",{x:dst.x+dst.width/2,y:dst.y+dst.height/2})];
    }
  }
  assert.deepEqual(nodes.map(n=>({id:n.id,name:n.name??null})),namesBefore,"Names must not change.");
  const mutated=(await moddle.toXML(parsed.rootElement,{format:true})).xml;
  const reparsed=await new BpmnModdle().fromXML(mutated);
  assert.equal(reparsed.warnings.length,0,"Serialized mutation must parse without warnings.");
  assert.deepEqual(shapeBounds(reparsed.rootElement),originalShapeBounds,"Shape identities and bounds must remain unchanged.");
  const after=await scopedOracle(mutated,fixture.requirements);
  assert.ok(after.length===2&&after.every(r=>r.status==="fail"&&r.witness?.edgeReplayVerified),"The mutation must actually violate both target properties with replayed witness edges.");
  assert.equal(hash(JSON.stringify(fixture)),sourceHash,"Source and fixed target specifications must not be mutated.");
  return {fixture,baseXml:xml,mutantXml:mutated,baseOracle:before,mutantOracle:after,baseCandidateSha256:hash(xml),mutantCandidateSha256:hash(mutated),sourceFixtureSha256:sourceHash,mutation:{kind:"swap-adjacent-activities-by-flow-rewiring",activityIds:[a.id,b.id],namesPreserved:true,shapeBoundsPreserved:true,edgeWaypointsReconnected:true,oldEdges,newEdges:flows.map(f=>({id:f.id,source:f.sourceRef.id,target:f.targetRef.id}))}};
}

async function main(){
  const fault=await makeVerifiedFault();
  if(!process.argv.includes("--run")){
    console.log(JSON.stringify({mode:process.argv.includes("--self-test")?"offline-mutation-self-test":"dry-run",source:fault.fixture.id,baseOracle:fault.baseOracle.map(r=>({id:r.requirementId,status:r.status})),mutantOracle:fault.mutantOracle.map(r=>({id:r.requirementId,status:r.status,witness:r.witness})),mutation:fault.mutation,maxCalls:10,budgetUsd:0.5,notes:"No API calls. Explicit --run evaluates six checker configurations, proposes repair only from actual strong/P2 fail, and rechecks the proposal with the scoped oracle plus one strong/P2 call. Injected-fault pilot, not natural-error performance."},null,2));return;
  }
  if(!process.env.OPENROUTER_API_KEY)throw new Error("Missing OPENROUTER_API_KEY; no paid call admitted.");
  await fs.mkdir(OUT,{recursive:true});
  try{await fs.access(path.join(OUT,"manifest.json"));throw new Error("Existing fault-pilot artifacts found; refusing to overwrite or pay twice.");}catch(e){if(e.code!=="ENOENT")throw e;}
  process.env.OPENROUTER_LIGHT_MODEL=MODELS[0];process.env.OPENROUTER_STRONG_MODEL=MODELS[1];
  process.env.OPENROUTER_CHECKER_ENABLED="true";process.env.OPENROUTER_CHECKER_PROVIDER="DeepInfra";
  process.env.OPENROUTER_CHECKER_MAX_TOKENS="4000";process.env.OPENROUTER_CHECKER_REQUEST_BUDGET="10";
  const ledger=[];let unknownReservation=0;let stage="setup";
  const manifest={status:"running",startedAt:new Date().toISOString(),maxCalls:10,budgetUsd:0.5,models:MODELS,provider:"DeepInfra",sourceSnapshotsAtStart:await sourceSnapshots(),baseCandidateSha256:fault.baseCandidateSha256,mutantCandidateSha256:fault.mutantCandidateSha256,sourceFixtureSha256:fault.sourceFixtureSha256,scope:"One deterministic injected order fault, verified against two fixed source properties on a previously generated candidate. Base passing these properties does not imply whole-model correctness. Not a natural-error or model-superiority benchmark."};
  const result={source:fault.fixture.text,requirements:fault.fixture.requirements.map(({oracle:_oracle,...r})=>r),mutation:fault.mutation,baseOracle:fault.baseOracle,mutantOracle:fault.mutantOracle,reports:[],repair:null};
  const checkpoint=async()=>{
    await fs.writeFile(path.join(OUT,"manifest.json"),JSON.stringify(manifest,null,2));
    await fs.writeFile(path.join(OUT,"results.json"),JSON.stringify(result,null,2));
    await fs.writeFile(path.join(OUT,"api-usage.json"),JSON.stringify({calls:ledger.length,reportedCostUsd:ledger.reduce((s,r)=>s+(r.costUsd??0),0),unknownCostCalls:ledger.filter(r=>r.costUsd===null).length,unknownCostConservativeReservationUsd:unknownReservation,requests:ledger},null,2));
  };
  await fs.writeFile(path.join(OUT,"base-generated.bpmn"),fault.baseXml);
  await fs.writeFile(path.join(OUT,"mutated-order.bpmn"),fault.mutantXml);
  await checkpoint();
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    const target=typeof url==="string"?url:url instanceof URL?url.href:url.url;
    if(target!==ENDPOINT)throw new Error("Unexpected network target blocked.");
    const body=JSON.parse(init.body);
    const currentSources=await sourceSnapshots();
    if(Object.entries(manifest.sourceSnapshotsAtStart.files).some(([file,initial])=>currentSources.files[file]?.sha256!==initial.sha256))throw new Error("Execution source changed after launch; further paid calls blocked.");
    if(!MODELS.includes(body.model)||ledger.length>=10)throw new Error("Unbudgeted model or call-count cap reached.");
    body.provider={order:["DeepInfra"],allow_fallbacks:false,require_parameters:true};
    if(body.model.startsWith("qwen/"))body.reasoning={enabled:false};
    const promptBytes=Buffer.byteLength(JSON.stringify(body.messages),"utf8");
    const reserve=(promptBytes+8192)/1e6+(Number(body.max_tokens)||4000)*2/1e6;
    if(ledger.reduce((s,r)=>s+(r.costUsd??0),0)+unknownReservation+reserve>0.5)throw new Error("Conservative $0.50 admission budget exceeded.");
    const entry={index:ledger.length+1,stage,requestedModel:body.model,providerRequested:"DeepInfra",temperature:body.temperature,maxTokens:body.max_tokens,reasoning:body.reasoning??null,promptSha256:hash(JSON.stringify(body.messages)),promptBytes,admissionReservationUsd:reserve,costUsd:null};
    ledger.push(entry);const began=performance.now();
    try{
      const response=await nativeFetch(url,{...init,body:JSON.stringify(body)});entry.httpStatus=response.status;
      try{const raw=await response.clone().json();entry.provider=raw.provider??null;entry.effectiveModel=raw.model??null;entry.usage=raw.usage??null;entry.finishReason=raw.choices?.[0]?.finish_reason??null;entry.costUsd=typeof raw.usage?.cost==="number"&&Number.isFinite(raw.usage.cost)&&raw.usage.cost>=0?raw.usage.cost:null;}catch{entry.parseError=true;}
      entry.latencyMs=Math.round(performance.now()-began);
      if(entry.costUsd===null)unknownReservation+=reserve;await checkpoint();return response;
    }catch(e){entry.errorType=e.name;entry.latencyMs=Math.round(performance.now()-began);unknownReservation+=reserve;await checkpoint();throw new Error("Fault pilot API request failed; see sanitized usage ledger.");}
  };
  let server;
  try{
    server=await createServer({root:ROOT,configFile:false,server:{middlewareMode:true},appType:"custom",logLevel:"error"});
    const checker=await server.ssrLoadModule("/src/lib/bpmn/checker.server.ts");
    const runtime={admission:{busy:false,requests:0}};
    const input={text:result.source,xml:fault.mutantXml,requirements:result.requirements};
    stage="six-configurations-on-verified-mutant";console.log("Running six configurations on the one verified order fault…");
    result.reports=(await checker.checkerAblation(input,runtime)).reports;await checkpoint();
    const strongP2=result.reports.find(r=>r.runs[0]?.tier==="strong"&&r.runs[0]?.variant==="P2");
    if(strongP2?.status==="fail"){
      stage="repair-proposal";console.log("Strong P2 flagged the fault; requesting one bounded repair…");
      const proposal=await checker.proposeRepair({...input,report:strongP2},runtime);
      await fs.writeFile(path.join(OUT,"repair-proposal-unverified.bpmn"),proposal.xml);
      const oracle=await scopedOracle(proposal.xml,fault.fixture.requirements);
      result.repair={proposal,proposalSha256:hash(proposal.xml),oracle,allOriginalSupportedPropertiesPass:oracle.length===fault.baseOracle.length&&oracle.every(r=>r.status==="pass"),scope:"Only these fixed supported properties are rechecked; no whole-process or global semantic certification, no automatic application."};await checkpoint();
      stage="strong-P2-recheck-proposal";
      result.repair.strongRecheck=await checker.checkCandidate({...input,xml:proposal.xml,variant:"P2",strategy:"strong"},runtime);
    }else result.repair={skipped:true,reason:"Actual strong/P2 report did not fail; no repair was fabricated or selected from another configuration."};
    manifest.status="completed";
  }catch(e){manifest.status="stopped";manifest.error=e instanceof Error?e.message:"Fault pilot stopped";}
  finally{
    globalThis.fetch=nativeFetch;await server?.close();manifest.finishedAt=new Date().toISOString();
    manifest.sourceSnapshotsAtFinish=await sourceSnapshots();
    manifest.sourceFreezeViolations=Object.entries(manifest.sourceSnapshotsAtStart.files).filter(([file,initial])=>manifest.sourceSnapshotsAtFinish.files[file]?.sha256!==initial.sha256).map(([file])=>file);
    manifest.sourceFreezeVerifiedAtFinish=manifest.sourceFreezeViolations.length===0;
    if(!manifest.sourceFreezeVerifiedAtFinish){manifest.status="stopped";manifest.error="Execution sources changed after startup; inspect sourceFreezeViolations.";}
    await checkpoint();
  }
  const calls=ledger.length,cost=ledger.reduce((s,r)=>s+(r.costUsd??0),0);
  const table=result.reports.map(r=>{const run=r.runs[0];return `| ${run.tier} | ${run.variant} | ${r.status} | ${run.assessments.map(a=>`${a.requirementId}: ${a.status}`).join("; ")} |`;}).join("\n");
  const summary=`# One verified injected order fault and bounded repair\n\nStatus: ${manifest.status}. ${calls} API calls; provider-reported cost $${cost.toFixed(8)}; ${ledger.filter(r=>r.costUsd===null).length} unknown-cost calls. Unknown cost is not free.\n\nBase source: order-sequence from the three-source controlled synthetic E2E pilot, not PET or a real-business dataset. The base passes the two tested properties only. Rewiring swaps Verify order and Dispatch order while preserving activity names and shape bounds. Both fixed requirements fail after mutation with sequence-flow-replayed witnesses. No target labels were inferred from a checker.\n\n| Tier | Prompt | Overall judgment | Per-requirement judgments |\n|---|---|---|---|\n${table}\n\nThis single injected fault demonstrates behavior on a known scoped violation, not recall on natural errors or statistical model superiority. The six configurations share the exact same mutant and source requirements.\n\nRepair: ${result.repair?.skipped?result.repair.reason:result.repair?.oracle?`Scoped oracle after repair: ${result.repair.oracle.map(o=>`${o.requirementId}=${o.status}`).join(", ")}. All original supported properties pass: ${result.repair.allOriginalSupportedPropertiesPass}.` : "No complete repair result; inspect manifest/results."}\n\nA proposal remains marked unverified in the application and is not automatically applied. Passing the two oracle assertions is not whole-model correctness; unknown/unsupported semantics are not certified. API settings, costs, timing, source hashes, original/mutated/repaired BPMN and all judgments are retained for audit. No paid reruns were used to select favorable outputs.\n`;
  await fs.writeFile(path.join(OUT,"README.md"),summary);
  console.log(JSON.stringify({status:manifest.status,calls,reportedCostUsd:cost,output:OUT}));
  if(manifest.status!=="completed")process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
