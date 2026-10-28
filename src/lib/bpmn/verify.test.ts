import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SAMPLE_IR } from "./samples.ts";
import { applyPreset, parseBpmn, simulate, type LogRow } from "./sim.ts";
import { translateIr } from "./translate.ts";
import { verifyLog } from "./verify.ts";

// IR the app produced (qwen/qwen3.5-9b) for the three Vietnamese test descriptions.
export const VN_IR: Record<string, string> = {
  order: `process "Xử lý đơn hàng"
start s1 "Gửi đơn đặt hàng"
user kiem_tra "Kiểm tra tồn kho"
xor g_co_hang "Còn hàng?"
service xuat_kho "Xuất kho"
service giao_hang "Giao hàng"
service thong_bao "Thông báo hết hàng"
end e1 "Kết thúc"
s1 -> kiem_tra
kiem_tra -> g_co_hang
g_co_hang -> xuat_kho "Có"
g_co_hang -> thong_bao "Không"
xuat_kho -> giao_hang
giao_hang -> e1
thong_bao -> e1`,
  parallel: `process "Đón nhân viên mới"
start s1 "Có nhân viên mới"
task tao_hoso "Tạo hồ sơ"
and g_song "Tách song song"
service cap_may "Cấp máy tính"
service tao_tk "Tạo tài khoản"
task chuan_bi_ban "Chuẩn bị bàn làm việc"
task chuan_bi_the "Chuẩn bị thẻ ra vào"
and g_hop "Gộp song song"
user don_nv "Đón nhân viên mới"
end e1 "Xong"
s1 -> tao_hoso
tao_hoso -> g_song
g_song -> cap_may
g_song -> chuan_bi_ban
cap_may -> tao_tk
chuan_bi_ban -> chuan_bi_the
tao_tk -> g_hop
chuan_bi_the -> g_hop
g_hop -> don_nv
don_nv -> e1`,
  loop: `process "Xử lý luận văn"
start s1 "Nộp bản thảo"
user doc "Đọc bản thảo"
xor g_dat "Đạt yêu cầu?"
user sua "Chỉnh sửa lại"
service xep_lich "Xếp lịch bảo vệ"
service thong_bao "Thông báo cho sinh viên"
end e1 "Hoàn tất"
s1 -> doc
doc -> g_dat
g_dat -> sua "Chưa đạt"
g_dat -> xep_lich "Đạt"
sua -> doc
xep_lich -> thong_bao
thong_bao -> e1`,
};

function graphOf(ir: string) {
  const out = translateIr(ir, "vi");
  assert.ok(out.ok);
  return parseBpmn(out.diagrams[0]!.xml);
}

function run(ir: string, preset: "happy" | "edge", cases = 50) {
  const graph = graphOf(ir);
  return {
    graph,
    result: simulate(graph, { scenario: preset, cases, ...applyPreset(graph, preset) }),
  };
}

const caseRows = (rows: LogRow[], id: string) => rows.filter((row) => row.caseId === id);

describe("event log verification", () => {
  const models = { ...VN_IR, sampleVi: SAMPLE_IR.vi, sampleEn: SAMPLE_IR.en };
  for (const [name, ir] of Object.entries(models)) {
    for (const preset of ["happy", "edge"] as const) {
      it(`simulated log for ${name}/${preset} conforms 100%`, () => {
        const { graph, result } = run(ir, preset);
        const check = verifyLog(graph, result.rows);
        assert.deepEqual(check.errors, []);
        assert.equal(check.valid, result.cases);
      });
    }
  }

  it("catches a swapped order", () => {
    const { graph, result } = run(VN_IR.order!, "happy", 1);
    const rows = caseRows(result.rows, "0001").map((row) => ({ ...row }));
    [rows[1]!.activity, rows[2]!.activity] = [rows[2]!.activity, rows[1]!.activity];
    assert.equal(verifyLog(graph, rows).valid, 0);
  });

  it("catches a skipped XOR (both branches taken)", () => {
    const { graph, result } = run(VN_IR.order!, "happy", 1);
    const rows = caseRows(result.rows, "0001").map((row) => ({ ...row }));
    const at = rows.findIndex(
      (row) => row.activity === "Xuất kho" || row.activity === "Thông báo hết hàng",
    );
    rows.splice(at + 1, 0, {
      ...rows[at]!,
      activity: rows[at]!.activity === "Xuất kho" ? "Thông báo hết hàng" : "Xuất kho",
    });
    const check = verifyLog(graph, rows);
    assert.equal(check.valid, 0);
  });

  it("catches a missing AND branch", () => {
    const { graph, result } = run(VN_IR.parallel!, "happy", 1);
    const rows = caseRows(result.rows, "0001").filter(
      (row) => row.activity !== "Chuẩn bị thẻ ra vào",
    );
    const check = verifyLog(graph, rows);
    assert.equal(check.valid, 0);
    assert.ok(check.errors[0]!.message.length > 0);
  });

  it("catches a bad timestamp", () => {
    const { graph, result } = run(VN_IR.loop!, "happy", 1);
    const rows = caseRows(result.rows, "0001").map((row) => ({ ...row }));
    rows[2]!.start = "2000-01-01 00:00:00";
    assert.equal(verifyLog(graph, rows).valid, 0);
  });
});
