import { validateFeatures, extractJson } from "./features.ts";
import { detectLang } from "./prompts.ts";
import { checkIr as checkIrV3, mergeStarts } from "./ircheck.ts";
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

describe("IR structural check", () => {
  it("flags undeclared refs, task branching, xor rejoining at and", async () => {
    const { checkIr } = await import("./ircheck.ts");
    const bad = `process "Đơn"
start s1 "Đặt" 
service k "Kiểm tra tồn kho"
xor g "Còn hàng?"
service a "Soạn hàng"
service b "Xuất hóa đơn"
and j "Gộp"
service d "Giao hàng"
end e1 "Xong"
s1 -> k
k -> g "Có"
k -> g_het "Hết"
g -> a
g -> b
a -> j
b -> j
j -> d
d -> e1`;
    const errs = checkIr(bad).join("\n");
    assert.match(errs, /mã «g_het» chưa được khai báo/);
    assert.match(errs, /«Kiểm tra tồn kho» \(k\) có 2 luồng ra/);
    assert.match(errs, /xor «Còn hàng\?» \(g\).*and «Gộp» \(j\)/);
  });

  it("accepts a correct xor + and split/join model", async () => {
    const { checkIr } = await import("./ircheck.ts");
    const good = `process "Đơn"
start s1 "Đặt"
service k "Kiểm tra tồn kho"
xor g "Còn hàng?"
and t "Tách"
service a "Soạn hàng"
service b "Xuất hóa đơn"
and j "Gộp"
service d "Giao hàng"
service n "Báo lỗi"
end e1 "Xong"
end e2 "Hủy"
s1 -> k
k -> g
g -> t "Có"
g -> n "Hết"
t -> a
t -> b
a -> j
b -> j
j -> d
d -> e1
n -> e2`;
    assert.deepEqual(checkIr(good), []);
  });
});

describe("same label in two lanes", () => {
  it("checks the performer against the row's own lane", async () => {
    const { translateIr } = await import("./translate.ts");
    const ir = `process "Tuyển"
lane "Tuyển dụng"
lane "Nhân sự"
start s "Nộp" lane "Tuyển dụng"
xor g "Đạt?" lane "Tuyển dụng"
user a "Gửi thư từ chối" lane "Tuyển dụng"
user p "Phỏng vấn" lane "Nhân sự"
xor h "Trúng?" lane "Nhân sự"
user b "Gửi thư từ chối" lane "Nhân sự"
user o "Gửi offer" lane "Nhân sự"
end e1 "Loại 1" lane "Tuyển dụng"
end e2 "Loại 2" lane "Nhân sự"
end e3 "Nhận" lane "Nhân sự"
s -> g
g -> a "Không"
g -> p "Có"
a -> e1
p -> h
h -> b "Không"
h -> o "Có"
b -> e2
o -> e3`;
    const g = parseBpmn((translateIr(ir, "vi") as { diagrams: { xml: string }[] }).diagrams[0]!.xml);
    const r = simulate(g, { scenario: "x", cases: 60, ...applyPreset(g, "edge") });
    assert.deepEqual(verifyLog(g, r.rows).errors, []);
  });
});

it("v3: detectLang picks vi/en from diacritics", () => {
  assert.equal(detectLang("Khách hàng gửi đơn, nhân viên kiểm tra và duyệt."), "vi");
  assert.equal(detectLang("The customer sends an order and the clerk checks it."), "en");
});

it("v3: parallel branches merging into a task without and join are flagged", () => {
  const ir = `start s "S"\nand a "Split"\ntask x "X"\ntask y "Y"\ntask z "Z"\nend e "E"\ns -> a\na -> x\na -> y\nx -> z\ny -> z\nz -> e`;
  const errs = checkIrV3(ir, "en");
  assert.ok(errs.some((e) => e.includes("«Z» (z)") && e.includes("and join")), errs.join("|"));
  const ok = `start s "S"\nand a "Split"\ntask x "X"\ntask y "Y"\nand j "Join"\ntask z "Z"\nend e "E"\ns -> a\na -> x\na -> y\nx -> j\ny -> j\nj -> z\nz -> e`;
  assert.deepEqual(checkIrV3(ok, "en"), []);
});

it("v3: xor loop back into a task is not flagged as parallel merge", () => {
  const ir = `start s "S"\ntask t "T"\nxor g "OK?"\nend e "E"\ns -> t\nt -> g\ng -> t "No"\ng -> e "Yes"`;
  assert.deepEqual(checkIrV3(ir), []);
});

it("v3: several starts get a fix hint and mergeStarts fixes them", () => {
  const ir = `start a "Bill A"\nstart b "Bill B"\ntask t "Pay"\nend e "Done"\na -> t\nb -> t\nt -> e`;
  assert.ok(checkIrV3(ir, "en").some((e) => e.includes("Which case?")));
  const fixed = mergeStarts(ir, "en");
  assert.deepEqual(checkIrV3(fixed, "en"), []);
});

const FEAT_IR = `process "Order"
lane "Customer"
lane "Clerk"
lane "System"
start s "Order placed" lane "Customer"
user place "Place order" lane "Customer"
user check "Check order" lane "Clerk"
xor g "OK?" lane "Clerk"
service ship "Ship" lane "System"
user fix "Fix order" lane "Customer"
end e "Done" lane "System"
s -> place
place -> check
check -> g
g -> ship "Yes"
g -> fix "No"
fix -> check
ship -> e`;

it("split: validateFeatures keeps valid entries and drops bad ids/ranges", () => {
  const raw = extractJson(`noise {"roles":{"Clerk":{"count":3,"names":["An"]},"Ghost":{"count":2},"System":{"count":4}},
    "customerRole":"Customer","customers":["Ann","Bob"],
    "minutes":{"check":12,"nope":5,"ship":-1},"rework":{"check":0.2,"fix":0.9},
    "branches":{"g":{"ship":3,"fix":1},"check":{"ship":1}},"bottlenecks":["check","zzz"]} tail`);
  const { semantics, report } = validateFeatures(raw, FEAT_IR);
  assert.equal(report.parsed, true);
  assert.deepEqual(semantics.roles?.Clerk, ["An", "Clerk - NV2", "Clerk - NV3"]);
  assert.equal(semantics.customerRole, "Customer");
  assert.deepEqual(semantics.minutes, { "Check order": 12 });
  assert.deepEqual(semantics.rework, { "Check order": 0.2 });
  assert.deepEqual(semantics.branches, { "OK?": { Ship: 0.75, "Fix order": 0.25 } });
  assert.deepEqual(semantics.bottlenecks, ["Check order"]);
  for (const d of ["roles.Ghost", "roles.System", "minutes.nope", "minutes.ship", "rework.fix", "branches.check", "bottlenecks.*"])
    assert.ok(report.dropped.includes(d), d);
  assert.equal(validateFeatures("x", FEAT_IR).report.parsed, false);
  // flow to an undeclared target must not crash
  const broken = validateFeatures({ branches: { g: { ghost: 1, ship: 1 } } }, FEAT_IR + "\ng -> ghost");
  assert.deepEqual(broken.semantics.branches, { "OK?": { Ship: 1 } });
});

it("split: features drive applyPreset and simulation still verifies", () => {
  const xml = ORDER_BPMN;
  const g = parseBpmn(xml);
  const task = g.nodes.find((n) => n.kind === "user" || n.kind === "task" || n.kind === "service")!;
  const xor = g.nodes.find((n) => n.kind === "xor")!;
  const outs = g.flows.filter((f) => f.source === xor.id);
  const target = g.nodes.find((n) => n.id === outs[1]!.target)!;
  const sem = { minutes: { [task.label]: 40 }, bottlenecks: [task.label], branches: { [xor.label]: { [target.label]: 1 } } };
  const happy = applyPreset(g, "happy", sem);
  const edge = applyPreset(g, "edge", sem);
  assert.equal(happy.minutes[task.id], 40);
  assert.equal(edge.minutes[task.id], 100);
  assert.equal(happy.probability[outs[1]!.id], 100);
  assert.equal(happy.probability[outs[0]!.id], 0);
  for (const [p, preset] of [["happy", happy], ["edge", edge]] as const) {
    const run = simulate(g, { scenario: p, cases: 20, ...preset, semantics: sem as never });
    assert.equal(verifyLog(g, run.rows, sem as never).valid, 20);
  }
});

it("bad scenario: same branch odds as good, but longer mean case duration", () => {
  const g = parseBpmn(ORDER_BPMN);
  const sem = defaultSemantics(g);
  const good = applyPreset(g, "happy", sem);
  const bad = applyPreset(g, "edge", sem);
  assert.deepEqual(bad.probability, good.probability);
  assert.ok(bad.arrival < good.arrival);
  const run = (p: typeof good, s: string) => simulate(g, { scenario: s, cases: 100, ...p, semantics: sem });
  const rg = run(good, "good");
  const rb = run(bad, "bad");
  assert.ok(rb.avgMinutes > rg.avgMinutes * 1.1, `${rb.avgMinutes} vs ${rg.avgMinutes}`);
  assert.equal(verifyLog(g, rg.rows, sem).valid, 100);
  assert.equal(verifyLog(g, rb.rows, sem).valid, 100);
});
