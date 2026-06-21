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
python server.py
```

นำ URL แบบ HTTPS ที่ชี้มาที่ backend ไปใส่ใน LINE Developers Console:

```text
https://<your-backend-domain>/line/webhook
```

หมายเหตุ: GitHub Pages เป็น static site จึงรับ webhook จาก LINE โดยตรงไม่ได้ ต้อง deploy `server.py` หรือ backend equivalent บน public HTTPS เช่น VPS, Render, Railway, Cloud Run หรือใช้ tunnel ระหว่างทดสอบ
