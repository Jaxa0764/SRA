# SmartRestaurant server + admin panel

Waiter ilovasi "Connect" bosadi -> so'rov admin panelga tushadi -> admin ruxsat beradi -> waiter ulanadi.
Stol tugmasi bosilganda so'rov ofitsiantlarga tasodifiy navbat bilan (har bir davrada har kimga bir martadan) boradi.

```
Waiter ilovasi --POST /api/join--> SERVER <--ruxsat-- Admin panel (/admin)
Waiter ilovasi <--Socket.IO (token)--> SERVER
Tugma ilovasi  --POST /iot/event (x-device-key)--> SERVER
```

## Kompyuterda sinash
```
npm install
npm test        # 13 ta sinov, paket kerak emas
npm start
```
Brauzerda `http://localhost:3000/admin` oching. Parol: `ADMIN_PASSWORD` muhit o'zgaruvchisi.
Berilmasa, server ishga tushganda terminalga tasodifiy vaqtincha parol chiqaradi.

## GitHub orqali HTTPS saytga chiqarish

GitHub o'zi Node.js serverni ishlata olmaydi (GitHub Pages faqat oddiy statik sayt uchun).
Shuning uchun kodni GitHub'ga yuklab, undan **Render.com** (yoki Railway / Fly.io) kabi hosting'ga ulaysiz.
U HTTPS manzilni o'zi beradi (masalan `https://smartrestaurant-xxxx.onrender.com`).

1. GitHub'da yangi repository yarating (masalan `smartrestaurant-server`), shu papkadagi hamma fayllarni yuklang
   (`node_modules` va `data` papkalari `.gitignore` orqali o'tkazib yuboriladi).
2. render.com da ro'yxatdan o'ting -> **New +** -> **Web Service** -> GitHub repository'ni tanlang.
3. Sozlamalar:
   - Runtime: **Docker** (Dockerfile bor), yoki Node: Build `npm install`, Start `npm start`
   - **Environment Variables** bo'limiga qo'shing:
     - `ADMIN_PASSWORD` = o'zingiz o'ylab topgan kuchli parol
     - `DEVICE_KEY` = tugma ilovasi yuboradigan maxfiy kalit (masalan uzun tasodifiy matn)
4. Deploy tugagach manzil chiqadi. `https://MANZIL/health` ochilsa `{"ok":true}` ko'rinadi.
5. Admin panel: `https://MANZIL/admin`

Ilovalarga shu `https://MANZIL` yoziladi (oxirida `/` siz).

## Muhim cheklovlar
- **Bepul hosting uxlab qoladi:** bepul tariflarda server bir muddat so'rov bo'lmasa to'xtab, birinchi so'rovda
  ~1 daqiqada qayta uyg'onishi mumkin. Haqiqiy restoranda pullik tarif yoki VPS tavsiya etiladi.
- **Ma'lumotlar fayli:** tasdiqlangan ofitsiantlar `data/data.json` da saqlanadi. Ko'p hostinglarda bepul tarifda
  fayl tizimi vaqtinchalik, qayta deploy qilinsa o'chadi. Shunda ofitsiantlar qayta ruxsat so'raydi
  (ilova buni o'zi aniqlaydi). Doimiy saqlash uchun hostingning "disk" xizmati yoki MySQL kerak.
- Stollar va so'rovlar xotirada, server qayta yonsa tozalanadi. 30 soniyalik taymerlar `setTimeout`, Redis emas.

## API qisqacha
| Yo'l | Kim | Vazifa |
|---|---|---|
| `POST /api/join` `{deviceId, name}` | waiter ilovasi | qo'shilish so'rovi |
| `GET /api/join/:deviceId` | waiter ilovasi | holat: PENDING / APPROVED (+token) / REJECTED |
| `POST /iot/event` (header `x-device-key`) | tugma | `{table_id, click_type: 1\|3, event_id, device_id, timestamp}` |
| `/admin/api/*` (Bearer) | admin panel | ruxsat, o'chirish, qo'lda tayinlash, stolni bo'shatish |
| Socket.IO `auth: {token}` | waiter ilovasi | `waiter:service_offer`, `table:assistance_request`, `table:checkout_confirmation`, ... |
