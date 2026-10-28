import type { Lang } from "./lang";

const leaveVi = {
  id: "leave",
  title: "Nghỉ phép",
  text: "Nhân viên gửi đơn nghỉ phép. Quản lý xem xét. Nếu đồng ý, nhân sự ghi nhận và nhân viên nhận thông báo đã duyệt. Nếu từ chối, quản lý ghi lý do và nhân viên nhận thông báo từ chối.",
};

const orderVi = {
  id: "order",
  title: "Đơn hàng",
  text: "Khách đặt hàng trên website. Hệ thống kiểm tra tồn kho. Nếu còn hàng, kho soạn hàng và kế toán xuất hóa đơn song song, rồi mới giao cho khách. Nếu hết hàng, hệ thống báo khách và kết thúc.",
};

const hireVi = {
  id: "hire",
  title: "Tuyển dụng",
  text: "Ứng viên nộp hồ sơ. Tuyển dụng sàng lọc. Không đạt thì gửi thư từ chối. Đạt thì trưởng bộ phận phỏng vấn. Trúng tuyển thì nhân sự gửi offer và ứng viên xác nhận. Không trúng thì gửi thư từ chối.",
};

const leaveEn = {
  id: "leave",
  title: "Leave",
  text: "An employee submits a leave request. The manager reviews it. If approved, HR records the leave and the employee is notified. If rejected, the manager writes the reason and the employee is notified.",
};

const orderEn = {
  id: "order",
  title: "Order",
  text: "A customer places an order on the website. The system checks stock. If items are in stock, the warehouse picks the goods and accounting issues the invoice in parallel, then the order is delivered. If out of stock, the system tells the customer and the process ends.",
};

const hireEn = {
  id: "hire",
  title: "Hiring",
  text: "A candidate submits an application. Recruiting screens it. If it fails screening, a rejection email is sent. If it passes, the department head interviews the candidate. If hired, HR sends an offer and the candidate confirms. If not hired, a rejection email is sent.",
};

export const SAMPLES: Record<Lang, readonly { id: string; title: string; text: string }[]> = {
  vi: [leaveVi, orderVi, hireVi],
  en: [leaveEn, orderEn, hireEn],
};

export const SAMPLE_IR: Record<Lang, string> = {
  vi: `process "Duyệt đơn nghỉ phép"
lane "Nhân viên"
lane "Quản lý"
lane "Nhân sự"

start s "Bắt đầu" lane "Nhân viên"
user n1 "Gửi đơn nghỉ" lane "Nhân viên"
user n2 "Xem xét đơn" lane "Quản lý"
xor g1 "Đồng ý?" lane "Quản lý"
user n3 "Ghi nhận ngày nghỉ" lane "Nhân sự"
user n4 "Ghi lý do từ chối" lane "Quản lý"
end e1 "Đã duyệt" lane "Nhân viên"
end e2 "Đã từ chối" lane "Nhân viên"

s -> n1
n1 -> n2
n2 -> g1
g1 -> n3 "Có"
g1 -> n4 "Không"
n3 -> e1
n4 -> e2`,
  en: `process "Leave approval"
lane "Employee"
lane "Manager"
lane "HR"

start s "Start" lane "Employee"
user n1 "Submit leave request" lane "Employee"
user n2 "Review request" lane "Manager"
xor g1 "Approved?" lane "Manager"
user n3 "Record the leave" lane "HR"
user n4 "Write the rejection reason" lane "Manager"
end e1 "Approved" lane "Employee"
end e2 "Rejected" lane "Employee"

s -> n1
n1 -> n2
n2 -> g1
g1 -> n3 "Yes"
g1 -> n4 "No"
n3 -> e1
n4 -> e2`,
};

export const IR_HINT: Record<Lang, string> = {
  vi: `process "Tên quy trình"
lane "Vai trò"
start s "Bắt đầu" lane "Vai trò"
task a "Việc chung" lane "Vai trò"
user b "Việc của người"
service c "Việc của hệ thống"
xor g "Câu hỏi?"
and p "Làm song song"
s -> a
a -> g
g -> b "Có"
g -> c "Không"`,
  en: `process "Process name"
lane "Role"
start s "Start" lane "Role"
task a "Generic step" lane "Role"
user b "Work a person does"
service c "Work a system does"
xor g "Question?"
and p "Do in parallel"
s -> a
a -> g
g -> b "Yes"
g -> c "No"`,
};
