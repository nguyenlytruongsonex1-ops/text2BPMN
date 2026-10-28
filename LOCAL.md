# Chạy text2BPMN trên máy local

Cần Node.js 22. Python 3 là tùy chọn: có thì dịch BPMN bằng Python, không có thì app tự dùng JavaScript.

## Cài và chạy

```bash
npm install
npm run dev
```

Mở http://localhost:8080

Ví dụ sẵn, sửa sơ đồ, thử tình huống và tải file chạy được ngay, không cần khóa AI.

## Vẽ sơ đồ từ lời mô tả

Tạo file `.env` cạnh `package.json`:

```bash
XAI_API_KEY=khóa_từ_console.x.ai
```

Rồi chạy lại `npm run dev`. Không có khóa, nút vẽ báo AI chưa sẵn sàng. Dán danh sách bước và bấm dịch lại vẫn dùng được.

Tùy chọn: đặt `OPENROUTER_API_KEY` (và `OPENROUTER_MODEL`, mặc định `qwen/qwen3.5-9b`) để gọi qua OpenRouter thay cho xAI.

## Kiểm thử phần dịch và giả lập

```bash
node --experimental-strip-types --test src/lib/bpmn/sim.test.ts
python3 src/lib/bpmn/ir_to_bpmn.py < src/lib/bpmn/samples.ts
```

Lệnh Python thứ hai chỉ để thấy script chạy. Bộ kiểm thử chính là lệnh Node.
