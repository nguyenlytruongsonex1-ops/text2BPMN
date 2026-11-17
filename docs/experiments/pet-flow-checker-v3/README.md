# Benchmark PET v1.1: checker cho một thuộc tính thứ tự luồng

Benchmark dùng 45 tài liệu PET v1.1. Với mỗi tài liệu, chọn một quan hệ luồng giữa hai hoạt động đã được con người gán nhãn, rồi tạo một BPMN tuần tự gồm đúng hai task, một đường đi start-to-end duy nhất: một ứng viên giữ thứ tự được hỗ trợ và một phản ví dụ đảo thứ tự. Nhãn chỉ áp dụng cho thuộc tính thứ tự luồng đã chọn trong cấu trúc ứng viên giới hạn này; không xác nhận BPMN nguồn hay ứng viên đúng về toàn quy trình.

Đây là benchmark kiểm tra một yêu cầu cố định trên các fixture BPMN hai-task. Nó không đánh giá trích xuất yêu cầu tự do, correctness toàn quy trình/BPMN tổng quát, luồng rẽ nhánh hoặc song song, hay prevalence lỗi tự nhiên trong Text2BPMN. Các fixture tổng hợp không đại diện cho đầu ra sinh thực tế. Hai biến thể của cùng tài liệu luôn nằm trong cùng split: 9 validation và 36 held-out test documents.

Với mỗi model, thí nghiệm ablation gồm bốn ô 2×2: rubric cơ bản/tăng cường (B0/B1) × không rà soát có cấu trúc/bằng chứng quan sát được có cấu trúc (E0/E1). Tắt reasoning tích hợp của provider. E1 yêu cầu bằng chứng ngắn, có thể kiểm tra; không yêu cầu chain-of-thought ẩn.

## Kết quả trên held-out test

| Checker | Cấu hình | Exact | Exact, 95% CI theo document | Coverage | False pass | False fail | Unknown | Chi phí được báo cáo |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| light | B0-E0 | 17/72 (23.6%) | 13.9–34.7% | 33.3% | 0/36 | 7/36 | 47 | $0.001697 |
| light | B1-E0 | 22/72 (30.6%) | 19.4–41.7% | 51.4% | 10/36 | 5/36 | 35 | $0.001693 |
| light | B0-E1 | 10/72 (13.9%) | 6.9–22.2% | 27.8% | 7/36 | 3/36 | 52 | $0.001717 |
| light | B1-E1 | 7/72 (9.7%) | 4.2–16.7% | 19.4% | 2/36 | 5/36 | 57 | $0.001799 |
| strong | B0-E0 | 69/72 (95.8%) | 90.3–100.0% | 95.8% | 0/36 | 0/36 | 3 | $0.010327 |
| strong | B1-E0 | 66/72 (91.7%) | 84.7–97.2% | 94.4% | 0/36 | 2/36 | 4 | $0.010980 |
| strong | B0-E1 | 63/72 (87.5%) | 80.6–94.4% | 88.9% | 0/36 | 1/36 | 8 | $0.010664 |
| strong | B1-E1 | 65/72 (90.3%) | 83.3–95.8% | 90.3% | 0/36 | 0/36 | 7 | $0.011081 |

Mỗi ô có 72 candidate: 36 positive và 36 counterexample. Exact và coverage dùng mẫu số 72; false pass/fail dùng 36 mỗi loại; unknown là candidate không có judgment pass/fail dùng được, bao gồm JSON/bằng chứng không hợp lệ. Các khoảng exact trong bảng lấy từ resampling document, không phải candidate độc lập.

## Uncertainty và cách tái lập

`scripts/pet-checker-uncertainty.mjs` chỉ đọc `results.jsonl`, không gọi API, và tái tạo `uncertainty.json`. Đơn vị là 36 test documents. Mỗi bootstrap replicate lấy mẫu có hoàn lại 36 document clusters; cả positive và counterexample của mỗi document được giữ cùng nhau. Với mỗi document, exact/coverage/false-pass/false-fail là trung bình của hai candidate (false-pass/fail chỉ phát sinh ở lớp tương ứng). Khoảng là percentile 95% hai phía từ 20.000 replicate, seed LCG cố định `0x50455433` để tái lập.

Chênh lệch exact ghép cặp strong trừ light là: B0-E0 **+72.2 điểm phần trăm** (95% CI **+61.1 đến +81.9**); B1-E0 **+61.1** (+50.0 đến +72.2); B0-E1 **+73.6** (+62.5 đến +84.7); B1-E1 **+80.6** (+70.8 đến +88.9). Đây là mô tả bất định theo document trên benchmark fixture nhỏ, không phải kiểm định xác nhận, không chứng minh ý nghĩa thống kê tổng quát hoặc superiority trên quần thể ứng dụng. Intervals cũng không xử lý khả năng lệ thuộc giữa các tài liệu PET.

## Kết luận giới hạn

- Trên đúng fixture/property này, qwen/qwen3-32b B0-E0 có exact 69/72 (95.8%), coverage 69/72 (95.8%), false pass 0/36, false fail 0/36, unknown 3. Kết quả gợi ý hiệu năng tốt hơn trong phạm vi benchmark này; không đủ để kết luận checker đúng cho quy trình BPMN nói chung hay đặt mặc định cho mọi tác vụ.
- llama-3.1-8b-instruct B1-E0 có exact 22/72 (30.6%), coverage 37/72 (51.4%), false pass 10/36, false fail 5/36, unknown 35; kết quả fixture này không ủng hộ dùng cấu hình đó làm gate tự động.
- B1/E1 không mặc định cải thiện so với B0-E0 ở các ô held-out. Không suy rộng kết quả này ngoài thuộc tính thứ tự luồng và fixture hai-task đã thử.

Tổng cộng có **720 lượt gọi**. Tổng **$0.06287318 là reported cost** cộng từ metadata usage, không phải hóa đơn được xác minh độc lập. **3/720** calls thiếu effective model, provider và cost; không xem cost thiếu là $0. Bảng là một lần chạy cho mỗi candidate/cấu hình, không có lần lặp stochastic.

Xem `protocol.json`, `cases.json`, `results.jsonl`, `summary.json`, `uncertainty.json` để biết provenance, prompt, thông tin model/provider/cost, usage và từng kết quả.
