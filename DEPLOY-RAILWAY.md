# Deploy EdgeBook lên Railway (kèm SePay webhook)

Hướng dẫn đưa bot từ Windows Service local lên Railway để SePay webhook nhận được giao dịch (cần URL public).

## 0. Trước khi bắt đầu — TẮT bot local

Telegram chỉ cho **1 consumer `getUpdates`**. Phải dừng Windows Service trước, nếu không Railway sẽ báo 409 Conflict.

```powershell
# chạy trong shell Admin
sc stop EdgeBookBot.exe
# hoặc: npm run service:uninstall
```

## 1. Lấy SePay credentials (dashboard https://my.sepay.vn)

- **Tài khoản nhận tiền**: số tài khoản + ngân hàng đã liên kết với SePay.
- **API Key**: SePay → Cấu hình → API Token (dùng cho `Authorization: Apikey <key>` webhook gửi tới).
- Mã ngân hàng VietQR (short code), ví dụ `MBBank`, `Vietcombank`, `ACB`...

## 2. Tạo base64 cho service_account.json

Railway không có filesystem cố định, nên đưa file SA qua biến môi trường base64. Chạy local:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service_account.json")) | Set-Clipboard
```

Chuỗi base64 giờ đã nằm trong clipboard — dán vào biến `GOOGLE_SA_BASE64` ở bước 4.

## 3. Push code lên GitHub

Railway deploy từ GitHub repo. Đảm bảo `.env` và `service_account.json` **vẫn gitignore** (không commit secrets).

## 4. Tạo project trên Railway

1. railway.app → New Project → Deploy from GitHub repo → chọn repo này.
2. Railway tự đọc `railway.json`: build `npm run build`, start `npm start`, healthcheck `/health`.
3. Vào tab **Variables**, thêm các biến (KHÔNG set `WEBHOOK_PORT` / `PORT` — Railway tự cấp `PORT`):

| Biến | Giá trị |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token bot |
| `VERTEX_KEY_API_KEY` | key vertex-key.com |
| `VERTEX_KEY_BASE_URL` | `https://vertex-key.com/api/v1` |
| `AI_CHAT_MODEL` | `aws/claude-sonnet-4-6-medium` |
| `AI_FAST_MODEL` | `free/claude-haiku-4-5` |
| `DATABASE_URL` | connection string Supabase (port **6543**) |
| `GOOGLE_APPLICATION_CREDENTIALS` | `./service_account.json` |
| `GOOGLE_SA_BASE64` | chuỗi base64 ở bước 2 |
| `GOOGLE_DOC_ID` | doc ID mặc định |
| `GOOGLE_DRIVE_FOLDER_ID` | folder ID Drive |
| `ADMIN_USER_IDS` | `1563046373,7848346466` |
| `SEPAY_ACCOUNT_NUMBER` | số tài khoản nhận tiền |
| `SEPAY_BANK_CODE` | mã NH VietQR, vd `MBBank` |
| `SEPAY_ACCOUNT_HOLDER` | tên chủ TK (in hoa, không dấu) |
| `SEPAY_API_KEY` | API key SePay |
| `SEPAY_PRO_PRICE_VND` | `199000` (tuỳ chọn) |
| `SEPAY_PREMIUM_PRICE_VND` | `499000` (tuỳ chọn) |

4. Deploy. Xem **Deploy Logs**, chờ dòng `🔗 Webhook server running on port ...` và `Payment: SePay VietQR enabled`.

## 5. Lấy URL public + cấu hình webhook SePay

1. Railway → Settings → **Networking** → Generate Domain. Sẽ ra dạng `https://edgebook-production.up.railway.app`.
2. Test health: mở `https://<domain>/health` → phải trả `{"status":"ok",...}`.
3. SePay dashboard → Webhooks → thêm endpoint:
   - **URL**: `https://<domain>/webhook/sepay`
   - **Phương thức xác thực**: API Key (Authorization header) — đúng key đã đặt ở `SEPAY_API_KEY`.

## 6. Test end-to-end

1. Trong Telegram gõ `/upgrade` → chọn Pro → bot gửi QR.
2. Quét QR, chuyển đúng nội dung + số tiền.
3. Sau vài giây bot DM "🎉 Thanh toán thành công" và `/plan` hiện tier mới.
4. Nếu chuyển sai nội dung/thiếu tiền → admin (`ADMIN_USER_IDS`) nhận cảnh báo để xử lý tay.

## Ghi chú

- **DATABASE_URL dùng port 6543** (transaction pooler) cho runtime — OK trên Railway. Chỉ `db:push` mới cần đổi sang 5432 (làm local, không làm trên Railway).
- **Không chạy song song** Windows Service local và Railway cùng lúc (409 Conflict).
- `GOOGLE_SA_BASE64` chỉ được ghi ra file khi file chưa tồn tại — an toàn, không đè file local.
