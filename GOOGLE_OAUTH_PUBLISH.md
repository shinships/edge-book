# Publish Google OAuth App — Hướng dẫn từng bước

> Mục tiêu: đưa OAuth consent screen của EdgeBook từ **Testing** (giới hạn 100 test user, phải add tay từng email) sang **Production** để bất kỳ user nào cũng Connect Docs được, không cần whitelist.

## 0. Có cần làm ngay không?

- Ở Testing: tối đa **100 test user**, mỗi user phải được add tay vào Audience → Test users. Vượt quá hoặc user lạ bấm Connect sẽ bị Google chặn ("App chưa xác minh — chỉ user test mới vào được").
- Scope bot dùng là **`drive.file`** — Google xếp loại **non-sensitive** (per-file, không phải Restricted/Sensitive scope như Gmail/Drive full). Điều này quan trọng vì:
  - Publish lên Production **không** yêu cầu security assessment (cái đó chỉ bắt buộc với Restricted scopes).
  - Có thể vẫn cần **basic verification** (xác minh thông tin cơ bản: domain, branding, privacy policy) nếu Google flag, nhưng thường nhanh (vài ngày) hoặc đôi khi auto-pass với scope non-sensitive.
- Nếu user hiện tại < 100 và toàn người quen/beta tester → **chưa cần publish gấp**, cứ add test user thủ công. Làm bước này khi muốn mở public thật.

## 1. Chuẩn bị trước khi publish

Google yêu cầu các mục sau phải có **trước khi** bấm Publish (Audience tab sẽ chặn nếu thiếu):

1. **Privacy Policy URL** — 1 trang web public mô tả bot thu thập/dùng dữ liệu gì.
   - Nếu chưa có domain/landing page: dùng GitHub Pages, Notion public page, hoặc 1 trang tĩnh đơn giản. Nội dung tối thiểu: bot tên gì, thu thập gì (Telegram user id, nội dung forward, refresh token Google OAuth), dùng để làm gì (lưu research cá nhân), không bán/share dữ liệu cho bên thứ 3, cách liên hệ (email).
   - Đặt URL này vào **Branding tab → Privacy Policy link**.
2. **App homepage** (khuyến nghị, không luôn bắt buộc) — 1 trang giới thiệu app, có thể trùng domain với privacy policy.
3. **App name + logo** — Branding tab. Đổi "App name" nếu đang còn tên cũ ("Slaysaver" hay tên project khác) thành **EdgeBook**. Logo: optional, nhưng nếu upload logo Google có thể bắt thêm bước xác minh ownership — nếu muốn né, **bỏ qua logo**.
4. **Authorized domain** — domain chứa privacy policy phải được add vào Branding tab → Authorized domains, và bạn phải sở hữu được nó (Google Search Console verify nếu được hỏi). Railway subdomain (`*.up.railway.app`) **không dùng được** làm authorized domain cho mục đích này — cần 1 domain riêng (kể cả domain free như từ Freenom/Cloudflare, hoặc subdomain bạn control DNS).
   - Nếu chưa có domain riêng: cách nhanh nhất là dùng GitHub Pages (`username.github.io`) — domain này Google thường accept vì verify qua GitHub.
5. **Support email** — Branding tab, 1 email còn hoạt động (vd email bạn đang dùng).

## 2. Các bước trên Google Cloud Console

1. Vào **Google Auth Platform** (project `fw-docs` hoặc tên project hiện tại).
2. **Branding tab**:
   - App name: `EdgeBook`
   - User support email: email của bạn
   - App logo: bỏ qua (xem lưu ý ở bước 1.3)
   - App home page: URL trang giới thiệu (hoặc privacy policy page nếu không có trang riêng)
   - App Privacy Policy link: URL đã chuẩn bị ở bước 1.1
   - Authorized domains: domain chứa các URL trên
   - Save.
3. **Data Access tab**: xác nhận scope đang khai báo đúng 1 scope `.../auth/drive.file`, không thừa scope nào khác (thừa scope sensitive sẽ kéo theo yêu cầu verification nặng hơn).
4. **Audience tab**:
   - Kiểm tra "Publishing status" hiện tại = Testing.
   - Bấm **"Publish App"**.
   - Confirm dialog: Google hỏi xác nhận chuyển sang Production — bấm Confirm.
   - Một trong hai chuyện sẽ xảy ra:
     - **(a) Auto-approve** — status chuyển thẳng "In production". Xong, không cần làm gì thêm.
     - **(b) Cần verification** — Google hiện banner yêu cầu nộp app để review. Sang bước 3.

## 3. Nếu bị yêu cầu Verification (trường hợp b)

1. Audience tab sẽ hiện nút **"Submit for verification"** hoặc form yêu cầu điền thêm.
2. Điền **Application justification** — giải thích ngắn vì sao cần scope `drive.file`, ví dụ:
   > "EdgeBook is a personal research assistant bot. With user consent, it creates a single Google Doc in the user's own Drive and appends notes the user explicitly saves via our Telegram bot. The app only accesses files it creates itself (drive.file scope), never the user's existing files."
3. Một số trường hợp Google yêu cầu **demo video** (screen recording) quay lại flow: bấm Connect Docs trong Telegram → consent screen Google → bot tạo Doc → append nội dung vào Doc đó. Quay 1-2 phút bằng bất kỳ tool screen-record, upload YouTube **Unlisted**, paste link vào form.
4. Submit. Thời gian review thường **vài ngày đến ~1-2 tuần** (scope non-sensitive nên thường nhanh, không qua security assessment).
5. Trong lúc chờ review, app **vẫn ở Testing** — vẫn dùng được cho test users hiện có, không bị gián đoạn.
6. Khi được approve, Google gửi email và status tự chuyển "In production".

## 4. Sau khi Publish — kiểm tra lại

1. Mở incognito / tài khoản Google **chưa từng** add làm test user.
2. Trong Telegram, gõ `Connect Docs` → bấm nút → đăng nhập Google bằng tài khoản lạ đó.
3. Kỳ vọng: **không** còn thấy màn "Google hasn't verified this app" chặn cứng — nếu app chưa qua verification nhưng đã publish, có thể vẫn thấy 1 cảnh báo nhẹ "unverified app" với nút "Advanced → Go to EdgeBook (unsafe)" — **vẫn dùng được**, chỉ là cảnh báo, không phải lỗi.
4. Xác nhận flow chạy hết: consent → callback `/oauth/google/callback` → DM Telegram báo kết nối thành công → forward 1 tin → check Doc trên Drive của tài khoản test có nội dung mới.

## 5. Lưu ý

- **Không cần publish nếu < 100 user và chấp nhận add tay test user** — Production chỉ cần khi muốn public hoàn toàn không whitelist.
- **Giữ nguyên `TOKEN_ENC_KEY`** trong suốt quá trình này — publish không liên quan tới key mã hoá, nhưng nhắc lại vì đổi key sẽ làm mất hết refresh token user cũ đã connect (xem memory `oauth-google-docs`).
- Nếu sau này thêm scope khác (vd Calendar, Gmail) — **sensitive/restricted scopes sẽ kéo theo security assessment** (mất phí + lâu hơn nhiều, có thể vài tuần–vài tháng). Hiện tại chỉ dùng `drive.file` nên chưa phải lo việc này.
