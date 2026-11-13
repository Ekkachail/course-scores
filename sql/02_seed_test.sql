-- =====================================================================
-- 02_seed_test.sql  —  ข้อมูลทดลอง เพื่อตรวจว่าระบบ "เก็บเกินแล้วตัดเพดาน" ถูกต้อง
-- รันหลัง 01_schema.sql แล้ว (ลบทิ้งได้ภายหลังด้วยคำสั่งท้ายไฟล์)
-- =====================================================================
do $$
declare
  c        bigint;
  cat_quiz bigint;
  cat_mid  bigint;
  n        int;
begin
  insert into public.courses (code, name, semester)
  values ('TEST101', 'วิชาทดลอง', '2/2569')
  returning id into c;

  insert into public.students (course_id, student_id, full_name) values
    (c, '66000001', 'นิสิต ก'),
    (c, '66000002', 'นิสิต ข'),
    (c, '66000003', 'นิสิต ค');

  -- สอบย่อย ครั้งละ 3% เพดาน 12%
  insert into public.categories (course_id, name, cap_percent, default_item_percent, sort)
  values (c, 'สอบย่อย', 12, 3, 1) returning id into cat_quiz;

  -- สอบกลางภาค 30% ไม่มีเพดาน
  insert into public.categories (course_id, name, cap_percent, default_item_percent, sort)
  values (c, 'สอบกลางภาค', null, 30, 2) returning id into cat_mid;

  for n in 1..5 loop
    insert into public.items (category_id, title, max_score, visible, sort)
    values (cat_quiz, 'Q' || n, 10, true, n);
  end loop;

  insert into public.items (category_id, title, max_score, visible, sort)
  values (cat_mid, 'Midterm', 60, true, 1);

  insert into public.grade_scale (course_id, grade, min_percent) values
    (c, 'A', 80), (c, 'B+', 75), (c, 'B', 70), (c, 'C+', 65),
    (c, 'C', 60), (c, 'D+', 55), (c, 'D', 50), (c, 'F', 0);

  -- คะแนนดิบ
  insert into public.scores (item_id, student_row_id, raw_score)
  select it.id, s.id, v.score
  from (values
    ('66000001','Q1',10), ('66000001','Q2',10), ('66000001','Q3',10),
    ('66000001','Q4',10), ('66000001','Q5',10), ('66000001','Midterm',48),
    ('66000002','Q1',10), ('66000002','Q2',7),  ('66000002','Q3',0),
    ('66000002','Q4',10), ('66000002','Q5',10), ('66000002','Midterm',30),
    ('66000003','Q1',10), ('66000003','Q2',10), ('66000003','Q3',10),
    ('66000003','Q4',10),                       ('66000003','Midterm',54)
  ) as v(sid, title, score)
  join public.students s on s.student_id = v.sid and s.course_id = c
  join public.items it  on it.title = v.title and it.category_id in (cat_quiz, cat_mid);
end $$;

-- ---------- ตรวจผลรายหมวด ----------
select s.full_name, t.category_name, t.raw_percent, t.capped_percent
from public.category_totals t
join public.students s on s.id = t.student_row_id
order by s.student_id, t.category_sort;

-- ผลที่ควรได้:
--   นิสิต ก | สอบย่อย    | 15.00 | 12.00   ← เกินเพดาน ตัดเหลือ 12
--   นิสิต ก | สอบกลางภาค | 24.00 | 24.00
--   นิสิต ข | สอบย่อย    | 11.10 | 11.10
--   นิสิต ข | สอบกลางภาค | 15.00 | 15.00
--   นิสิต ค | สอบย่อย    | 12.00 | 12.00   ← ขาด Q5 แต่ยังได้เต็ม
--   นิสิต ค | สอบกลางภาค | 27.00 | 27.00

-- ---------- ล้างข้อมูลทดลอง (รันเมื่อไม่ต้องการแล้ว) ----------
-- delete from public.courses where code = 'TEST101';
