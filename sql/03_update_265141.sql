-- =====================================================================
-- 03_update_265141.sql
--   ส่วน A: ปรับโครงสร้าง (รันครั้งเดียว)
--   ส่วน B: สร้างรายวิชา 265141 ตามเกณฑ์การให้คะแนน ภาคเรียนที่ 1/2569
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run
-- =====================================================================

-- ---------- ส่วน A: ปรับโครงสร้าง ----------

-- หมายเหตุของหมวด เช่น "ขาดได้ไม่เกิน 2 ครั้ง"
alter table public.categories add column if not exists note text;

-- นิสิตต้องเห็น "รายการ" ทุกรายการ (ชื่อ/คะแนนเต็ม/สัดส่วน/กำหนดส่ง) เพื่อคำนวณ
-- "ยังเก็บได้อีกเท่าไร" และ "ขาดอีกเท่าไรจึงได้เกรด"
-- ส่วน "คะแนน" ยังเห็นเฉพาะรายการที่อาจารย์ติ๊กประกาศ (visible) เหมือนเดิม
drop policy if exists "read visible items" on public.items;
drop policy if exists "read items" on public.items;
create policy "read items" on public.items
  for select to authenticated using (true);

-- ---------- ส่วน B: รายวิชา 265141 ----------
-- คะแนนเต็มของแต่ละรายการเป็นค่าตั้งต้น — แก้ได้ในแท็บ "หมวด / รายการคะแนน"
-- นิสิตทดสอบ 69999999 + คะแนน/กำหนดส่งสมมติ ไว้ลองดูหน้านิสิต (ลบได้ภายหลัง)
do $$
declare
  c   bigint;
  cat bigint;
  stu bigint;
  n   int;
begin
  insert into public.courses (code, name, semester)
  values ('265141', 'วิทยาการข้อมูลเบื้องต้น (Introduction to Data Science)', '1/2569')
  returning id into c;

  -- 1) การเข้าชั้นเรียน 5%
  insert into public.categories (course_id, name, default_item_percent, cap_percent, sort, note)
  values (c, 'การเข้าชั้นเรียน', 5, null, 1, 'ขาดได้ไม่เกิน 2 ครั้ง')
  returning id into cat;
  insert into public.items (category_id, title, max_score, sort, visible)
  values (cat, 'การเข้าชั้นเรียน', 5, 1, true);

  -- 2) การบ้าน / ใบงาน 15% (ตั้งต้น 5 ชิ้น ชิ้นละ 3% เพดาน 15%)
  insert into public.categories (course_id, name, default_item_percent, cap_percent, sort, note)
  values (c, 'การบ้าน / ใบงาน', 3, 15, 2, null)
  returning id into cat;
  for n in 1..5 loop
    insert into public.items (category_id, title, max_score, sort, visible, due_at)
    values (cat, 'ใบงานที่ ' || n, 10, n, n <= 2,
            case n when 1 then now() - interval '14 days'
                   when 2 then now() - interval '7 days'
                   when 3 then now() + interval '2 days'
                   when 4 then now() + interval '9 days'
                   else null end);
  end loop;

  -- 3) การทดสอบย่อย: สอบ 4 ครั้ง ครั้งละ 3% (รวม 12%) เก็บจริงไม่เกิน 10%
  insert into public.categories (course_id, name, default_item_percent, cap_percent, sort, note)
  values (c, 'การทดสอบย่อย', 3, 10, 3, 'สอบ 4 ครั้ง รวม 12% เก็บจริงไม่เกิน 10%')
  returning id into cat;
  insert into public.items (category_id, title, max_score, sort, visible) values
    (cat, 'ครั้งที่ 1 สอบปากเปล่า',       10, 1, true),
    (cat, 'ครั้งที่ 2 สอบ Lab',           10, 2, true),
    (cat, 'ครั้งที่ 3 สอบข้อกา ครั้งที่ 1', 10, 3, false),
    (cat, 'ครั้งที่ 4 สอบข้อกา ครั้งที่ 2', 10, 4, false);

  -- 4) สอบกลางภาค 35%
  insert into public.categories (course_id, name, default_item_percent, cap_percent, sort, note)
  values (c, 'สอบกลางภาค', 35, null, 4, 'สัปดาห์ที่ 8')
  returning id into cat;
  insert into public.items (category_id, title, max_score, sort, visible)
  values (cat, 'สอบกลางภาค', 100, 1, true);

  -- 5) สอบปลายภาค 35%
  insert into public.categories (course_id, name, default_item_percent, cap_percent, sort, note)
  values (c, 'สอบปลายภาค', 35, null, 5, 'สัปดาห์ที่ 16')
  returning id into cat;
  insert into public.items (category_id, title, max_score, sort, visible)
  values (cat, 'สอบปลายภาค', 100, 1, false);

  -- เกณฑ์การตัดเกรด 265141
  insert into public.grade_scale (course_id, grade, min_percent) values
    (c, 'A', 80), (c, 'B+', 75), (c, 'B', 70), (c, 'C+', 60),
    (c, 'C', 50), (c, 'D+', 45), (c, 'D', 40), (c, 'F', 0);

  -- นิสิตทดสอบ + คะแนนสมมติ (เฉพาะรายการที่ประกาศแล้ว)
  insert into public.students (course_id, student_id, full_name, section)
  values (c, '69999999', 'นิสิตทดสอบ (อาจารย์)', '1')
  returning id into stu;

  insert into public.scores (item_id, student_row_id, raw_score)
  select i.id, stu, v.score
  from (values
    ('การเข้าชั้นเรียน', 5),
    ('ใบงานที่ 1', 9),
    ('ใบงานที่ 2', 7),
    ('ครั้งที่ 1 สอบปากเปล่า', 8),
    ('ครั้งที่ 2 สอบ Lab', 10),
    ('สอบกลางภาค', 62)
  ) as v(title, score)
  join public.items i on i.title = v.title
  join public.categories k on k.id = i.category_id and k.course_id = c;
end $$;

-- ตรวจผล
select k.sort, k.name, k.default_item_percent, k.cap_percent, count(i.id) as items
from public.categories k
join public.courses c on c.id = k.course_id and c.code = '265141'
left join public.items i on i.category_id = k.id
group by k.id order by k.sort;

-- ลบนิสิตทดสอบภายหลัง:
-- delete from public.students where student_id = '69999999';
