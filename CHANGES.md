# Danh sách thay đổi

## Lỗi đã sửa
1. `npm start` chạy sai: `node server.ts` không chạy được file TypeScript và còn bật nhầm chế độ dev (Vite). Nay là `tsx server.ts --prod`; `tsx` chuyển sang `dependencies`.
2. Độ lệch ảnh (`offsetX/offsetY`) được lưu nhưng không bao giờ áp vào CSS cho ảnh không phải cover-overlay (`src/utils/imageManager.ts`). Nay áp bằng `translate3d(...)`.
3. README bảo đặt khóa trong `.env.local` nhưng server chỉ đọc `.env`. Nay đọc cả hai.
4. 4 route AI (`discover-*`, `apply-html-feedback`) không xử lý lỗi 403/429 như `analyze-theme`, và `apply-html-feedback` luôn trả 500. Nay dùng chung hàm `sendAiError`.
5. Lỗi body quá lớn / JSON sai trả trang HTML; nay trả JSON (413 / 400). API không tồn tại trả 404 JSON thay vì `index.html`.
6. Test cũ `scattered-couple-stage` không khớp markup hiện tại, đã cập nhật.

## Tối ưu / bảo mật
- Giới hạn lượt gọi `/api/ai` theo IP (mặc định 30/phút, không thêm thư viện).
- `PORT`, `GEMINI_MODEL`, `AI_RATE_LIMIT_PER_MIN`, `TRUST_PROXY` cấu hình qua biến môi trường.
- Tắt `x-powered-by`, cache static 1 giờ, tắt server êm khi nhận SIGTERM/SIGINT.
- Báo lỗi rõ khi chạy production mà chưa `npm run build`.
- Thêm script `npm test`; đổi tên package; viết lại README.

## Kết quả kiểm tra
`weddingLogic.test.ts`: 24/24 đạt (trước đó 22/24).

## Việc nên làm tiếp (chưa tự làm để tránh xóa nhầm)
- Chạy lại `npm install` (hoặc `bun install`) để cập nhật lockfile vì `package.json` đổi.
- Xóa khỏi git (không dùng trong code): thư mục `.aistudio/` (~20MB), ảnh `envelope_closed.png`, `card_opened.png`, `standalone_snap.png`, `standalone_opened.png` ở thư mục gốc, thư mục `src/assets/images/` (bản trùng với `public/assets/envelope/`), và `public/thiep-cuoi-gia-khiet-nguyen-van.html` nếu chỉ là file xuất thử.
- Chạy `npm run lint` trên máy bạn. Mình không cài được dependency (sandbox không có mạng) nên chưa kiểm tra kiểu đầy đủ cho các component React.
