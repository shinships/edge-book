# EdgeBook — Hướng dẫn cài đặt

## Cài đặt Supabase

### 1. Tạo project Supabase

1. Vào [supabase.com](https://supabase.com/) → New project
2. Chọn region gần nhất (Singapore cho VN)
3. Đặt tên project và database password (lưu lại)

### 2. Lấy `DATABASE_URL`

- Dashboard → Project Settings → Database → Connection string
- Chọn tab **Pooler** (Transaction mode, port 6543)
- Copy string dạng:

```
postgresql://postgres.[project-ref]:[password]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
```

### 3. Thêm vào `.env` và push schema

```env
# .env
DATABASE_URL=postgresql://postgres.xxxxx:password@...
```

Sau đó chạy:

```bash
npm run db:push   # tạo schema trong Supabase
npm run db:seed   # migrate data từ JSON cũ (nếu có)
```

---

## Cài đặt Google APIs

Bot dùng Google Docs, Calendar, Drive — tất cả qua Service Account (không cần OAuth từng user).

### 1. Tạo Google Cloud Project

1. Vào [console.cloud.google.com](https://console.cloud.google.com/)
2. New Project → đặt tên (vd: `edgebook-bot`)

### 2. Bật APIs cần thiết

Vào **APIs & Services → Library**, bật 3 API:

- Google Docs API
- Google Drive API
- Google Calendar API

### 3. Tạo Service Account

1. APIs & Services → Credentials → Create Credentials → Service Account
2. Đặt tên → Create
3. Vào service account vừa tạo → Keys → Add Key → JSON
4. Download file JSON → đổi tên thành `service_account.json`
5. Copy file vào thư mục gốc project (gitignored, **KHÔNG commit**)

### 4. Chia sẻ quyền

Service Account có email dạng `xxx@project.iam.gserviceaccount.com`:

- **Google Doc**: mở Doc → Share → paste email đó → Editor
- **Google Drive folder**: tương tự → share folder với email đó
- **Google Calendar**: Calendar Settings → Share → paste email → "Make changes to events"

### 5. Lấy IDs điền vào `.env`

```env
GOOGLE_APPLICATION_CREDENTIALS=service_account.json
GOOGLE_DOC_ID=           # lấy từ URL docs.google.com/document/d/[ID]/edit
GOOGLE_DRIVE_FOLDER_ID=  # lấy từ URL drive.google.com/drive/folders/[ID]
```

---

## Khởi chạy

Sau khi hoàn thành 2 bước trên + điền `ADMIN_USER_IDS` là Telegram ID của bạn vào `.env`:

```bash
npm start
```

Bot sẽ chạy full với tất cả tính năng.
