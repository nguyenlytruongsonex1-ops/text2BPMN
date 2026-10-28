import type { Lang } from "./lang";

// Pick the prompt language from the description itself: Vietnamese diacritics => vi, else en.
export function detectLang(text: string): Lang {
  const hits = (text.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) ?? []).length;
  return hits >= 3 ? "vi" : "en";
}

// Structure-only prompts (call 1), based on the 5acb086 prompt; examples in the input language.
const SYSTEM_VI = `Bạn chỉ xuất IR văn bản cho BPMN cơ bản. Không XML, không markdown, không giải thích.

Mỗi dòng một lệnh (<ma> là mã bước do bạn đặt, KHÔNG viết chữ "id"):
process "Tên quy trình"
lane "Vai trò"
start <ma> "Nhãn" lane "Vai trò"
end <ma> "Nhãn" lane "Vai trò"
task <ma> "Nhãn" lane "Vai trò"
user <ma> "Nhãn" lane "Vai trò"
service <ma> "Nhãn" lane "Vai trò"
xor <ma> "Câu hỏi?" lane "Vai trò"
and <ma> "Nhãn" lane "Vai trò"
<ma_nguon> -> <ma_dich> "Nhãn nhánh"

Quy tắc:
- Nhiều quy trình trong một văn bản thì mỗi quy trình bắt đầu bằng một dòng process.
- Mã bước là duy nhất, chỉ gồm chữ không dấu, số và _ (ví dụ s1, kiem_tra, g_dat). Nhãn giữ ngôn ngữ của người dùng, đặt trong ngoặc kép. Thoát " bằng \\".
- Mỗi dòng bước PHẢI bắt đầu bằng loại (start/end/task/user/service/xor/and), không bao giờ bắt đầu bằng mã.
- Khai báo mọi bước trước, rồi mới viết luồng. Luồng chỉ dùng mã đã khai báo, không dùng nhãn, không nối một bước với chính nó.
- user: việc do người làm. service: việc do hệ thống làm. task: việc chung.
- xor khi rẽ loại trừ: mỗi luồng ra khỏi xor phải có nhãn điều kiện ngắn ("Có", "Không"...). Các nhánh xor gặp lại nhau thì hội tụ bằng một xor khác, KHÔNG bao giờ bằng and.
- and khi làm song song: các nhánh and phải hội tụ ở một and khác trước khi đi tiếp. Luồng của and không cần nhãn.
- Mọi mã dùng trong luồng PHẢI được khai báo trước là một bước hoặc gateway (không nối tới mã chưa khai báo).
- Chỉ gateway mới rẽ nhánh: task/user/service/start có TỐI ĐA một luồng ra. Muốn rẽ thì nối bước đó tới một xor/and.
- xor = chọn ĐÚNG MỘT nhánh (loại trừ, ví dụ "Còn hàng?" -> "Có"/"Hết hàng"). Việc làm song song (ví dụ soạn hàng và xuất hóa đơn cùng lúc) phải dùng and tách + and gộp, KHÔNG dùng xor.
- Lặp lại/làm lại: nối luồng từ nhánh xor quay về bước trước đó (không cần gateway mới).
- Đúng một start (nhiều tình huống khởi đầu thì một start rồi một xor "Loại tình huống?"). MỌI nhánh phải đi tới một end: mỗi luồng ra của xor/and (kể cả nhánh lỗi như "Báo lỗi cho khách", "Hủy đơn") cuối cùng phải nối tới một end. Không để bước nào cụt (bước không phải end mà không có luồng ra). Nhánh kết thúc khác nhau thì dùng end riêng có nhãn rõ.
- Có vai trò thì khai báo lane và gắn lane cho từng bước. Không có vai trò thì bỏ lane.
- Không thêm bước ngoài mô tả. Tối đa 30 bước mỗi quy trình.
- Nhãn theo ngôn ngữ của mô tả (mô tả tiếng Anh thì nhãn tiếng Anh). Mã bước vẫn không dấu.
- Mơ hồ thì chọn cách diễn giải ngắn nhất.

Ví dụ 2 (xor chọn một nhánh, bên trong nhánh "Có" là and song song):
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

Ví dụ:
process "Duyệt đơn nghỉ phép"
lane "Nhân viên"
lane "Quản lý"
start s1 "Có nhu cầu nghỉ" lane "Nhân viên"
user nop_don "Nộp đơn nghỉ phép" lane "Nhân viên"
and g_song "Tách song song" lane "Quản lý"
user xem_lich "Xem lịch nhóm" lane "Quản lý"
service tra_phep "Tra số ngày phép" lane "Quản lý"
and g_hop "Gộp song song" lane "Quản lý"
xor g_duyet "Duyệt đơn?" lane "Quản lý"
user sua_don "Sửa đơn" lane "Nhân viên"
service ghi_nhan "Ghi nhận ngày nghỉ" lane "Quản lý"
user bao_tu_choi "Báo từ chối cho nhân viên" lane "Quản lý"
end e1 "Đã duyệt" lane "Quản lý"
end e2 "Bị từ chối" lane "Nhân viên"
s1 -> nop_don
nop_don -> g_song
g_song -> xem_lich
g_song -> tra_phep
xem_lich -> g_hop
tra_phep -> g_hop
g_hop -> g_duyet
g_duyet -> ghi_nhan "Đồng ý"
g_duyet -> sua_don "Cần sửa"
g_duyet -> bao_tu_choi "Từ chối"
sua_don -> nop_don
ghi_nhan -> e1
bao_tu_choi -> e2

Tự kiểm tra trước khi in: mỗi dòng bước có loại ở đầu; mã duy nhất và không phải "id"; mọi luồng dùng mã đã khai báo; không luồng tự thân; mọi nhánh xor có nhãn; xor hội tụ bằng xor, and bằng and; đúng một start; mọi nhánh (kể cả nhánh lỗi/hủy) kết thúc ở end; không bước nào ngoài end thiếu luồng ra; mọi mã trong luồng đã khai báo; bước không phải gateway có tối đa một luồng ra; nhánh xor không gộp ở and (song song thì dùng and tách/gộp).
Chỉ IR.`;

const SYSTEM_EN = `Output text IR for basic BPMN only. No XML, no markdown, no explanation.

One command per line (<code> is a step code you choose, NEVER the word "id"):
process "Process name"
lane "Role"
start <code> "Label" lane "Role"
end <code> "Label" lane "Role"
task <code> "Label" lane "Role"
user <code> "Label" lane "Role"
service <code> "Label" lane "Role"
xor <code> "Question?" lane "Role"
and <code> "Label" lane "Role"
<source_code> -> <target_code> "Branch label"

Rules:
- Several processes in one text: each starts with its own process line.
- Step codes are unique, only ASCII letters, digits and _ (e.g. s1, check_stock, g_ok). Labels in double quotes, in the language of the description (English). Escape " as \\".
- Every step line MUST start with its type (start/end/task/user/service/xor/and), never with the code.
- Declare all steps first, then the flows. Flows use declared codes only, never labels, never a step to itself.
- user: done by a person. service: done by a system. task: generic work.
- xor for exclusive choices: every flow out of a xor has a short condition label ("Yes", "No"...). xor branches that meet again merge in another xor, NEVER in an and.
- and for parallel work: and branches must merge in another and before continuing. and flows need no label.
- Every code used in a flow MUST be declared as a step or gateway.
- Only gateways branch: task/user/service/start have AT MOST one outgoing flow. To branch, link the step to a xor/and.
- xor = choose EXACTLY ONE branch (e.g. "In stock?" -> "Yes"/"No"). Work done at the same time (e.g. packing and invoicing) must use an and split + and join, NOT a xor.
- Rework/repeat: link a xor branch back to an earlier step (no new gateway needed).
- Exactly one start (several entry cases: one start, then a xor "Which case?"). EVERY branch must reach an end: every flow out of a xor/and (including error branches like "Notify customer", "Cancel order") must finally reach an end. No dead-end steps (a non-end step without outgoing flow). Different outcomes use separate, clearly labelled ends.
- If roles exist, declare lanes and give every step a lane. No roles: omit lane.
- Do not add steps that are not in the text. At most 30 steps per process.
- If ambiguous, pick the shortest reading.

Example 2 (xor picks one branch; inside the "Yes" branch an and runs in parallel):
process "Handle order"
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

Example:
process "Approve leave request"
lane "Employee"
lane "Manager"
start s1 "Leave needed" lane "Employee"
user submit "Submit leave request" lane "Employee"
and g_split "Split" lane "Manager"
user view_cal "Check team calendar" lane "Manager"
service days_left "Look up leave balance" lane "Manager"
and g_join "Join" lane "Manager"
xor g_ok "Approve request?" lane "Manager"
user edit "Edit request" lane "Employee"
service record "Record leave" lane "Manager"
user notify_reject "Notify rejection" lane "Manager"
end e1 "Approved" lane "Manager"
end e2 "Rejected" lane "Employee"
s1 -> submit
submit -> g_split
g_split -> view_cal
g_split -> days_left
view_cal -> g_join
days_left -> g_join
g_join -> g_ok
g_ok -> record "Approve"
g_ok -> edit "Needs changes"
g_ok -> notify_reject "Reject"
edit -> submit
record -> e1
notify_reject -> e2

Self-check before printing: every step line starts with its type; codes unique and not "id"; every flow uses declared codes; no self-loops; every xor branch labelled; xor merges with xor, and with and; exactly one start; every branch (including error/cancel) ends at an end; no non-end step without outgoing flow; non-gateway steps have at most one outgoing flow; xor branches never merge at an and; labels in English.
Output IR only.`;

export const SYSTEMS: Record<Lang, string> = { vi: SYSTEM_VI, en: SYSTEM_EN };
