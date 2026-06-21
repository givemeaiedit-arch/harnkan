# Harnkan

เว็บหารค่าใช้จ่ายแบบแมนนวลสำหรับทริปหรือมื้ออาหาร ใช้งานได้ทั้งคอมพิวเตอร์และมือถือ

## Static Website

ไฟล์เว็บหลัก:

- `index.html`
- `styles.css`
- `app.js`

บน GitHub Pages เว็บใช้ `localStorage` ของแต่ละเครื่อง จึงไม่มีฐานข้อมูลกลาง:

```text
https://givemeaiedit-arch.github.io/harnkan/
```

## Run on LAN

ถ้าต้องการให้เครื่องอื่นในวง LAN ใช้ข้อมูลชุดเดียวกัน ให้รัน backend local:

```bash
python server.py
```

แล้วเปิดจากเครื่องอื่นด้วย IP ของเครื่อง host:

```text
http://<host-ip>:4174/index.html
```

โหมด LAN ใช้ `data.json`, `line_config.json`, `line_events.json` เป็นไฟล์ local ซึ่งถูก ignore และไม่ควรอัปขึ้น public repo

## Firebase Hosting

โปรเจกต์ Firebase:

```text
givemeai-gpt-hub
```

เว็บ Harnkan ถูก deploy เป็น Hosting site แยก เพื่อไม่ทับ site หลักของโปรเจกต์:

```text
https://harnkan-givemeai-gpt-hub.web.app
```

Webhook URL สำหรับ LINE Developers Console:

```text
https://harnkan-givemeai-gpt-hub.web.app/line/webhook
```

ตรวจสถานะ config:

```text
https://harnkan-givemeai-gpt-hub.web.app/api/line/config
```

## Firebase Functions

Functions ที่เพิ่มสำหรับ Harnkan:

- `lineWebhook`
- `lineConfig`
- `lineEvents`

โปรเจกต์นี้มี Functions อื่นอยู่ใน Firebase อยู่แล้ว เวลาจะ deploy ห้ามใช้ `firebase deploy --only functions` เพราะอาจทำให้ Firebase ถามเรื่องลบ function เก่า ให้ deploy เฉพาะ function ของ Harnkan:

```bash
firebase deploy --only functions:lineWebhook,functions:lineConfig,functions:lineEvents --project givemeai-gpt-hub
```

Deploy hosting เฉพาะ site Harnkan:

```bash
firebase deploy --only hosting:harnkan --project givemeai-gpt-hub
```

## Secrets

ตั้งค่า secrets ใน Firebase Secret Manager:

```bash
firebase functions:secrets:set LINE_CHANNEL_SECRET --project givemeai-gpt-hub
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN --project givemeai-gpt-hub
firebase functions:secrets:set OPENAI_API_KEY --project givemeai-gpt-hub
```

ห้าม commit ค่า secret, `.env.local`, `data.json`, `line_config.json`, หรือไฟล์สลิป/บัญชีจริงขึ้น GitHub
