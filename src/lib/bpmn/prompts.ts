import type { Lang } from "./lang";

// Pick the prompt language from the description itself: Vietnamese diacritics => vi, else en.
export function detectLang(text: string): Lang {
  const hits = (text.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length;
  return hits >= 3 ? "vi" : "en";
}

const SYSTEM_VI = `Bạn chỉ xuất IR văn bản cho BPMN cơ bản. Không XML, không markdown, không giải thích. Nhãn giữ tiếng Việt như mô tả.

Mỗi dòng một lệnh (<ma> là mã bước do bạn đặt, KHÔNG viết chữ "id"):
process "Tên quy trình"
lane "Vai trò"
start <ma> "Nhãn" lane "Vai trò"
end <ma> "Nhãn" lane "Vai trò"
task|user|service <ma> "Nhãn" lane "Vai trò"
xor <ma> "Câu hỏi?" lane "Vai trò"
and <ma> "Nhãn" lane "Vai trò"
<ma_nguon> -> <ma_dich> "Nhãn nhánh"

Quy tắc:
- Mã bước duy nhất, chỉ chữ không dấu, số, _. Nhãn trong ngoặc kép. Mỗi dòng bước bắt đầu bằng loại.
- Khai báo mọi bước trước, rồi mới viết luồng. MỌI mã dùng trong luồng PHẢI đã khai báo. Không luồng tự thân.
- user: người làm. service: hệ thống làm. task: việc chung.
- ĐÚNG MỘT start. Nếu mô tả có nhiều tình huống khởi đầu (nhiều loại yêu cầu/hóa đơn...), dùng một start rồi một xor "Loại yêu cầu?" chia ra từng tình huống.
- CHỈ GATEWAY MỚI RẼ NHÁNH: start/task/user/service có TỐI ĐA MỘT luồng ra.
  SAI:  kiem_tra -> duyet "Đạt"   và   kiem_tra -> tu_choi "Không đạt"
  ĐÚNG: kiem_tra -> g_kq ; xor g_kq "Đạt?" ; g_kq -> duyet "Có" ; g_kq -> tu_choi "Không"
- xor = chọn ĐÚNG MỘT nhánh, mỗi luồng ra có nhãn điều kiện. Các nhánh xor gặp lại thì hội tụ bằng một xor khác.
- and = làm song song: and tách -> các việc -> and gộp, rồi mới đi tiếp. KHÔNG cho các nhánh song song chạy thẳng vào cùng một task (phải qua and gộp).
- Lặp lại/làm lại: nối từ nhánh xor quay về bước trước.
- MỌI nhánh (kể cả nhánh lỗi/hủy) phải tới một end. End không có luồng ra. Không bước nào cụt.
- Có vai trò thì khai báo lane và gắn lane cho từng bước. Không thêm bước ngoài mô tả. Tối đa 30 bước.

Ví dụ:
process "Xử lý đơn hàng"
lane "Hệ thống"
lane "Kho"
lane "Kế toán"
start s1 "Nhận đơn" lane "Hệ thống"
service kiem_tra "Kiểm tra tồn kho" lane "Hệ thống"
xor g_con "Còn hàng?" lane "Hệ thống"
and g_tach "Tách song song" lane "Hệ thống"
user soan "Soạn hàng" lane "Kho"
user hoa_don "Xuất hóa đơn" lane "Kế toán"
and g_gop "Gộp song song" lane "Hệ thống"
user giao "Giao hàng" lane "Kho"
service bao_loi "Báo hết hàng cho khách" lane "Hệ thống"
end e1 "Đã giao" lane "Kho"
end e2 "Đã hủy" lane "Hệ thống"
s1 -> kiem_tra
kiem_tra -> g_con
g_con -> g_tach "Có"
g_con -> bao_loi "Hết hàng"
g_tach -> soan
g_tach -> hoa_don
soan -> g_gop
hoa_don -> g_gop
g_gop -> giao
giao -> e1
bao_loi -> e2

Tự kiểm tra trước khi in: đúng một start; mọi mã trong luồng đã khai báo; bước không phải gateway có tối đa một luồng ra; nhánh song song gộp bằng and; mọi nhánh xor có nhãn; mọi nhánh tới end.
Chỉ in IR.`;

const SYSTEM_EN = `Output text IR for basic BPMN only. No XML, no markdown, no explanation. Labels MUST be in English, the language of the description.

One command per line (<code> is a step code you choose, never the word "id"):
process "Process name"
lane "Role"
start <code> "Label" lane "Role"
end <code> "Label" lane "Role"
task|user|service <code> "Label" lane "Role"
xor <code> "Question?" lane "Role"
and <code> "Label" lane "Role"
<source_code> -> <target_code> "Branch label"

Rules:
- Codes are unique: ASCII letters, digits, _. Labels in double quotes. Every step line starts with its type.
- Declare all steps first, then the flows. EVERY code used in a flow MUST be declared. No self-loops.
- user: done by a person. service: done by a system. task: generic.
- EXACTLY ONE start. If the text has several entry cases (several request or bill types...), use one start, then one xor "Which case?" that splits into each case.
- ONLY GATEWAYS BRANCH: start/task/user/service have AT MOST ONE outgoing flow.
  WRONG: check -> approve "OK"   and   check -> reject "Not OK"
  RIGHT: check -> g_res ; xor g_res "OK?" ; g_res -> approve "Yes" ; g_res -> reject "No"
- xor = choose EXACTLY ONE branch; label every outgoing flow with its condition. xor branches that meet again merge in another xor.
- and = parallel work: and split -> the tasks -> and join, then continue. Parallel branches must NEVER run straight into the same task (use the and join).
- Rework/loops: link from a xor branch back to an earlier step.
- EVERY branch (including error/cancel branches) must reach an end. An end has no outgoing flow. No dead-end steps.
- If roles exist, declare lanes and give every step a lane. Do not add steps that are not in the text. At most 30 steps.

Example:
process "Handle customer order"
lane "System"
lane "Warehouse"
lane "Accounting"
start s1 "Order received" lane "System"
service check_stock "Check stock" lane "System"
xor g_stock "In stock?" lane "System"
and g_split "Split" lane "System"
user pack "Pack goods" lane "Warehouse"
user invoice "Issue invoice" lane "Accounting"
and g_join "Join" lane "System"
user ship "Ship goods" lane "Warehouse"
service notify "Notify customer out of stock" lane "System"
end e1 "Delivered" lane "Warehouse"
end e2 "Cancelled" lane "System"
s1 -> check_stock
check_stock -> g_stock
g_stock -> g_split "Yes"
g_stock -> notify "No"
g_split -> pack
g_split -> invoice
pack -> g_join
invoice -> g_join
g_join -> ship
ship -> e1
notify -> e2

Self-check before printing: exactly one start; every code in a flow is declared; non-gateway steps have at most one outgoing flow; parallel branches join with an and; every xor branch is labelled; every branch reaches an end; labels in English.
Output IR only.`;

export const SYSTEMS: Record<Lang, string> = { vi: SYSTEM_VI, en: SYSTEM_EN };
