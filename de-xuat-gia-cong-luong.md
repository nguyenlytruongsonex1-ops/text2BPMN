# Yêu cầu gia công — Luồng

Web tối giản, tiếng Việt và tiếng Anh, cho người không làm kỹ thuật. Người dùng viết một quy trình bằng lời thường. Hệ thống vẽ sơ đồ BPMN cơ bản, cho sửa, tải file, rồi thử hai tình huống để thấy bước nào lâu và hồ sơ đi hướng nào.

Tên sản phẩm: **Luồng**. Không cần đăng nhập ở phiên bản này.

## 1. Việc cần giao

Một ứng dụng web chạy được trên trình duyệt máy tính và điện thoại, kèm mã nguồn, hướng dẫn chạy, và bộ kiểm thử các quy tắc bên dưới.

Bên nhận việc được làm lại giao diện, miễn là giữ workflow, định dạng file, và ranh giới giữa mô hình ngôn ngữ với bộ dịch. Không được để mô hình ngôn ngữ viết thẳng file BPMN XML.

## 2. Workflow cốt lõi

```text
Lời mô tả
  → mô hình ngôn ngữ viết bản trung gian dạng chữ (IR)
  → bộ dịch tất định (Python, dự phòng JavaScript cùng luật) ra BPMN 2.0 XML + BPMNDI
  → người dùng xem và sửa sơ đồ
  → giả lập kịch bản trên chính sơ đồ đang mở
  → event log CSV và XES
```

Ba bước trên màn hình, theo thứ tự:

1. **Viết quy trình.** Kể ai làm gì. Một đoạn có thể có nhiều quy trình.
2. **Xem sơ đồ.** Kéo thả, sửa tên, tải file `.bpmn`.
3. **Thử tình huống.** Chọn “việc suôn sẻ” hoặc “nhiều trục trặc”, bấm thử. Hệ thống cho nhiều hồ sơ đi qua sơ đồ và chỉ ra chỗ lâu, chỗ rẽ, hồ sơ bất thường.

Danh sách bước dạng chữ nằm trong mục đóng sẵn. Người dùng thường không cần mở. Người muốn sửa từng dòng thì sửa rồi vẽ lại, lần này không gọi mô hình ngôn ngữ.

## 3. Chức năng

### 3.1. Viết và vẽ

| Việc | Yêu cầu |
|---|---|
| Ngôn ngữ | Việt và Anh. Lựa chọn được nhớ trên máy. Nhãn trong sơ đồ giữ nguyên ngôn ngữ của lời mô tả. |
| Ô mô tả | Tối đa 8.000 ký tự. Có ví dụ sẵn: nghỉ phép, đơn hàng, tuyển dụng. |
| Vẽ sơ đồ | Gửi lời mô tả lên server. Mô hình rẻ viết IR. Nếu IR không dịch được, gọi đúng một lần mô hình mạnh hơn để sửa IR, rồi dịch lại. |
| Nhiều quy trình | Một lời mô tả có nhiều khối `process` thì hiện nhiều tab. Tải từng tab, hoặc tải một file gộp. File gộp là bản vừa dịch, không gồm sửa tay trên từng tab. |
| Bản IR | Người dùng sửa được. Bấm vẽ lại thì chỉ chạy bộ dịch. Tối đa 24.000 ký tự. Có mục “cách viết”, đóng sẵn. |
| Cảnh báo | Bộ dịch trả lời bằng ngôn ngữ đang chọn khi thiếu điểm bắt đầu hoặc kết thúc, id trùng, mũi tên trỏ tới id không có, hoặc id gần đúng được sửa tự động (lệch một ký tự). |

### 3.2. Sơ đồ

- Xem và sửa bằng bpmn-js Modeler: kéo, đổi nhãn, thêm hoặc xóa phần tử từ bảng công cụ.
- Vừa khung.
- Tải `.bpmn`. File mở được bằng bpmn.io, Camunda Modeler, draw.io.
- Sơ đồ trống thì nói rõ: viết quy trình hoặc mở ví dụ.

Phần tử BPMN bắt buộc:

- start, end
- task, user task, service task
- exclusive gateway (xor), parallel gateway (and), inclusive gateway (or)
- lane theo vai trò
- sequence flow, có nhãn ở nhánh rẽ
- BPMNDI: tọa độ shape và waypoint, không để công cụ đích vẽ chồng lên nhau

Không làm trong phiên bản này: subprocess, message flow, data object, timer, boundary event.

### 3.3. Ngữ pháp IR

Mỗi dòng một ý. Chuỗi nằm trong dấu ngoặc kép.

```text
process "Tên quy trình"
lane "Vai trò"
start s "Bắt đầu" lane "Vai trò"
end e "Xong"
task a "Việc chung" lane "Vai trò"
user b "Việc của người"
service c "Việc của hệ thống"
xor g "Câu hỏi?"
and p "Làm song song"
or o "Một hoặc nhiều hướng"
s -> a
a -> g
g -> b "Có"
g -> c "Không"
```

Bộ dịch phải tất định: cùng một IR, cùng ngôn ngữ cảnh báo, ra cùng XML về mặt phần tử và luồng. Tọa độ do thuật toán bố trí, không do mô hình ngôn ngữ.

### 3.4. Thử tình huống

Đọc BPMN đang mở, kể cả phần người dùng vừa sửa trên sơ đồ.

Hai tình huống mặc định, cộng một trạng thái “tự chỉnh” khi người dùng đổi số:

- **Việc suôn sẻ:** nhánh đồng ý khoảng 90%, làm lại khoảng 2%, thời gian gốc.
- **Nhiều trục trặc:** nhánh từ chối khoảng 70%, làm lại khoảng 20%, thời gian việc khoảng 1,25 lần.

Người dùng chỉnh được, trong mục đóng sẵn:

- số hồ sơ, từ 1 đến 2.000, mặc định 200
- số phút từng bước
- tỷ lệ phải làm lại, 0–80%
- tỷ lệ từng hướng ở cổng xor và or

Kết quả, bằng câu thường và bằng hình:

- một hồ sơ xong trong bao nhiêu phút
- thanh ngang: bước nào chiếm bao nhiêu phần trăm thời gian làm việc; thanh dài nhất là bước lâu nhất
- cột dọc: phần lớn hồ sơ xong quanh mức nào; cột lẻ bên phải là hồ sơ lâu bất thường
- thanh chia: ở mỗi chỗ rẽ, bao nhiêu phần trăm hồ sơ đi mỗi hướng
- danh sách “cần chú ý” khi có: hồ sơ không đi hết, bước phải làm lại từ 10%, hướng dưới 8% khi đã có ít nhất 30 lần rẽ, bước không hồ sơ nào đi qua
- khi đã thử từ hai tình huống: bảng và hai thanh so phút trung bình

Tải về:

- CSV: `Case_ID, Activity, Start_Timestamp, End_Timestamp, Resource, Scenario_Type`
- XES 1.0: mỗi hoạt động có sự kiện start và complete, có resource và loại kịch bản

Hình và số liệu tính trên trình duyệt từ log vừa sinh. Không gọi mô hình ngôn ngữ ở bước này.

Giới hạn phải nói rõ trên giao diện:

- chưa mô phỏng hàng đợi hay năng lực người xử lý
- “bước lâu nhất” là bước chiếm nhiều thời gian xử lý nhất, không phải thời gian chờ
- cổng OR được chạy như chọn một hướng có trọng số, không chạy nhiều hướng cùng lúc
- cổng AND chạy các hướng cùng lúc và chờ đủ nhánh rồi mới đi tiếp

Cùng đầu vào thì cùng kết quả. Bộ sinh số giả lập nhận hạt giống từ tham số, không dùng số ngẫu nhiên của hệ điều hành.

## 4. Ràng buộc kỹ thuật

- Mô hình ngôn ngữ chỉ được trả lời bằng IR. Server cắt phần giải thích thừa nếu mô hình viết kèm.
- Lượt nháp dùng mô hình rẻ, không suy luận dài. Lượt sửa, chỉ khi dịch lỗi, dùng mô hình mạnh hơn, đúng một lần.
- Khóa API chỉ ở server.
- Python là bộ dịch chuẩn. Nếu server không chạy được Python, dùng bản JavaScript cùng luật và cùng thứ tự cảnh báo.
- Giao diện một cột, chữ to, nút chính rõ. Không thuật ngữ IR, BPMN, CSV, XES, gateway trên màn hình mặc định. Những chữ đó chỉ xuất hiện trong mục đóng sẵn hoặc trên tên file.
- Không tài khoản, không cơ sở dữ liệu nghiệp vụ. Sơ đồ và log không cần lưu máy chủ.

## 5. Ngoài phạm vi

- Process mining bằng PM4Py, Disco, ProM, Celonis ngay trong web
- Hàng đợi, lịch làm việc, chi phí
- Nhiều người sửa cùng một sơ đồ
- Đăng nhập, phân quyền, thanh toán
- Miner mới, hoặc mô hình ngôn ngữ viết nhận xét về log

File CSV và XES phải mở được bằng các công cụ process mining ở trên. Đó là đường sang bước phân tích, không phải chức năng của app.

## 6. Nghiệm thu

Bên giao việc chấp nhận khi tất cả mục sau đúng:

1. Dán lời mô tả nghỉ phép tiếng Việt, bấm vẽ, ra sơ đồ có bắt đầu, kết thúc, ít nhất một chỗ rẽ, lane, và tải được `.bpmn` mở trên bpmn.io.
2. Một đoạn có hai quy trình ra hai tab. Tải từng tab và tải file gộp.
3. Sửa một dòng IR rồi vẽ lại, không phát sinh lần gọi mô hình mới. Đổi tên trên sơ đồ rồi tải, file chứa tên mới.
4. Cùng IR chạy bằng Python và bằng JavaScript cho cùng tập phần tử và cùng tập luồng.
5. IR có id gõ sai một ký tự vẫn nối được và có cảnh báo.
6. Mở ví dụ, thử “việc suôn sẻ” rồi “nhiều trục trặc”, mỗi lần 200 hồ sơ. Hai lần khác nhau về tỷ lệ nhánh Có và Không. Chạy lại cùng tham số thì số liệu không đổi.
7. CSV đủ sáu cột. XES có trace theo case và hai sự kiện start, complete cho mỗi hoạt động.
8. Đổi ngôn ngữ sang Anh: nút, câu hướng dẫn, cảnh báo bộ dịch đổi theo. Nhãn bước không bị dịch lại.
9. Trên màn hình rộng 390px không bị tràn ngang. Luồng chính dùng được không cần mở mục kỹ thuật.
10. Tắt khóa API: vẽ từ lời mô tả báo lỗi rõ; mở ví dụ và thử tình huống vẫn chạy.

## 7. Bàn giao

- Mã nguồn, không kèm thư mục phụ thuộc.
- Lệnh cài và lệnh chạy ở máy mới.
- Biến môi trường: khóa API, tên hai mô hình, lệnh Python nếu dùng.
- Kiểm thử tự động cho bộ dịch và bộ giả lập.
- Ghi chú những việc cố ý không làm, đúng mục 5.

## 8. Cách hiểu “xong”

Xong là một người chưa biết BPMN làm được việc này, không cần được giải thích thuật ngữ: viết quy trình, thấy sơ đồ, sửa được, tải file, thử hai tình huống, và mang file log sang công cụ process mining.
