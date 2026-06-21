# Harnkan

เว็บหารค่าใช้จ่ายแบบแมนนวลสำหรับทริปหรือมื้ออาหาร ใช้งานได้ทั้งบนคอมพิวเตอร์และมือถือ

## เปิดผ่าน GitHub Pages

โปรเจกต์นี้เป็น static site สำหรับ GitHub Pages โดยใช้ไฟล์หลัก:

- `index.html`
- `styles.css`
- `app.js`

เมื่อ deploy แล้ว เว็บจะอยู่ที่:

```text
https://<username>.github.io/harnkan/
```

บน GitHub Pages ข้อมูลจะถูกเก็บใน `localStorage` ของแต่ละเครื่อง จึงไม่แชร์ข้อมูลกลางระหว่างผู้ใช้

## รันในวง LAN

ถ้าต้องการให้เครื่องอื่นในวง LAN เห็นข้อมูลชุดเดียวกัน ให้รัน server local:

```bash
python server.py
```

จากนั้นเปิด URL ที่แสดงใน terminal หรือใช้ IP เครื่อง host กับพอร์ต `4174`

```text
http://<host-ip>:4174/index.html
```

โหมด LAN จะใช้ `data.json` เป็นไฟล์ข้อมูลกลางในเครื่อง host ไฟล์นี้ถูก ignore ไม่ควรอัปขึ้น public repo เพราะอาจมีข้อมูลทริป บัญชี และสลิป

## LINE OA Webhook

เว็บมีหน้า `LINE OA Webhook` สำหรับคัดลอก webhook URL, สร้างคำสั่งตั้งค่า และทดสอบ endpoint

เมื่อรัน backend ด้วย `server.py` จะมี endpoint:

```text
POST /line/webhook
```

ตั้งค่า secret/token ก่อนรัน server:

```powershell
$env:LINE_CHANNEL_SECRET="<CHANNEL_SECRET>"
$env:LINE_CHANNEL_ACCESS_TOKEN="<CHANNEL_ACCESS_TOKEN>"
$env:OPENAI_API_KEY="<OPENAI_API_KEY>"
python server.py
```

หรือใส่ `OPENAI_API_KEY=...` ใน `.env.local` สำหรับโหมด local ก็ได้ ไฟล์นี้ถูก ignore ไม่ควรอัปขึ้น repo

นำ URL แบบ HTTPS ที่ชี้มาที่ backend ไปใส่ใน LINE Developers Console:

```text
https://<your-backend-domain>/line/webhook
```

หมายเหตุ: GitHub Pages เป็น static site จึงรับ webhook จาก LINE โดยตรงไม่ได้ ต้อง deploy `server.py` หรือ backend equivalent บน public HTTPS เช่น VPS, Render, Railway, Cloud Run หรือใช้ tunnel ระหว่างทดสอบ

## Firebase + LINE OA + OpenAI

โปรเจกต์นี้มี Firebase Hosting + Cloud Functions TypeScript สำหรับรับ LINE OA webhook และให้ OpenAI ช่วยตอบแชท

ไฟล์หลัก:

- `firebase.json`
- `functions/src/index.ts`
- `functions/package.json`

ติดตั้ง dependency:

```bash
cd functions
npm install
cd ..
```

ตั้งค่า Firebase project:

```bash
copy .firebaserc.example .firebaserc
```

แล้วแก้ `your-firebase-project-id` เป็น project id จริง

ตั้งค่า secrets:

```bash
firebase functions:secrets:set LINE_CHANNEL_SECRET
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set OPENAI_API_KEY
```

ค่า default ของโมเดลอยู่ที่ `gpt-4o-mini` ใน `functions/src/index.ts`

Deploy:

```bash
npm --prefix functions run build
firebase deploy --only functions,hosting
```

Webhook URL สำหรับ LINE Developers Console:

```text
https://<your-firebase-hosting-domain>/line/webhook
```

Cloud Function จะตรวจ `X-Line-Signature`, ส่งข้อความเข้า OpenAI และ reply กลับ LINE OA ด้วย Channel Access Token
