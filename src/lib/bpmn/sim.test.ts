import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPreset, parseBpmn, simulate, toCsv, toXes } from "./sim.ts";

const LEAVE = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="P" name="Leave">
    <bpmn:laneSet>
      <bpmn:lane id="L1" name="Employee">
        <bpmn:flowNodeRef>s</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>a</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="L2" name="Manager">
        <bpmn:flowNodeRef>g</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="s" name="Start"/>
    <bpmn:userTask id="a" name="Submit"/>
    <bpmn:exclusiveGateway id="g" name="Approved?"/>
    <bpmn:userTask id="b" name="Record"/>
    <bpmn:userTask id="c" name="Reject"/>
    <bpmn:endEvent id="e1" name="Done"/>
    <bpmn:endEvent id="e2" name="Stopped"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="a"/>
    <bpmn:sequenceFlow id="f2" sourceRef="a" targetRef="g"/>
    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="b" name="Yes"/>
    <bpmn:sequenceFlow id="f4" sourceRef="g" targetRef="c" name="No"/>
    <bpmn:sequenceFlow id="f5" sourceRef="b" targetRef="e1"/>
    <bpmn:sequenceFlow id="f6" sourceRef="c" targetRef="e2"/>
  </bpmn:process>
</definitions>`;

const PARALLEL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="P" name="Order">
    <bpmn:startEvent id="s" name="Start"/>
    <bpmn:parallelGateway id="p1" name="Split"/>
    <bpmn:userTask id="a" name="Pick"/>
    <bpmn:serviceTask id="b" name="Invoice"/>
    <bpmn:parallelGateway id="p2" name="Join"/>
    <bpmn:endEvent id="e" name="End"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="p1"/>
    <bpmn:sequenceFlow id="f2" sourceRef="p1" targetRef="a"/>
    <bpmn:sequenceFlow id="f3" sourceRef="p1" targetRef="b"/>
    <bpmn:sequenceFlow id="f4" sourceRef="a" targetRef="p2"/>
    <bpmn:sequenceFlow id="f5" sourceRef="b" targetRef="p2"/>
    <bpmn:sequenceFlow id="f6" sourceRef="p2" targetRef="e"/>
  </bpmn:process>
</definitions>`;

describe("bpmn simulation", () => {
  it("reads lanes, tasks and gateway labels", () => {
    const graph = parseBpmn(LEAVE);
    assert.equal(graph.name, "Leave");
    assert.equal(graph.nodes.find((node) => node.id === "a")?.role, "Employee");
    assert.equal(graph.nodes.find((node) => node.id === "g")?.kind, "xor");
    assert.equal(graph.flows.find((flow) => flow.id === "f3")?.label, "Yes");
  });

  it("sends happy flow down the yes branch and edge flow down the no branch", () => {
    const graph = parseBpmn(LEAVE);
    const happyParams = applyPreset(graph, "happy");
    const edgeParams = applyPreset(graph, "edge");
    const happy = simulate(graph, { scenario: "Happy", cases: 200, ...happyParams });
    const edge = simulate(graph, { scenario: "Edge", cases: 200, ...edgeParams });
    const yes = happy.branches.find((branch) => branch.label === "Yes");
    const no = edge.branches.find((branch) => branch.label === "No");
    assert.ok(yes && yes.share >= 80);
    assert.ok(no && no.share >= 60);
    assert.equal(happy.completed, 200);
    assert.match(toCsv(happy.rows), /^Case_ID,Activity,Start_Timestamp,End_Timestamp,Resource,Scenario_Type/);
    assert.match(toXes(happy.rows, "Happy"), /xes.version="1.0"/);
    assert.match(toXes(happy.rows, "Happy"), /lifecycle:transition" value="complete"/);
  });

  it("runs parallel branches and joins before the end", () => {
    const graph = parseBpmn(PARALLEL);
    const params = applyPreset(graph, "happy");
    const run = simulate(graph, { scenario: "Happy", cases: 20, ...params });
    assert.equal(run.completed, 20);
    const pick = run.rows.filter((row) => row.caseId === "0001" && row.activity === "Pick").length;
    const invoice = run.rows.filter((row) => row.caseId === "0001" && row.activity === "Invoice").length;
    assert.equal(pick, 1);
    assert.equal(invoice, 1);
    assert.ok(run.bottleneck);
  });
});
