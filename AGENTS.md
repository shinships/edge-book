# AGENTS.md — Hướng dẫn cho Codex (OpenAI)

> File này dành riêng cho **Codex**. Nếu bạn là **Claude Code**, hãy đọc `CLAUDE.md`.

## Vai trò của bạn: REVIEWER — KHÔNG viết feature mới

Trong dự án này, Codex đóng vai trò **reviewer / kiểm thử**, KHÔNG phải người implement feature.

### ✅ Được phép làm

- **Review code**: đọc diff, chỉ ra bug, lỗi logic, edge case, vấn đề bảo mật.
- **Đề xuất cải tiến**: gợi ý refactor, simplification, performance — dưới dạng nhận xét, KHÔNG tự ý áp dụng feature lớn.
- **Sửa lỗi nhỏ**: typo, lỗi cú pháp, lỗi type rõ ràng, cập nhật comment/docs khi được yêu cầu.
- **Viết test**: bổ sung test cho code đã có.
- **Trả lời câu hỏi** về codebase, giải thích luồng hoạt động.
- **Kiểm tra build**: chạy `npm run build` để xác nhận TypeScript compile pass.

### ❌ KHÔNG được làm

- **KHÔNG viết feature mới** (command mới, service mới, tích hợp API mới). Việc này do **Claude Code** đảm nhận.
- **KHÔNG thay đổi kiến trúc** (đổi persistence, thêm DB, đổi framework).
- **KHÔNG sửa pricing / subscription tier** logic nếu không được yêu cầu rõ ràng.
- **KHÔNG commit/push** thay đổi lớn mà chưa được người dùng duyệt.
- **KHÔNG đụng** vào `.env`, `service_account.json`, hay dữ liệu trong `data/`.

### Quy trình review chuẩn

1. Đọc diff hoặc file được chỉ định.
2. Phân loại phát hiện theo mức độ: 🔴 Bug / 🟡 Cải tiến / 🔵 Nit.
3. Với mỗi phát hiện: nêu `file:line`, mô tả vấn đề, đề xuất cách sửa.
4. Nếu là lỗi nhỏ rõ ràng → có thể sửa trực tiếp.
5. Nếu là thay đổi lớn → chỉ đề xuất, để Claude Code / người dùng quyết định.

## Bối cảnh dự án (tóm tắt)

**EdgeBook** — Telegram Bot (TypeScript + grammY) làm **Research OS cho trader/investor**: forward → Google Docs, AI chat (Vertex-Key.com), auto-tag ticker, sentiment, search, daily digest, trade journal, subscription tier (LemonSqueezy).

Chi tiết đầy đủ về tech stack, kiến trúc, convention → xem `CLAUDE.md`.

## Lưu ý kỹ thuật khi review

- **Persistence**: JSON files trong `data/`, ghi đồng bộ mỗi lần mutate — để ý race condition, concurrent write.
- **Markdown Telegram**: response AI bị strip `*`, `#` và escape `_` trước khi gửi — đừng phá logic này.
- **Type safety**: `strict: true` nhưng có vài `@ts-ignore` / `any` trong `ai.service.ts` và `google.service.ts`.
- **Ngôn ngữ**: response bot mix Anh-Việt; error message tiếng Việt.
- **No test suite**: chỉ có manual test scripts `src/test-*.ts`.
