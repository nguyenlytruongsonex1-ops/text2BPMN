import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPreset, defaultSemantics, parseBpmn, simulate, toCsv, toXes } from "./sim.ts";
import { verifyLog } from "./verify.ts";
import { ORDER_BPMN } from "./order.fixture.ts";

const graph = parseBpmn(ORDER_BPMN);
const run = (preset: "happy" | "edge", cases = 40) =>
  simulate(graph, { scenario: preset, cases, ...applyPreset(graph, preset) });

describe("semantic resources", () => {
  it("derives pools from lanes", () => {
    const sem = defaultSemantics(graph);
    assert.equal(sem.customerRole, "Khách hàng");
    assert.deepEqual(sem.roles["Kho"], ["Kho - NV1", "Kho - NV2"]);
    assert.ok(sem.unlimited?.includes("Hệ thống"));
  });

  it("logs people, roles, customers and passes verify", () => {
    for (const preset of ["happy", "edge"] as const) {
      const result = run(preset);
      const check = verifyLog(graph, result.rows);
      assert.equal(check.errors.length, 0, JSON.stringify(check.errors.slice(0, 3)));
      for (const row of result.rows.filter((r) => r.role === "Khách hàng" && r.resource))
        assert.equal(row.resource, row.customer);
    }
    const result = run("happy");
    assert.match(toCsv(result.rows), /^Case_ID,Activity,Start_Timestamp,End_Timestamp,Resource,Role,Customer,Scenario_Type/);
    const xes = toXes(result.rows, "happy");
    assert.match(xes, /org:role" value="Kho"/);
    assert.match(xes, /key="customer" value="Khách [ABC]"/);
  });

  it("is deterministic", () => {
    assert.deepEqual(run("edge").rows, run("edge").rows);
  });

  it("queues when the pool is busy", () => {
    const sem = { ...defaultSemantics(graph), roles: { ...defaultSemantics(graph).roles, Kho: ["Kho - NV1"] } };
    const result = simulate(graph, { scenario: "x", cases: 20, ...applyPreset(graph, "happy"), semantics: sem });
    assert.equal(verifyLog(graph, result.rows, sem).errors.length, 0);
    const delivered = result.rows.filter((r) => r.activity === "Soạn hàng").map((r) => r.start);
    assert.equal(new Set(delivered).size, delivered.length);
  });

  it("flags wrong person, overlap and wrong customer", () => {
    const rows = run("happy", 10).rows.map((r) => ({ ...r }));
    const pick = rows.find((r) => r.activity === "Soạn hàng")!;
    pick.resource = "Kế toán - NV1";
    assert.match(verifyLog(graph, rows).errors.map((e) => e.message).join(), /không thuộc nhóm «Kho»/);

    const rows2 = run("happy", 10).rows.map((r) => ({ ...r }));
    const order = rows2.find((r) => r.activity === "Đặt hàng trên website")!;
    order.resource = order.customer === "Khách A" ? "Khách B" : "Khách A";
    assert.match(verifyLog(graph, rows2).errors.map((e) => e.message).join(), /khách của hồ sơ/);

    const rows3 = run("happy", 10).rows.map((r) => ({ ...r }));
    const picks = rows3.filter((r) => r.activity === "Soạn hàng");
    const pair = picks.flatMap((a) => picks.map((b) => [a, b] as const)).find(
      ([a, b]) => a !== b && a.resource !== b.resource && a.start <= b.start && b.start < a.end,
    )!;
    pair[1].resource = pair[0].resource;
    assert.match(verifyLog(graph, rows3).errors.map((e) => e.message).join(), /trùng giờ/);
  });

  it("repeats only rework tasks, never customer tasks", () => {
    const sem = defaultSemantics(graph);
    assert.ok("Soạn hàng" in sem.rework! && !("Kiểm tra tồn kho" in sem.rework!));
    assert.ok(!("Nhận hàng" in sem.rework!) && !("Đặt hàng trên website" in sem.rework!));
    const result = simulate(graph, { scenario: "x", cases: 300, ...applyPreset(graph, "edge") });
    const seen = new Map<string, number>();
    for (const r of result.rows) seen.set(r.caseId + r.activity, (seen.get(r.caseId + r.activity) ?? 0) + 1);
    const repeated = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k.slice(4)));
    assert.ok(repeated.size > 0);
    for (const label of repeated) assert.ok(label in sem.rework!, label);
  });

  it("flags a non-rework step repeated outside a loop", () => {
    const rows = run("happy", 5).rows.map((r) => ({ ...r }));
    const i = rows.findIndex((r) => r.activity === "Nhận hàng");
    const r = rows[i]!;
    rows.splice(i + 1, 0, { ...r, start: r.end, end: r.end });
    assert.match(verifyLog(graph, rows).errors.map((e) => e.message).join(), /lặp 2 lần/);
  });

  it("uses random but deterministic arrivals", () => {
    const starts = run("happy", 30).rows.filter((r) => r.activity === "Bắt đầu").map((r) => Date.parse(r.start + "Z"));
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    assert.ok(new Set(gaps).size > 3);
    assert.ok(gaps.every((g) => g >= 0));
    assert.deepEqual(run("happy", 30).rows, run("happy", 30).rows);
  });
});

// LLM-style model from Son's bug: no end events, paths just stop after the last task.
const NO_END = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <bpmn:process id="P" name="Đơn">
    <bpmn:laneSet>
      <bpmn:lane id="L1" name="Khách hàng"><bpmn:flowNodeRef>s</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="L2" name="Hệ thống"><bpmn:flowNodeRef>b</bpmn:flowNodeRef><bpmn:flowNodeRef>g</bpmn:flowNodeRef><bpmn:flowNodeRef>n</bpmn:flowNodeRef></bpmn:lane>
      <bpmn:lane id="L3" name="Kho"><bpmn:flowNodeRef>c</bpmn:flowNodeRef></bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="s" name="Đặt hàng"/>
    <bpmn:serviceTask id="b" name="Kiểm tra tồn kho"/>
    <bpmn:exclusiveGateway id="g" name="Còn hàng?"/>
    <bpmn:userTask id="c" name="Soạn hàng"/>
    <bpmn:serviceTask id="n" name="Báo lỗi cho khách"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="b"/>
    <bpmn:sequenceFlow id="f2" sourceRef="b" targetRef="g"/>
    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="c" name="Có"/>
    <bpmn:sequenceFlow id="f4" sourceRef="g" targetRef="n" name="Hết hàng"/>
  </bpmn:process>
</definitions>`;

describe("bug: model without end events + partial semantics JSON", () => {
  it("verifies all cases", () => {
    const g = parseBpmn(NO_END);
    const sem = {
      roles: { "Hệ thống": ["Hệ thống"], Kho: ["Kho - NV1", "Kho - NV2"] },
      unlimited: ["Hệ thống"],
      rework: { "Kiểm tra tồn kho": 0.03, "Soạn hàng": 0.03 },
    };
    const r = simulate(g, { scenario: "x", cases: 50, ...applyPreset(g, "happy"), semantics: sem });
    assert.equal(r.completed, 50);
    const v = verifyLog(g, r.rows, sem);
    assert.deepEqual(v.warnings, ["mô hình thiếu điểm kết thúc"]);
    assert.equal(v.errors.length, 0, JSON.stringify(v.errors.slice(0, 2)));
    assert.ok(!("Kiểm tra tồn kho" in defaultSemantics(g).rework!));
  });
});

const DANGLING_IR = `process "Đơn"
lane "Hệ thống"
start s "Đặt hàng" lane "Hệ thống"
service k "Kiểm tra tồn kho" lane "Hệ thống"
xor g "Còn hàng?" lane "Hệ thống"
service b "Báo lỗi cho khách" lane "Hệ thống"
service c "Soạn hàng" lane "Hệ thống"
s -> k
k -> g
g -> c "Có"
g -> b "Không"`;

describe("end events safety net", () => {
  it("JS fallback adds an end to dangling branches with a warning", async () => {
    const { translateIr } = await import("./translate.ts");
    const out = translateIr(DANGLING_IR, "vi");
    assert.ok(out.ok);
    const d = out.diagrams[0]!;
    assert.equal(d.warnings.filter((w) => /Nhánh không có điểm kết thúc/.test(w)).length, 2);
    const g = parseBpmn(d.xml);
    assert.equal(g.nodes.filter((n) => n.kind === "end").length, 2);
    const r = simulate(g, { scenario: "x", cases: 20, ...applyPreset(g, "happy") });
    const v = verifyLog(g, r.rows);
    assert.equal(v.errors.length, 0);
    assert.deepEqual(v.warnings, []);
  });

  it("python engine adds the same ends", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("python3", ["src/lib/bpmn/ir_to_bpmn.py"], { input: DANGLING_IR }).toString();
    const res = JSON.parse(out) as { diagrams: { xml: string; warnings: string[] }[] };
    const d = res.diagrams[0]!;
    assert.equal((d.xml.match(/endEvent id=/g) ?? []).length, 2);
    assert.equal(d.warnings.filter((w) => /Nhánh không có điểm kết thúc/.test(w)).length, 2);
  });
});
