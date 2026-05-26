# Kế hoạch triển khai: Shopee Price Tracker & Flash Sale Notifier

Dưới đây là tài liệu mô tả cách hoạt động của tính năng theo dõi giá Shopee và nhắc nhở Flash Sale cho bot Telegram.

## 1. Trải nghiệm người dùng (UX)

Người dùng tương tác với bot thông qua các lệnh đơn giản:

- **Thêm sản phẩm**: Người dùng gửi lệnh `Theo dõi https://shopee.vn/...` hoặc `Track shopee https://shopee.vn/...`. Bot phân tích link, trích xuất `shop_id` và `item_id`, sau đó phản hồi: *"✅ Đã đưa vào radar! Đang theo dõi giá cho [Tên SP]. Giá hiện tại: 150.000đ."*
- **Quản lý danh sách**: Lệnh `/shopee` hoặc `shopee list` để xem danh sách các món đang theo dõi.
- **Xóa sản phẩm**: Lệnh `Untrack shopee <số_thứ_tự>` để ngừng theo dõi.
- **Cảnh báo Deal**: Khi hệ thống quét thấy sản phẩm sắp có Flash Sale (dựa vào data trả về từ API), bot sẽ chủ động nhắn tin trước 30 phút: *"🔥 Sắp có Deal! [Tên SP] sẽ giảm còn 120.000đ vào lúc 12:00. Chuẩn bị chốt đơn!"*

## 2. Giải pháp Kỹ thuật (Technical Approach)

### A. Lấy dữ liệu từ Shopee
Sử dụng endpoint nội bộ của API Shopee (version 4):
- **Endpoint**: `https://shopee.vn/api/v4/item/get?itemid={item_id}&shopid={shop_id}`
- **Dữ liệu trả về**: 
  - Giá hiện tại (`price` / 100000)
  - Thông tin Flash Sale tại mảng `upcoming_flash_sale` (chứa `start_time` và `price`).

### B. Kiến trúc Hệ thống
1. **ShopeeService (`src/services/shopee.service.ts`)**: Sử dụng native `fetch` để gọi API Shopee và parse dữ liệu. Tự động bóc tách ID từ URL gốc của Shopee.
2. **Cron Job (Lập lịch)**: Tích hợp thư viện `node-cron`.
   - *Tần suất*: Cứ mỗi 15 phút, bot sẽ duyệt qua toàn bộ danh sách sản phẩm.
   - *Logic cảnh báo*: Nếu `upcoming_flash_sale.start_time` - `thời_gian_hiện_tại` <= 30 phút (và chưa cảnh báo trong 12h qua), bot sẽ trigger tin nhắn gửi Telegram báo động người dùng.
3. **Database (Local)**: Dữ liệu được lưu trữ dạng JSON tại `data/shopee.json`.

## 3. Thử thách & Rủi ro (Challenges)

**Anti-Bot của Shopee**
Shopee có hệ thống chặn bot cực mạnh (Cloudflare/Akamai). Nếu call API từ server quá nhiều, IP sẽ bị block và trả về lỗi 403 (Forbidden).

**Giải pháp đã áp dụng:**
- **Rate limiting nội bộ**: Thêm delay ngẫu nhiên (2 giây) giữa các lần fetch mỗi item trong vòng lặp cron.
- **Tần suất quét thấp**: Chạy 15 phút 1 lần thay vì quét liên tục mỗi giây.
- **Headers giả lập**: Truyền `User-Agent`, `Accept`, và `Referer` cố định để giả làm trình duyệt người thật.
- Khuyến cáo người dùng chỉ nên theo dõi dưới 50 sản phẩm cùng lúc.
