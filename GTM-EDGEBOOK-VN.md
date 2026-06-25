# GTM-LAUNCH-VN.md — Kế hoạch triển khai Go-to-Market (VN, 90 ngày)

> Kế hoạch thực thi để có **những khách trả phí đầu tiên** cho `@edgebook_bot`.
> Bổ trợ cho `GTM.md` (playbook chiến lược nền) và `PLAN.md` §6.
> Cập nhật: 2026-06-13.

## 0. Bối cảnh & ràng buộc

| Yếu tố | Hiện trạng |
|---|---|
| Ngân sách paid | < 5 triệu/tháng (test nhỏ, phần lớn organic) |
| Giai đoạn | Chưa launch, < 50 user → cần user đầu + PMF |
| Mục tiêu 90 ngày | **Doanh thu / khách trả phí** (ưu tiên conversion, không đua số đông) |
| Năng lực content | Tự làm video đều → **TikTok/YT Shorts là kênh chính** |
| Target | Trader ngắn hạn VN (CK, FX, crypto) + Gen-Z crypto (Threads) |

**Định hướng cốt lõi — chia rõ vai trò phễu:**
- **TikTok / YT Shorts / Threads = engine REACH** (top-funnel, viral, kéo người tò mò vào bot).
- **FB groups + Telegram Ads + bản thân sản phẩm = engine CONVERSION** (high-intent trader → Pro/Premium).
- Gen-Z crypto (Threads) cho **awareness/viral**; khách trả phí thật chủ yếu là **trader nghiêm túc** đau pain "forward tin loạn xạ, không có hệ thống + thiếu kỷ luật".

---

## 1. Thông điệp dẫn dắt (để bán được, không chỉ để biết)

Không bán "bot lưu ghi chú". Bán **2 mũi nhọn cảm xúc** trader ngắn hạn VN đau nhất:

1. **Discipline & Psychology OS** — bot **chặn lệnh khi thua liên tiếp**, hỏi emotion 1-10, cảnh báo cortisol/adrenaline, khoá `Trade:` khi chạm daily loss limit, EOD process audit. → Angle viral & lý do trả tiền mạnh nhất: *"bot bắt tôi kỷ luật, cứu tài khoản"*.
2. **Trade Journal + Research OS** — forward 1 tin → tự tag/sentiment/digest mỗi sáng; nhật ký lệnh + win rate + PnL. → Giải pain *"forward loạn xạ, không nhớ vì sao vào lệnh"*.

---

## 2. Vai trò & tactic từng kênh

### 2.1 TikTok + YouTube Shorts — KÊNH CHÍNH (reach + viral)
- Tần suất: **3-5 video/tuần**, dọc 20-40s.
- 3 trụ nội dung (tỉ lệ ~6:3:1):
  - **Pain/Demo (60%):** quay màn hình "Forward 1 tin vào bot → sáng mai có digest tự tag + chấm sentiment". Trực quan = dễ viral.
  - **Edu/Tâm lý (30%):** "Tôi từng cháy tài khoản vì FOMO theo tin Telegram" → Discipline lock là giải pháp. Tips journaling, R-multiple, sentiment.
  - **Proof/Build-in-public (10%):** hành trình dev Việt, user wins, stats card.
- **Hook 2 giây đầu:** số/nỗi đau ("3 lần thua liên tiếp, bot này khoá lệnh tôi lại").
- **CTA:** "Bot tên @edgebook_bot — link bio". Deep link `?start=src_tiktok`.

### 2.2 Threads — Gen-Z crypto (awareness + viral text)
- 1 post/ngày: build-in-public + screenshot digest/discipline + hot-take thị trường.
- Reply có giá trị dưới post KOL crypto VN → mượn audience.
- Deep link `?start=src_threads` ở bio + post chốt.

### 2.3 Facebook Groups — retail trader VN (trust + conversion)
- Join 10-15 nhóm (ONUS, SaigonTradecoin, nhóm CK/phái sinh, FX). **Tuần 1-2 KHÔNG nhắc bot.**
- Tuần 3+: đăng "workflow quản lý research/nhật ký lệnh của mình" kèm ảnh; ai hỏi → mới giới thiệu. **Xin phép admin trước khi để link.**
- Tặng Premium vĩnh viễn cho admin/mod đổi 1 bài endorse.

### 2.4 Telegram Ads — paid test nhỏ (bottom-funnel, high-intent)
- Ngân sách: **~1.5-2 triệu/tháng** (giữ trong <5tr tổng).
- Target: channel crypto/trading/CK VN; A/B **3 creative** (1 pain Discipline, 1 demo digest, 1 Trade Journal).
- Landing thẳng vào bot với `?start=src_tgads` → đo **CPA tới activation & tới paying**.
- Cắt creative/segment không ra paying sau 2 tuần, dồn ngân sách vào cái thắng.

### 2.5 Viral loop nội tại (hạ tầng, xem §4)
- **Digest Share** (loop tự nhiên nhất) + **/invite 2 chiều** + **watermark PDF**. Nhắm K-factor ≥ 0.3.

---

## 3. Lịch 90 ngày

| Giai đoạn | Tuần | Việc chính | Mục tiêu |
|---|---|---|---|
| **0. Chuẩn bị** | 0-2 | Build 5 growth feature + onboarding + founding offer. Lập acc TikTok/Shorts/Threads, batch sẵn 8-10 video. Join 10-15 nhóm FB/TG (lurk). | Hạ tầng đo lường + kho content |
| **1. Soft launch** | 3-6 | Đăng video đều (3-5/tuần) + Threads daily. Seed digest vào 2-3 nhóm thân thiện. Bật Telegram Ads test. DM 5-10 micro-KOL (lifetime Premium + 30% affiliate). Mở founding-member promo. | 100-300 user, **3-5 khách trả phí đầu** |
| **2. Tối ưu doanh thu** | 7-12 | Nhân đôi format video thắng + ad thắng. Nudge upgrade in-bot tại aha moment. Bài endorse chính thức ở nhóm đã xin phép. Review `/growth` hàng tuần, cắt kênh lỗ. | 500-1.000 user, **15-30 khách trả phí (~2-3%)** |

**Math doanh thu (realistic):** 1.000 user × 2-3% × ~199k VND ≈ **4-6 triệu/tháng** recurring — đủ validate willingness-to-pay & tái đầu tư ads. Mục tiêu là *validate*, không phải lợi nhuận lớn.

---

## 4. Hạ tầng growth cần build (Tuần 0-2, ưu tiên)

Không có hạ tầng này thì không đo được kênh nào ra tiền → không tối ưu doanh thu. Backlog giao Claude Code:

| # | Feature | Mục đích |
|---|---|---|
| 1 | **Deep-link source tracking** `?start=src_*` → lưu `acquisitionSource` | Biết kênh nào ra user/paying |
| 2 | **`/invite` referral** 2 chiều (+7 ngày Pro khi người mới activation) | Viral loop, chống farm |
| 3 | **Share Digest button** + footer `@edgebook_bot` | Loop tự nhiên nhất |
| 4 | **Watermark PDF/report** | Marketing nội tại |
| 5 | **`/growth` admin dashboard** | Đo new users/source, activation, retention, K-factor, paying/source |

Thứ tự: #1, #3, #4 trước → #2, #5 ngay sau.

### Tinh chỉnh sản phẩm hỗ trợ conversion
- **Onboarding 60 giây:** /start → ép tới activation đầu (forward/Save 1 tin) → show ngay giá trị (auto-tag + sentiment).
- **Paywall đúng "aha moment":** chặn ở giá trị lặp (digest ngày 2, Trade Journal, Discipline lock), không chặn quá sớm.
- **Founding member offer:** N người trả phí đầu nhận giá lifetime/annual ưu đãi.
- **Giá VN:** SePay VND (199k Pro / 499k Premium) làm giá chính; **promo launch -30-50% tháng đầu**. Card quốc tế ($9.99/$24.99) dành user ngoài VN.

---

## 5. Đo lường — KPI tuần (lệnh `/growth`)

- New users theo source (`src_tiktok/threads/fb/tgads/ref`)
- **% activation** (save đầu trong 24h) — mục tiêu > 40%
- **CPA tới paying** theo kênh (Telegram Ads) — kênh nào rẻ thì scale
- **Conversion free→paid** — mục tiêu 2-3%
- **K-factor** (ref) — mục tiêu ≥ 0.3
- **W2 retention** — mục tiêu > 25%

> **Nguyên tắc:** 1 kênh làm tốt > 5 kênh làm dở. Sau 4 tuần, bỏ kênh không ra paying, dồn lực kênh thắng.

---

## 6. Rủi ro & lưu ý

- **Spam link nhóm = cháy uy tín** (cộng đồng VN nhỏ, tiếng xấu lan nhanh) → tuyệt đối value-first.
- **Gen-Z crypto ATP thấp** → coi Threads là reach/viral, đừng kỳ vọng conversion cao bằng nhóm trader nghiêm túc.
- **Giá $ quốc tế quá cao cho VN** → ưu tiên VND qua SePay + promo launch.
- **Pre-launch + revenue trong 90 ngày là tham vọng** → kỳ vọng đúng: *những khách trả phí đầu tiên để validate*, không phải doanh thu lớn.
- **Telegram long-polling 1 instance** — lưu ý khi deploy (không ảnh hưởng GTM).
