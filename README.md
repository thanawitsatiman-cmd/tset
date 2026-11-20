# ระบบติดตามคำร้อง (Node.js + PostgreSQL)

## เชื่อมต่อ Supabase

สร้างโปรเจกต์ Supabase `petition-tracking-db` ใน Region Singapore แล้ว และรัน schema สร้างตารางไว้แล้ว

1. เนื่องจาก Database password เคยแสดงในหน้าตั้งค่า ให้เปลี่ยนรหัสผ่านที่ **Project Settings → Database** ก่อนนำไปใช้
2. ใน Supabase ไปที่ **Project Settings → Database → SSL Configuration** แล้วดาวน์โหลด Root certificate วางไว้ที่ `certs/supabase-prod-ca.crt`
3. ในหน้าโปรเจกต์ กด **Connect** แล้วเลือก **Session pooler** คัดลอก connection string สำหรับ PostgreSQL เก็บไว้เป็นความลับ
4. เปิดไฟล์ `.env` ในโฟลเดอร์นี้ แล้ววาง connection string หลัง `DATABASE_URL=` โดยคง `DATABASE_SSL=true` และ `DATABASE_CA_CERT=certs/supabase-prod-ca.crt` ไว้
5. อย่าส่ง connection string ในแชต ห้ามใส่ไว้ใน `index.html` และห้าม commit `.env` (ไฟล์นี้อยู่ใน `.gitignore`)
6. ใน Terminal ที่โฟลเดอร์โปรเจกต์ รันบน Windows:

   ```powershell
   & 'C:\Program Files\nodejs\npm.cmd' run db:init
   & 'C:\Program Files\nodejs\npm.cmd' run dev
   ```

7. เปิด http://localhost:3000

ถ้า Terminal แจ้งว่าไม่รู้จัก `npm` ให้ใช้คำสั่งเต็มด้านบน หรือปิดและเปิด VS Code ใหม่หลังติดตั้ง Node.js

`npm run db:init` จัดข้อมูลที่เปิดดูใน schema `public` ให้เหลือรายการหลักสองรายการ: ตาราง `petition_requests` (หนึ่งแถวต่อผู้ขอ) และ View `petition_requests_sheet` (ข้อมูลแบบชีต โดยเลือกคำร้องล่าสุดของแต่ละคน) ตาราง/วิวที่แอปใช้เก็บคำร้องรายปี ตัวเลือก และประวัติการแก้ไขจะอยู่ใน schema ภายใน `app_private` ไม่ได้ถูกลบ และแอปยังใช้ข้อมูลเหล่านี้ตามปกติ คำสั่งนี้ย้ายโครงสร้างเดิมและทำงานซ้ำได้

## ซิงก์ Google Sheets สองทาง

ระบบซิงก์ใช้แท็บแยกหนึ่งแถวต่อหนึ่งคำร้อง เพื่อรักษาคำร้องรายปีทั้งหมดไว้ ห้ามใช้ View `petition_requests_sheet` ซึ่งเป็นสรุปหนึ่งแถวต่อผู้ขอเป็นแท็บต้นทาง การเพิ่ม/แก้ไขจากเว็บจะเข้าคิวในฐานข้อมูลและลองส่งไปชีตซ้ำเมื่อมีปัญหา ส่วนการเพิ่ม/แก้ไขจากชีตจะส่งกลับผ่าน API และตรวจ revision เพื่อป้องกันการเขียนทับข้อมูลที่ถูกแก้จากอีกฝั่ง การลบแถวในชีตไม่ได้ลบคำร้องใน Supabase

1. อัปเดต schema ด้วย `npm run db:init` แล้วเริ่มเซิร์ฟเวอร์ใหม่
2. สร้าง Google Apps Script project และวางโค้ดจาก `google-sheets-sync.gs` ลงในโปรเจกต์
3. ใน Apps Script **Project Settings → Script Properties** เพิ่ม `SYNC_TOKEN` (ค่าสุ่มยาว), `SPREADSHEET_ID`, `SHEET_NAME` (ชื่อแท็บซิงก์ใหม่) และ `SERVER_URL` (URL HTTPS สาธารณะของเซิร์ฟเวอร์ เช่น `https://example.org`).
4. เพิ่ม `SHEETS_WEB_APP_URL` (URL ของ Apps Script Web App deployment) และ `SHEETS_SYNC_TOKEN` (ค่าเดียวกับ `SYNC_TOKEN`) ใน `.env` ของ Node.js
5. Deploy Apps Script เป็น **Web app**, เลือก execute as ตัวเอง และอนุญาตการเข้าถึงตามนโยบายองค์กรของคุณ จากนั้นเรียก `setupSheetSync()` ใน Apps Script หนึ่งครั้งเพื่อสร้างแท็บและติดตั้ง on-edit trigger
6. เรียก `syncAllFromServer()` หนึ่งครั้งเพื่อคัดลอกข้อมูลปัจจุบันจาก Supabase ลงแท็บซิงก์

เซิร์ฟเวอร์ต้องเข้าถึงได้จากอินเทอร์เน็ตผ่าน HTTPS เพื่อให้ Apps Script ส่งข้อมูลกลับมาได้; `localhost` ใช้รับการซิงก์จาก Google ไม่ได้ อย่าใส่ token ในหน้าเว็บหรือแชร์ `.env` หากแก้ข้อมูลพร้อมกัน ระบบจะทำเครื่องหมายขัดแย้งใน `_sync_status` และไม่ทับข้อมูลใน Supabase อัตโนมัติ เมื่อต้องการดึงข้อมูลปัจจุบันมาแก้กรณีขัดแย้ง ให้ใช้เมนู **Supabase → โหลดข้อมูลจาก Supabase**

## ตั้งค่าระบบล็อกอินเจ้าหน้าที่

ระบบมีหน้าเข้าสู่ระบบโดยให้กรอกรหัสเจ้าหน้าที่และรหัสผ่าน Supabase Auth ยังคงตรวจสอบบัญชีอีเมลและรหัสผ่านอยู่เบื้องหลัง โดยแอปจับคู่รหัสเจ้าหน้าที่กับอีเมลใน `app_private.staff_accounts` แอปไม่เก็บรหัสผ่าน และเจ้าหน้าที่แต่ละคนควรใช้บัญชีส่วนตัว ไม่ใช้รหัสร่วมกัน เพื่อให้ประวัติการแก้ไขระบุผู้แก้ได้ถูกต้อง

1. ใน Supabase เปิด **Authentication → Providers → Email** และปิดการสมัครสมาชิกสาธารณะ เพื่อให้เข้าระบบได้เฉพาะบัญชีที่ผู้ดูแลสร้างให้
2. ใน **Authentication → Users** เพิ่มบัญชีแยกให้เจ้าหน้าที่แต่ละคน แล้วแจ้งให้ตั้งรหัสผ่านส่วนตัวผ่านช่องทางที่ปลอดภัย
3. ใน **Project Settings → API** คัดลอก Project URL และ publishable key (หรือ anon key รุ่นเดิม) ลงใน `.env` ที่ `SUPABASE_URL` และ `SUPABASE_ANON_KEY` ตามลำดับ ห้ามนำ `service_role` key มาใช้
4. กำหนดสิทธิ์ด้วยอีเมลคั่นด้วยเครื่องหมายจุลภาคใน `.env`: `AUTH_ADMIN_EMAILS` สำหรับผู้ดูแล (เพิ่ม/ลบคำร้องได้), `AUTH_EDITOR_EMAILS` สำหรับเจ้าหน้าที่แก้ไขได้ และ `AUTH_VIEWER_EMAILS` สำหรับดูอย่างเดียว อีเมลที่ไม่อยู่ในรายการเหล่านี้จะเข้าแอปไม่ได้
5. หลัง `npm run db:init` สร้างตาราง `app_private.staff_accounts` แล้ว เพิ่มรหัสเจ้าหน้าที่และอีเมลบัญชี Supabase ของแต่ละคนผ่าน SQL Editor ตัวอย่าง:

   ```sql
   INSERT INTO app_private.staff_accounts (staff_id, email)
   VALUES ('50120', 'staff@example.org');
   ```

   บันทึกเฉพาะรหัสเจ้าหน้าที่กับอีเมล ห้ามบันทึกรหัสผ่านในตารางนี้
6. เริ่มเซิร์ฟเวอร์ใหม่หลังแก้ `.env` บน production ต้องใช้ HTTPS; คุกกี้เซสชันตั้งเป็น HttpOnly และ Secure

โหมดพัฒนาในเครื่องจะใช้ `local@dev` เฉพาะเมื่อยังไม่ได้ตั้งค่า Supabase Auth และ `NODE_ENV` ไม่ใช่ `production` เท่านั้น

## นำเข้าข้อมูล CSV จาก Google Sheets

ข้อมูลปี 2568 และ 2569 จำนวน 57 รายการนำเข้าแล้ว ตาราง `petition_requests` เก็บข้อมูลบุคคลหนึ่งแถวต่อคน ส่วน `petition_years` เก็บคำร้องแยกเป็นรายปีและเชื่อมด้วย `person_id` สำหรับการนำเข้ารอบถัดไป ใช้ CSV ที่มีหัวคอลัมน์เดิม 16 คอลัมน์และ ID ทุกแถวไม่ซ้ำกัน ตัวอย่างตรวจสอบไฟล์สำเนาที่แก้ ID แล้ว:

```powershell
& 'C:\Program Files\nodejs\npm.cmd' run db:import -- 'C:\Users\Asus\Downloads\data - คำร้อง2569-ids-corrected.csv' 'C:\Users\Asus\Downloads\data - คำร้อง2568-ids-corrected.csv'
```

คำสั่งนี้เป็น dry-run: ตรวจหัวคอลัมน์, ID ซ้ำ, วันที่ และ ID ที่มีอยู่ในฐานข้อมูล โดยไม่เขียนข้อมูล หากตรวจผ่าน จึงเติม `--apply` ท้ายคำสั่งเพื่อเริ่มนำเข้า ทั้งสองไฟล์จะนำเข้าใน transaction เดียว; ถ้ามีข้อผิดพลาดจะ rollback ทั้งหมด อย่าแก้ ID ซ้ำด้วยการสุ่มเปลี่ยนเอง ให้ตรวจแถวที่รายงานใน Google Sheet และกำหนด ID ใหม่ให้แต่ละคำร้องที่เป็นคนละรายการก่อนส่งออก CSV ใหม่

## สถานะและข้อควรทราบ

- API สำหรับ Dashboard, สมุดคุมคำร้อง, แบ่งหน้า, CRUD, ตัวเลือก และ version ใช้ PostgreSQL แล้ว โดยอ่านคำร้องผ่าน view ภายใน `app_private.petition_request_rows` ที่เชื่อมข้อมูลบุคคลกับคำร้องรายปี
- ข้อมูลจาก Google Sheets ถูกแยกเป็น 33 ผู้ขอ และ 57 คำร้องรายปี โดยไม่ลบประวัติคำร้อง
- ใน Supabase ให้เปิด schema **public**: ตาราง `petition_requests` ใช้เก็บข้อมูลประจำตัวผู้ขอหนึ่งคนต่อแถว ส่วน View `petition_requests_sheet` ใช้ดูข้อมูลแบบชีตหนึ่งแถวต่อคน โดยเลือกคำร้องล่าสุดและเรียงตามวันที่รับคำร้องจากเก่าสุดไปใหม่สุด มี 16 คอลัมน์ตามหัว CSV เดิม ทั้งสองรายการเป็นหน้าหลักสำหรับตรวจข้อมูล; แก้ไขข้อมูลผ่านแอป
- ข้อมูลคำร้องรายปีและประวัติการแก้ไขยังเก็บไว้ใน schema ภายใน `app_private` เพื่อให้แอปทำงานและรักษาข้อมูลเดิมไว้ ตารางช่วยงานเหล่านี้ไม่ใช่หน้าหลักสำหรับตรวจข้อมูล ทั้งนี้ข้อมูลเก่าก่อนเพิ่มการบันทึกค่าเดิม/ค่าใหม่ไม่สามารถกู้รายละเอียดการแก้ไขย้อนหลังได้
- ฟอร์มเพิ่มคำร้องใหม่ไม่แสดงช่องสาเหตุ/แจ้งเหตุ; เจ้าหน้าที่เพิ่มภายหลังได้จากฟอร์มแก้ไข และรายการสาเหตุ 78 ข้อจากไฟล์ Apps Script จะถูกเพิ่มเข้า `app_options` อัตโนมัติเมื่อเริ่มระบบ
- ข้อมูลจาก Google Sheets นำเข้าแล้ว 57 รายการ ตรวจพบ 57 ID ไม่ซ้ำกัน; อัปเดต ID ใหม่ใน Google Sheets ตามไฟล์ `petition-id-updates.csv` ก่อนใช้ชีตเป็นข้อมูลต้นทางต่อ
- โหมดพัฒนาในเครื่องอาจใช้ผู้ใช้จำลอง `local@dev` (admin) เพื่อทดสอบเท่านั้น; production ต้องตั้งค่า Supabase Auth และ HTTPS ตามขั้นตอนด้านบน
- ตาราง `app_options` เก็บตัวเลือกประเภท/สาเหตุ
- `code.gs.txt` ใช้เป็นข้อมูลอ้างอิงของ logic เดิม ไม่ได้รันโดย Node.js
#   t s e t  
 #   t s e t  
 