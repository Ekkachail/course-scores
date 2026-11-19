-- =====================================================================
-- 08_attendance_settings.sql — เก็บการตั้งค่าเช็คชื่อไว้กับรายวิชา
--   att_late_weight  : สาย 1 ครั้ง นับเป็นกี่คาบ (0.5 = ได้ครึ่งคาบ)
--   att_warn_absent  : ขาดครบกี่ครั้งให้แจ้งเตือน (ไม่เกี่ยวกับการคิดคะแนน)
--   att_item_id      : รายการคะแนนที่ใช้ใส่คะแนนเข้าเรียน
-- นิสิตอ่านค่าเหล่านี้ได้ (ใช้แสดงคำเตือนการขาดในหน้าของนิสิต)
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run (รันซ้ำได้)
-- =====================================================================

alter table public.courses
  add column if not exists att_late_weight numeric not null default 0.5
    check (att_late_weight between 0 and 1),
  add column if not exists att_warn_absent int not null default 5
    check (att_warn_absent >= 0),
  add column if not exists att_item_id bigint references public.items(id) on delete set null;

-- ตรวจผล: ควรได้ 3 แถว
select column_name, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'courses' and column_name like 'att\_%'
order by 1;
