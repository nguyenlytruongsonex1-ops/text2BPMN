# Từ thí nghiệm checker đến ứng dụng Text2BPMN

Ngày 17/11/2026. Đây là kế hoạch và bản triển khai thử nghiệm, chưa phải kết quả chứng minh chất lượng ngữ nghĩa.

## Mục tiêu và phạm vi

Đầu ra cần có là BPMN đáp ứng yêu cầu nguồn, cùng bằng chứng và phần chưa kiểm được. Đánh giá hai checker là bước nền; ứng dụng cuối là mô tả → sinh BPMN → kiểm → chuyển cấp khi cần → đề xuất sửa → kiểm lại. Không dùng số cảnh báo giảm làm bằng chứng bản sửa đúng hơn.

Bản đầu giữ giao diện sinh/sửa sơ đồ, mô phỏng, xuất log đang có; thêm bảng yêu cầu, checker và xuất kết quả thí nghiệm. Bảng yêu cầu do LLM trích chỉ là diễn giải tạm, không phải nhãn chuẩn. Kết luận LLM không phải chứng minh hình thức; RiskGate hiện là luật chuyển cấp thử nghiệm, chưa được hiệu chỉnh bằng dữ liệu.

## Model đề xuất

| Vai trò | Model ID OpenRouter | Provider khóa cho pilot | USD / 1M input | USD / 1M output |
|---|---|---|---:|---:|
| Nhỏ, ít tốn phí | `meta-llama/llama-3.1-8b-instruct` | DeepInfra | 0.02 | 0.04 |
| Lớn hơn, cần kiểm nghiệm chất lượng | `qwen/qwen3-32b` | DeepInfra | 0.08 | 0.28 |

Giá chụp ngày 17/11/2026 từ [OpenRouter Llama](https://openrouter.ai/meta-llama/llama-3.1-8b-instruct) và [OpenRouter Qwen](https://openrouter.ai/qwen/qwen3-32b). Khóa provider và tắt fallback để không âm thầm thay điều kiện; giá và khả dụng có thể đổi. Lưu model/provider thực, token, chi phí trả về, prompt version và thời điểm cho từng lượt.

Đây là cặp triển khai hai tầng, không phải thí nghiệm cô lập ảnh hưởng số tham số: hai model khác họ, dữ liệu và cách huấn luyện. Không giả định Qwen luôn tốt hơn. Cặp Qwen3 14B/32B cùng họ là đối chứng phụ phù hợp hơn cho ảnh hưởng kích thước nhưng giá hiện tại không tạo lợi thế rõ cho tầng nhỏ.

Hai smoke call tổng hợp đã thành công HTTP 200, cùng DeepInfra, JSON hợp lệ; tổng phí API báo **$0.00001938**. Đây chỉ là kiểm kết nối/schema, không là benchmark checker. Khóa đã lưu được dùng trong bộ nhớ phía server, không đưa vào mã nguồn, trình duyệt hoặc kết quả xuất.

Ví dụ ngân sách: giả sử 3,000 input + 500 output token/lượt, chưa tính reasoning, retry hoặc phát sinh khác, một lượt nhỏ khoảng $0.00008; lượt lớn khoảng $0.00038. Với xác suất chuyển cấp p, riêng phí kiểm khoảng $0.00008 + p × $0.00038. So luôn gọi lớn, điều kiện hòa vốn giản lược là p < 78.9%. Đây chỉ là phép tính minh họa; kết luận tiết kiệm dùng usage thực và tính cả trích yêu cầu, sinh, repair, validator và overhead.

## Kế hoạch triển khai có điểm kiểm tra

| Bước | Việc làm | Đầu ra và điều kiện chuyển bước |
|---|---|---|
| 1. Khóa hợp đồng | Nguồn, requirement ID + câu nguồn, BPMN snapshot, rubric và schema | Version/hash rõ; nguồn mơ hồ giữ unknown; chưa lấy BPMN suy ra yêu cầu |
| 2. Pilot dữ liệu | Audit 45 mô tả PET và ánh xạ nhãn sẵn có; nhóm theo quy trình gốc trước khi chia | Không gán nhãn người mới; PET chấm phần nhãn hỗ trợ; không mặc định toàn BPMN đúng |
| 3. Ca có chứng cứ | Tạo tập nhỏ theo đặc tả tường minh, ca bảo toàn và mutation đã được oracle xác nhận | Phản ví dụ là vết vi phạm khả thi; không nhân tất cả record; mutation cùng nguồn chung split |
| 4. Checker × prompt | Chạy 2 model × P0 cơ bản / P1 thêm rubric / P2 cùng rubric + xét từng yêu cầu | Cùng BPMN và schema; P1−P0 đo rubric, P2−P1 đo hướng dẫn từng bước; lỗi JSON/timeout/truncation là unknown |
| 5. Chọn cặp và RiskGate | Chọn cấu hình trên validation; khóa ngưỡng, biên và test | Đo FNR, báo nhầm, unknown, evidence validity và chi phí; so light-only, strong-only, random cùng tỷ lệ, confidence threshold; không dùng strong làm nhãn chuẩn |
| 6. Repair có kiểm lại | Giữ bản gốc, đề xuất sửa riêng, giới hạn số vòng và token | Xác nhận lỗi đích hết và kiểm lại mọi yêu cầu bắt buộc trong phạm vi; lưu lỗi mới/tồn dư và phần không kiểm được |
| 7. Text2BPMN thực | Mô tả mới chưa dùng phát triển → generator cố định → các chính sách kiểm–sửa | Đo trước/sau, lỗi sinh tự nhiên, mức chấp nhận sai, coverage, cost toàn pipeline, p50/p95; không ngoại suy từ mutation |

## Thiết kế thí nghiệm

P0/P1/P2 giữ cùng model/provider, thông tin đầu vào, schema kết luận và công cụ được cấp. P2 yêu cầu bằng chứng ngắn theo từng yêu cầu; không yêu cầu xuất suy nghĩ nội bộ. Tắt native thinking trong thí nghiệm prompt chính nếu provider hỗ trợ; ghi cấu hình và token thực. Chế độ thinking/reasoning là thí nghiệm riêng, không trộn vào tác dụng của prompt. Kiểm tra [cấu hình reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) theo provider.

Chạy lặp để đo ổn định dù temperature 0; chọn số lượt và ngân sách sau pilot, không gọi hàng loạt trước khi có ước lượng token. Tách phép đo trên ứng viên cache (cô lập checker) khỏi pipeline sinh mới. Các mô tả, paraphrase và biến thể cùng nguồn không được rải qua train/validation/test.

Không có người chấm mới: dùng annotation PET có sẵn, oracle với phạm vi hình thức công bố, và silver đa model tách riêng. Nếu chưa có nhãn đủ độc lập cho một loại lỗi, báo unknown/coverage hoặc agreement, không tuyên bố accuracy hay không-kém-hơn cho loại đó. Với tập PET nhỏ, báo khoảng tin cậy theo cụm quy trình; chưa đủ lực thống kê thì ghi chưa kết luận.

## Tích hợp ứng dụng và cấu hình

Khóa chỉ là biến môi trường phía server `OPENROUTER_API_KEY`; không dùng tiền tố `VITE_`, không nhập/lưu khóa qua UI. Generator hiện có dùng `OPENROUTER_MODEL`; hai checker dùng `OPENROUTER_LIGHT_MODEL` và `OPENROUTER_STRONG_MODEL`. Tách generator khỏi checker để không vô tình đổi cả hai khi so cấu hình. Không lưu khóa vào file trong repo.

Giao diện phải kiểm XML hiện tại trên canvas, không chỉ IR cũ; kết quả gắn snapshot và được đánh dấu hết hiệu lực khi nguồn, yêu cầu hoặc sơ đồ đổi. Bản sửa chỉ là đề xuất, không thay bản gốc tự động hoặc được trình bày là đã xác minh. Xuất JSON gồm snapshot, cấu hình, các tầng kết luận, định tuyến, usage và scope để có thể audit.

Ứng dụng không tải nhãn PET vào prompt checker, không đưa oracle witness của test cho router. Bộ chạy nghiên cứu có nhãn độc lập là bước riêng; nút so sáu cấu hình trên UI chỉ thu judgment và chi phí, không tự sinh benchmark accuracy.


## Kết quả benchmark PET và pilot giao diện

- [Benchmark checker PET v1.1](experiments/pet-flow-checker-v3/README.md) kiểm 45 tài liệu, 90 ứng viên và một thuộc tính thứ tự luồng cố định trên mỗi tài liệu. Trong tám ô benchmark (B0/B1 × E0/E1 cho mỗi model), qwen/qwen3-32b B0-E0 đạt 69/72 exact (95.8%), coverage 95.8%, false pass 0/36, false fail 0/36 và 3 unknown; llama-3.1-8b-instruct tốt nhất ở validation B1-E0 nhưng held-out chỉ đạt 22/72 exact (30.6%), coverage 51.4%, false pass 10/36, false fail 5/36 và 35 unknown. Trên đúng fixture benchmark này, model mạnh đạt kết quả cao hơn; đây không đủ cơ sở để mặc định nó cho tác vụ khác hoặc kết luận correctness quy trình. Model nhẹ cũng chưa đạt trên fixture này. Rubric và structured evidence không mặc định cải thiện kết quả. Tổng cộng 720 calls, reported cost $0.06287318 và 3 lượt thiếu effective model/provider/cost metadata. Khoảng bất định ghép cặp resample theo 36 tài liệu test; xem báo cáo, không diễn giải như bằng chứng thống kê phổ quát.
- Benchmark này không đánh giá toàn bộ tính đúng đắn BPMN, trích xuất yêu cầu, tỷ lệ lỗi Text2BPMN tự nhiên hoặc chứng minh thống kê phổ quát. Mỗi ô là một lượt chạy xác định trên tập held-out gồm 36 tài liệu; mỗi tài liệu có positive và counterexample fixture tuần tự hai-task. Kết quả không đo prevalence lỗi tự nhiên hoặc correctness toàn quy trình; xem báo cáo để biết phương pháp và giới hạn bootstrap theo cụm tài liệu.
- [E2E sinh → kiểm sáu cấu hình](experiments/checker-e2e-2026-11-17/README.md): đây là UI pilot P0/P1/P2, gồm sáu cấu hình trên 3 mô tả có kiểm soát và 25 lời gọi API; không phải benchmark PET tám ô B0/B1 × E0/E1. Đây không phải PET hoặc tập dữ liệu doanh nghiệp; xem ledger và oracle audit để biết phạm vi, lỗi giao thức và chi phí chưa có metadata.
- [Nhánh lỗi kiểm soát → đề xuất sửa → kiểm lại](experiments/checker-fault-pilot-2026-11-17/README.md): dùng một biến thể đảo thứ tự đã được oracle xác nhận, tách biệt với lỗi sinh tự nhiên. Không gộp hai nguồn để suy ra tỷ lệ lỗi thực tế.
- Giao diện đã kiểm ở desktop/mobile, bản dev và bản build. Luồng live kiểm được việc sửa XML trên canvas làm cũ kết quả. [Ảnh desktop](checker-desktop.png), [ảnh mobile](checker-mobile.png).

Kết quả nhỏ này dùng để kiểm quy trình và phát hiện lỗi triển khai, không đủ để tuyên bố model lớn tốt hơn nói chung, CoT luôn có lợi, hoặc RiskGate đạt không-kém-hơn. Bảng yêu cầu tự trích có thể thêm diễn giải không được nguồn hỗ trợ dù câu trích khớp nguyên văn; vì vậy không dùng chính bảng đó làm nhãn chuẩn.

Hạn chế quan sát được: metadata chi phí có thể thiếu khi upstream trả JSON lỗi; phí đã báo không phải tổng phí tuyệt đối. UI hiển thị usage của lần trích/sửa thành công, nhưng lượt trích/sửa thất bại chưa được lưu đủ usage trong bản ghi UI; runner thí nghiệm có ledger riêng để theo dõi các lượt đó. Kiểm soát admission theo process không thay thế auth/ngân sách dùng chung khi triển khai công khai. Bộ test đầy đủ của template còn phụ thuộc `.grok` không được lưu trong repo; các lỗi nền này được ghi trong PR, không tính thành test checker đã qua.


### Ranh giới truy cập checker tính phí

Cả bốn hàm server có tính phí đều đi qua `authMiddleware` đã xác minh của ứng dụng. Ở production, hệ thống từ chối mặc định nếu chưa bật `VITE_AUTH_ENABLED=true`. Ứng dụng chưa có bộ giới hạn chi tiêu dùng chung, bền vững theo người dùng; ngân sách request trong process chỉ là chốt cục bộ cho pilot, không phải giới hạn tốc độ production. Chỉ bật lời gọi tính phí ở production sau khi xác thực đã được bật và giới hạn chi tiêu dùng chung hoặc ở edge đã được triển khai.

Trong pilot cục bộ, cần đặt `OPENROUTER_CHECKER_ENABLED=true` và `OPENROUTER_API_KEY` chỉ ở phía server. Báo cáo sửa do client gửi lên được xem là dữ liệu không đáng tin: chỉ chuyển tiếp các trường đánh giá trong allow-list, thuộc các requirement ID đã biết, đồng thời giới hạn nghiêm ngặt kích thước. Fingerprint của báo cáo không tự chứng minh tính toàn vẹn. UI phân biệt model được yêu cầu với model thực tế do provider báo về, kể cả khi provider không cung cấp thông tin model thực tế.
