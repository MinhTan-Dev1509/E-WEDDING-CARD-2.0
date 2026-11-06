# E-Wedding Card System

Hệ thống tạo thiệp cưới điện tử (E-Card) bằng React + Vite + Express, có AI Gemini hỗ trợ chọn chủ đề, phong bì, hoạt ảnh và xuất file `.html` độc lập.

## Yêu cầu

- Node.js 20 trở lên
- Khóa Gemini API (chỉ cần cho các tính năng AI)

## Chạy local

1. Cài thư viện: `npm install`
2. Tạo file `.env.local` (hoặc `.env`) từ `.env.example` và điền `GEMINI_API_KEY`
3. Chạy chế độ phát triển: `npm run dev` rồi mở http://localhost:3000

## Chạy production

```bash
npm run build   # build giao diện vào thư mục dist
npm start       # chạy server ở chế độ production (phục vụ dist)
```

## Lệnh hữu ích

| Lệnh | Tác dụng |
| --- | --- |
| `npm run dev` | Server + Vite dev (HMR) |
| `npm run build` | Build giao diện vào `dist/` |
| `npm start` | Server production |
| `npm test` | Chạy bộ test logic/xuất HTML |
| `npm run lint` | Kiểm tra kiểu TypeScript |

## Biến môi trường

Xem `.env.example`: `GEMINI_API_KEY`, `PORT`, `GEMINI_MODEL`, `AI_RATE_LIMIT_PER_MIN`, `TRUST_PROXY`.
