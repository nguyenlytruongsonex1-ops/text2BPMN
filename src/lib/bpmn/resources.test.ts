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
});
