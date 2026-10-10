# CBM Sound

Website nghe nhạc riêng bằng React, Vite, TypeScript, Tailwind CSS và Zustand. GitHub Pages cung cấp giao diện tĩnh; Google Drive lưu nhạc và thực thi quyền truy cập. Production luôn gọi Google thật. Không có backend, Client Secret, refresh token hay file nhạc trong repository.

Thư mục gốc đã chốt: [`1_GEZPONNMBfSzvVs2tFHDiCp40fNjREB`](https://drive.google.com/drive/folders/1_GEZPONNMBfSzvVs2tFHDiCp40fNjREB). Không tự tạo thư viện khác khi thiếu quyền. Tài khoản chủ sở hữu được xác định từ `ownedByMe` và capabilities do Drive trả về. Ứng dụng không thể tự nâng tài khoản người nghe thành chủ sở hữu.

## Chạy trên máy

Cần Node.js **24 LTS** và npm. Chỉ sao chép file mẫu khi chưa có `.env.local`, tránh ghi đè Client ID đang dùng:

```powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm ci
npm run dev
```

Mở origin Vite in ra, thường là `http://localhost:5173`. Sau khi sửa biến môi trường phải dừng và chạy lại Vite. Nhạc không nằm trên máy chủ Vite; máy tính chỉ cần bật khi dùng bản localhost.

## Cấu hình Google Cloud

1. Chọn project dùng cho CBM Sound, bật **Google Drive API** và **Google Picker API** trong APIs & Services → Library.
2. Google Auth Platform → Branding/Audience: khai báo tên, email hỗ trợ và liên hệ. Khi Audience đang **Testing**, thêm `hoangfa951@gmail.com` và mọi tài khoản người nghe vào **Test users**. Mời trên Drive không thay thế bước này. Lỗi OAuth `403 access_denied` nói app đang Testing được xử lý ở đây.
3. Data Access: khai báo `https://www.googleapis.com/auth/drive.file`. Nếu muốn đọc nhạc có sẵn trên Drive hoặc dùng quyền đọc bổ sung cho người nghe, khai báo thêm `https://www.googleapis.com/auth/drive.readonly`. Ứng dụng không xin scope toàn quyền `drive`.
4. Clients → tạo OAuth Client loại **Web application**. Authorized JavaScript origins:
   - `http://localhost:5173`
   - `https://chipchiplip.github.io`
   - Origin riêng nếu đổi cổng/domain. `http://127.0.0.1:5173` khác `http://localhost:5173`.
   Không thêm `/CBMSound/` hoặc đường dẫn thư mục. Token flow dùng popup, không cần redirect URI hay Client Secret. Client ID là cấu hình công khai.
5. APIs & Services → Credentials → Create credentials → **API key** cho Picker. Giới hạn API key theo Google Picker API. Nếu chọn Application restrictions → Websites, thêm `http://localhost:5173/*`, `https://chipchiplip.github.io/*` và `https://docs.google.com/*` theo hướng dẫn Google. Picker chạy trong iframe trên docs.google.com; thiếu referrer này có thể báo developer key invalid. Key trình duyệt là cấu hình công khai cần được hạn chế, không phải OAuth token.
6. Lấy **Project number** dạng số trong Project info, không dùng Project ID dạng chữ. OAuth Client, Picker key và Project number phải cùng project.
7. Điền `.env.local`:

```dotenv
VITE_GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
VITE_GOOGLE_PICKER_API_KEY=YOUR_RESTRICTED_BROWSER_KEY
VITE_GOOGLE_CLOUD_PROJECT_NUMBER=YOUR_NUMERIC_PROJECT_NUMBER
VITE_DRIVE_FOLDER_ID=1_GEZPONNMBfSzvVs2tFHDiCp40fNjREB
VITE_BASE_PATH=/
VITE_ALLOW_LISTENER_READONLY_FALLBACK=true
```

8. Đăng nhập bằng tài khoản có quyền vào thư mục gốc. Nếu app báo `appNotAuthorizedToFile` hoặc không tìm thấy thư mục dù Drive mở được, bấm **Chọn thư mục gốc trên Google Drive** và chọn đúng thư mục qua Picker. **Chọn một lần dòng thư mục rồi bấm Chọn**, không mở vào trong. Nếu thanh đường dẫn hiện `Thư mục > Nhạc`, bấm `Thư mục` để quay lại. Hộp này lọc thư mục nên nhạc bên trong bị ẩn; thông báo không có mục không có nghĩa Drive không có nhạc. Nhập ID hay dán link không tự cấp quyền `drive.file` cho ứng dụng. Picker không sửa ACL và không đổi chủ sở hữu.
9. Để nghe nhạc có sẵn ngoài ứng dụng, vào Thư viện và bấm **Cấp quyền đọc nhạc có sẵn**, chấp nhận quyền rồi đồng bộ lại. App không tự xin thêm scope; `drive.file` có thể trả về danh sách thành công nhưng chỉ gồm những file được cấp cho ứng dụng. Chọn thư mục qua Picker không được coi là tự cấp quyền đọc mọi file cũ trong đó. `drive.readonly` cho phép đọc **toàn Drive**, dù ứng dụng chỉ lấy nhạc trực tiếp trong thư mục gốc. Quyền này không cấp quyền upload/đổi tên/xóa. Người nghe cũng có thể cần quyền này cho nhạc của chủ thư viện; phải xác minh bằng hai tài khoản thật, đặc biệt nhạc upload sau khi mời.

Tham khảo: [Google Picker](https://developers.google.com/workspace/drive/picker/guides/web-picker), [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [scope Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [xác minh OAuth khi mở rộng](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

## Ghi nhớ tài khoản và phiên Google

Bấm tên hoặc avatar mở Cài đặt, giữ nguyên phiên và bài đang phát. **Đăng xuất** là thao tác riêng; **Đổi tài khoản** xóa phiên cũ, hủy request/upload/player rồi mở bộ chọn tài khoản Google.

Sau khi Drive xác minh danh tính, ứng dụng ghi nhớ email, tên, permission ID và scope đã được cấp trong localStorage theo OAuth Client ID. Không lưu access token, refresh token, thời hạn token hay quyền chủ sở hữu. Dữ liệu ghi nhớ chỉ giúp hiện **Tiếp tục với…**; Google và Drive vẫn phải xác minh lại trước khi mở cache, thư viện hoặc quyền quản lý. Storage bị chặn không ngăn đăng nhập.

Trong một phiên, điều hướng hoặc bấm Kết nối lại không xin token mới khi token hiện tại còn hợp lệ. Sau khi tải lại/đóng trang hoặc token hết hạn, bấm **Tiếp tục** / **Kết nối lại**: ứng dụng dùng `prompt: ''` và `login_hint` để tránh chọn lại tài khoản đã cấp quyền, nếu Google cho phép. Không tự mở popup khi tải trang. GIS token flow yêu cầu thao tác người dùng để nhận token mới; frontend-only này không bảo đảm đăng nhập tự động hoàn toàn sau F5. Google vẫn có thể yêu cầu xác minh, đăng nhập hoặc cấp lại quyền. [Hướng dẫn token](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [tham số GIS](https://developers.google.com/identity/oauth2/web/reference/js-reference).

Token hết hạn/HTTP 401 giữ thông tin ghi nhớ và vị trí phát để kết nối lại. Đăng xuất hoặc thu hồi quyền xóa tài khoản ghi nhớ và token RAM ở trang/Service Worker; playlist và cache vẫn được phân vùng theo tài khoản và không hiển thị trước khi xác minh lại. Không chia sẻ phiên tự động giữa các tab.

## Thư viện và thành viên

- Liệt kê file âm thanh con trực tiếp trong thư mục gốc, không trong thùng rác, gồm cả nhạc có sẵn. Không quét thư mục con, tài liệu Google hay shortcut. `properties.cbmSoundTrack=1` chỉ xác định file upload qua CBM Sound để cho phép quản lý; file cũ không có dấu được nghe, tìm kiếm và thêm vào playlist nhưng không đổi tên/xóa bằng app. Không tự ghi dấu, sao chép, sửa metadata hay quyền của file cũ.
- Đồng bộ tải hết trang rồi mới thay snapshot. Request lỗi không biến thành kết luận file bị xóa. Cache IndexedDB tách theo tài khoản/thư mục và lưu thời điểm đồng bộ; UI phân biệt cache với dữ liệu đã xác nhận từ Drive. Khi trở lại tab, cache quá 5 phút được làm mới.
- Bài đã mất vẫn có dấu thiếu trong playlist; player và thống kê loại chúng khỏi các bài khả dụng. Playlist và lịch sử chỉ lưu trên thiết bị, không đồng bộ giữa thiết bị.
- Chủ thư viện mời email với role `reader` tại thư mục. App không gửi email; sao chép URL website để gửi riêng. Thay đổi quyền chạy tuần tự, thu hồi được kiểm tra lại; app rà soát quyền trực tiếp còn lại trên nhạc đọc được trong thư mục gốc, gồm cả nhạc có sẵn. Quyền `anyone`/`domain` có sẵn được hiển thị và cảnh báo, không bị giấu hoặc tự đổi. Với `drive.file`, Google có thể ẩn file cũ chưa được cấp cho ứng dụng nên không thể xác nhận đã kiểm tra hết. Kiểm tra thêm trên Drive nếu có quyền kế thừa/nhóm hoặc file ngoài phạm vi app.
- Xóa bài chuyển vào thùng rác; đổi tên/xóa cần cả chủ sở hữu thư viện và capabilities của file. Quyền thực tế vẫn do Drive quyết định.

## Upload và phục hồi

Upload tuần tự bằng resumable upload, chunk 8 MiB. Có chọn nhiều file, kéo thả và giữ cả hai với hậu tố hoặc bỏ qua tên trùng. Progress chính là byte **Drive đã xác nhận**; byte đang gửi được hiển thị riêng.

ID file được tạo trước, URL phiên và offset chỉ giữ trong RAM. Mất mạng/5xx/429/rate-limit 403 có retry giới hạn, backoff, jitter và Retry-After. App truy vấn offset server trước khi tiếp tục; HTTP 308 không có Range được hiểu là chưa nhận byte nào. Mất phản hồi hoàn tất/phiên hết hiệu lực được đối chiếu bằng cùng file ID, hạn chế tạo bản sao. Chỉ hoàn tất khi Drive xác nhận; lỗi đọc tag/cache sau đó không biến file đã tạo thành upload thất bại.

401 hoặc hết token chuyển job sang cần kết nối lại; bấm nút để OAuth chạy từ thao tác người dùng, sau đó kiểm tra lại phiên. Đóng/refresh tab làm mất phiên RAM; chọn lại file để bắt đầu mới, kiểm tra thư viện trước để tránh tự tải trùng. Không có cam kết tiếp tục upload sau khi đóng tab. Drive đầy dung lượng và thiếu quyền được báo theo nguyên nhân, không retry vô hạn. [Resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

## Phát nhạc riêng tư

Một `HTMLAudioElement` dùng URL nội bộ dưới base path. Service Worker nhận phiên và token trong RAM từ đúng tab, chuyển request sang `files.get?alt=media` với Authorization. Token không nằm trong URL. Worker hỗ trợ một Range đầu/cuối/mở, HEAD, 206/416, kiểm tra Content-Range/Content-Length, stream dữ liệu và hủy request cũ khi tua/đổi bài/đăng xuất. Worker mất state yêu cầu lại phiên từ tab sở hữu, có xác nhận và timeout; không cache nhạc dài hạn.

`Content-Range` không thuộc nhóm response header CORS mặc định được JavaScript đọc. Nếu Drive trả `206` nhưng ẩn header này, worker yêu cầu Content-Length khớp khoảng byte và lấy metadata mới qua API để kiểm tra size, modifiedTime, trạng thái thùng rác và khả năng tải. Chỉ sau đó worker tạo header Range nội bộ, đồng thời kiểm tra số byte thật trong stream. Không chấp nhận upstream `200` thay cho Range, không tải cả file lớn vào RAM. Cách này cần thêm một request metadata cho mỗi Range có header bị ẩn. [Fetch/CORS](https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name).

Website kiểm tra đúng script Service Worker và ACK protocol trước khi phát; lần kích hoạt trễ có thể retry thay vì bị giữ kết quả thất bại. Khi cập nhật trên Edge/Chrome, nhấn **Ctrl + F5**, đăng nhập và đồng bộ lại. Lỗi Service Worker chưa điều khiển trang, thiếu thông tin xác minh Range, Drive chặn tải, thay đổi file và giới hạn API được báo riêng; đừng nâng giới hạn fallback để che lỗi streaming.

Nếu Range không hỗ trợ, chỉ fallback tải file tối đa **32 MiB**, có giới hạn byte ngay khi đọc stream. File lớn hơn báo lỗi hỗ trợ; không âm thầm tải hết vào Blob/ArrayBuffer. FLAC/AAC/ALAC và các codec khác phụ thuộc trình duyệt, không chuyển mã. Metadata/artwork đọc có ngân sách byte, cache theo modifiedTime; lỗi tag không chặn phát.

Player có seek, âm lượng/mute, queue, next/previous, shuffle theo lượt có lịch sử, repeat off/one/all, Media Session và điều khiển mở rộng trên mobile. Previous quay về đầu sau 3 giây. Token hết hạn dừng request cần xác thực, giữ vị trí để kết nối lại; đăng xuất dừng nhạc, hủy request và xóa dữ liệu phiên ở tab/worker. Thu hồi quyền Google là thao tác riêng trong Cài đặt.

**Streaming Drive 200 MB chưa được xác nhận bằng tài khoản thật.** Chrome/Edge desktop và Chrome Android là ưu tiên; Safari, phát nền trên điện thoại và Range/CORS cần thử riêng. Drive là kho file, không phải CDN nhạc. Người có quyền đọc có thể tải nhạc; app không cung cấp DRM hay nghe offline. Nếu streaming lớn không đạt, ghi nhận tiêu chí chưa đạt và đánh giá proxy serverless sau; bản này không tự thêm backend. [Downloads/Range](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [quota Drive](https://developers.google.com/workspace/drive/api/guides/limits).

## GitHub Pages

Repository triển khai: [`Chipchiplip/CBMSound`](https://github.com/Chipchiplip/CBMSound), nhánh `main`. URL GitHub Pages là `https://chipchiplip.github.io/CBMSound/`, base production `/CBMSound/`. Bản localhost có thể giữ `VITE_BASE_PATH=/` trong `.env.local`.

1. Tạo repository trong tài khoản GitHub đúng, push source lên nhánh `main`. Không commit `.env.local`, token hay nhạc; `.gitignore` đã loại env riêng và build.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **Variables**: thêm `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_PICKER_API_KEY`, `VITE_GOOGLE_CLOUD_PROJECT_NUMBER`; tùy chọn `VITE_ALLOW_LISTENER_READONLY_FALLBACK` (`true` mặc định trong workflow này).
4. Workflow cố định thư mục gốc đã chốt và base `/CBMSound/`; không cần tạo Variables folder/base. Để kiểm tra bản production trên máy, build với `VITE_BASE_PATH=/CBMSound/`, chạy `npm run preview` và mở đường dẫn `/CBMSound/` ở origin preview.
5. Push `main` hoặc chạy workflow thủ công. Node 24, `npm ci`, typecheck, lint, test và build phải pass trước khi deploy `dist`. Thiếu Client ID làm CI dừng với lỗi cấu hình rõ ràng.
6. Kiểm tra trên URL HTTPS thật; OAuth origin dùng `https://chipchiplip.github.io` không có path. Hash routing hỗ trợ refresh; assets/worker/media đều dùng cùng base.

Mọi biến `VITE_` có mặt trong frontend công khai. Không đưa Client Secret hoặc credential bí mật vào các biến đó. Site tĩnh public không đồng nghĩa nhạc Drive public. [Vite GitHub Pages](https://vite.dev/guide/static-deploy.html#github-pages).

## Kiểm thử

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm audit
```

Tests dùng dữ liệu giả **chỉ trong test**: offset/progress, resumable retry/reconciliation/cancel, auth/error mapping/session isolation, pagination/cache snapshot, player queue/shuffle/metadata race, worker Range/HEAD/restart/logout/token, byte budget, library render/search/sort/playlist/queue. Chúng không chứng minh OAuth, CORS, streaming hoặc upload thật.

Checklist tích hợp cần tài khoản thật:

- Chủ sở hữu, một người nghe được mời và một tài khoản không được mời; kiểm tra quyền từ chối và nhạc được upload sau lời mời.
- File nhỏ và khoảng 200 MB: mất mạng, hết token, đóng tab, lỗi dung lượng/quota, tên trùng; xác nhận Drive có đúng số file.
- Phát riêng tư, tua đầu/giữa/cuối trước khi tải hết, đổi bài nhiều lần, theo dõi bộ nhớ và request bị hủy.
- Mời/thu hồi, quyền trực tiếp còn lại, reader không được upload/đổi tên/xóa; thử trên thiết bị khác và xóa trực tiếp trong Drive.
- URL GitHub Pages thật, routing/base path, Chrome Android, bàn phím và Media Session.

Các tài liệu kiểm tra trong `plans/` ghi rõ kết quả tự động và phần chưa kiểm chứng thật.
