# text2BPMN

Mô tả quy trình bằng lời (tiếng Việt / tiếng Anh) → sơ đồ BPMN chỉnh sửa được → mô phỏng → event log CSV/XES.

![Screenshot](docs/screenshot.png)

## Kiến trúc

![Kiến trúc](docs/architecture.png)

Chỉ bước LLM tốn token. Chi tiết: [docs/kien-truc-text2BPMN.pdf](docs/kien-truc-text2BPMN.pdf)

## Chạy

Cần Node 22.

```bash
npm install
npm run dev   # http://localhost:8080
```

Key là tùy chọn (không có key vẫn chạy ví dụ mẫu, mô phỏng và xuất log):

- `OPENROUTER_API_KEY` — model đặt bằng `OPENROUTER_MODEL` (mặc định `qwen/qwen3.5-9b`)
- hoặc `XAI_API_KEY`

## Kết quả (qwen3.5-9b)

Số cảnh báo mỗi lần chạy (3 lần), trước → sau khi sửa prompt:

| Ví dụ | Trước | Sau |
|---|---|---|
| Đặt hàng | 9 / 13 / 12 | 0 / 0 / 0 |
| Song song (onboarding) | 29 / 13 / 29 | 0 / 0 / 0 |
| Vòng lặp (sửa luận văn) | 21 / 41 / 18 | 0 / 1 / 1 |

PET dataset: 12/12 văn bản sinh được sơ đồ.

Kiểm tra log tự động (replay log trên sơ đồ, `verify.ts`): đặt hàng, song song, vòng lặp đều hợp lệ 50/50 và 200/200 hồ sơ ở cả "Việc suôn sẻ" lẫn "Nhiều trục trặc".

## Chi phí 1000 truy vấn

| Model | Chi phí |
|---|---|
| qwen3.5-9b | ≈ $0,29 thực trả ($0,40 theo bảng giá) |
| gemini-2.5-flash-lite | ≈ $0,38 (ước tính) |

Mô phỏng và xuất log: 0 token.
