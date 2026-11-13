-- =====================================================================
-- 01_schema.sql  —  ระยะ 1: ผู้ใช้ รายชื่อนิสิต หมวด/รายการคะแนน เกณฑ์เกรด
-- วิธีใช้: Supabase → SQL Editor → New query → วางทั้งไฟล์ → Run
-- =====================================================================

-- ---------- 1) โปรไฟล์ผู้ใช้ (ผูกกับระบบ login ของ Supabase) ----------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  student_id  text,
  full_name   text,
  role        text not null default 'student'
              check (role in ('teacher', 'ta', 'student')),
  created_at  timestamptz not null default now()
);

-- ---------- 2) รายวิชา ----------
create table public.courses (
  id        bigint generated always as identity primary key,
  code      text not null,
  name      text not null,
  semester  text
);

-- ---------- 3) รายชื่อนิสิตในวิชา (อาจารย์นำเข้าได้ก่อนนิสิตสมัคร) ----------
-- user_id จะถูกเติมอัตโนมัติเมื่อนิสิตสมัครด้วยรหัสนิสิตที่ตรงกัน
create table public.students (
  id          bigint generated always as identity primary key,
  course_id   bigint not null references public.courses(id) on delete cascade,
  student_id  text   not null,
  full_name   text   not null,
  section     text,
  user_id     uuid   references auth.users(id) on delete set null,
  unique (course_id, student_id)
);

-- ---------- 4) หมวดคะแนน (มีเพดาน) ----------
-- cap_percent          = เพดานของหมวด เช่น 12 (null = ไม่จำกัด)
-- default_item_percent = ค่าต่อครั้งของแต่ละรายการ เช่น 3
create table public.categories (
  id                    bigint generated always as identity primary key,
  course_id             bigint  not null references public.courses(id) on delete cascade,
  name                  text    not null,
  cap_percent           numeric,
  default_item_percent  numeric not null default 0,
  sort                  int     not null default 0
);

-- ---------- 5) รายการคะแนน (Q1, Q2, HW1, Midterm ...) ----------
-- item_percent = ค่าของรายการนี้ (null = ใช้ default_item_percent ของหมวด)
-- visible      = นิสิตเห็นรายการ/คะแนนนี้หรือยัง
create table public.items (
  id            bigint generated always as identity primary key,
  category_id   bigint  not null references public.categories(id) on delete cascade,
  title         text    not null,
  max_score     numeric not null check (max_score > 0),
  item_percent  numeric,
  due_at        timestamptz,
  visible       boolean not null default false,
  sort          int     not null default 0
);

-- ---------- 6) คะแนนดิบ (เก็บแค่คะแนนดิบ ส่วนอื่นคำนวณสด) ----------
create table public.scores (
  item_id         bigint  not null references public.items(id)    on delete cascade,
  student_row_id  bigint  not null references public.students(id) on delete cascade,
  raw_score       numeric,
  feedback        text,
  updated_by      uuid    default auth.uid(),
  updated_at      timestamptz not null default now(),
  primary key (item_id, student_row_id)
);

-- ---------- 7) เกณฑ์เกรด ----------
create table public.grade_scale (
  course_id    bigint  not null references public.courses(id) on delete cascade,
  grade        text    not null,
  min_percent  numeric not null,
  primary key (course_id, grade)
);

-- =====================================================================
-- ฟังก์ชันช่วย
-- =====================================================================

-- เป็นอาจารย์/TA หรือไม่
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('teacher', 'ta')
  );
$$;

-- เมื่อมีผู้สมัครใหม่: สร้างโปรไฟล์ + ผูกกับรายชื่อนิสิตที่รหัสตรงกัน (ผูกได้ครั้งเดียว)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, student_id, full_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'student_id',
    new.raw_user_meta_data ->> 'full_name'
  );

  update public.students
     set user_id = new.id
   where student_id = new.raw_user_meta_data ->> 'student_id'
     and user_id is null;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- View คำนวณคะแนน (คำนวณสดทุกครั้ง → แก้น้ำหนัก/เพดาน/เกณฑ์ ผลเปลี่ยนทันที)
-- security_invoker = เคารพสิทธิ์ของผู้เรียกดู (นิสิตเห็นแค่ของตัวเอง)
-- =====================================================================

-- คะแนนรายหมวด: ผลรวมจริง (raw_percent) และหลังตัดเพดาน (capped_percent)
create view public.category_totals
with (security_invoker = true) as
with per_item as (
  select
    s.id        as student_row_id,
    s.course_id,
    c.id        as category_id,
    c.name      as category_name,
    c.sort      as category_sort,
    c.cap_percent,
    sc.raw_score / i.max_score * coalesce(i.item_percent, c.default_item_percent) as pct
  from public.students s
  join public.categories c on c.course_id = s.course_id
  left join public.items  i  on i.category_id = c.id
  left join public.scores sc on sc.item_id = i.id and sc.student_row_id = s.id
)
select
  student_row_id,
  course_id,
  category_id,
  category_name,
  category_sort,
  cap_percent,
  round(coalesce(sum(pct), 0), 2) as raw_percent,
  round(
    case when cap_percent is null then coalesce(sum(pct), 0)
         else least(cap_percent, coalesce(sum(pct), 0)) end
  , 2) as capped_percent
from per_item
group by student_row_id, course_id, category_id, category_name, category_sort, cap_percent;

-- คะแนนรวม + เกรด
create view public.student_totals
with (security_invoker = true) as
with t as (
  select student_row_id, course_id, sum(capped_percent) as total
  from public.category_totals
  group by student_row_id, course_id
)
select
  t.student_row_id,
  t.course_id,
  round(t.total, 2) as total,
  (select g.grade
     from public.grade_scale g
    where g.course_id = t.course_id and g.min_percent <= t.total
    order by g.min_percent desc
    limit 1) as grade
from t;

-- =====================================================================
-- Row Level Security (สิทธิ์การเข้าถึง)
--   อาจารย์/TA : ทำได้ทุกอย่าง
--   นิสิต      : อ่านได้เฉพาะของตัวเอง และเฉพาะรายการที่ visible
-- =====================================================================
alter table public.profiles    enable row level security;
alter table public.courses     enable row level security;
alter table public.students    enable row level security;
alter table public.categories  enable row level security;
alter table public.items       enable row level security;
alter table public.scores      enable row level security;
alter table public.grade_scale enable row level security;

-- profiles
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_staff());

-- courses
create policy "read courses" on public.courses
  for select to authenticated using (true);
create policy "staff manage courses" on public.courses
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- students
create policy "read own student row" on public.students
  for select to authenticated using (user_id = auth.uid() or public.is_staff());
create policy "staff manage students" on public.students
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- categories
create policy "read categories" on public.categories
  for select to authenticated using (true);
create policy "staff manage categories" on public.categories
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- items
create policy "read visible items" on public.items
  for select to authenticated using (visible or public.is_staff());
create policy "staff manage items" on public.items
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- scores
create policy "read own visible scores" on public.scores
  for select to authenticated using (
    public.is_staff()
    or (
      student_row_id in (select id from public.students where user_id = auth.uid())
      and item_id in (select id from public.items where visible)
    )
  );
create policy "staff manage scores" on public.scores
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- grade_scale
create policy "read grade scale" on public.grade_scale
  for select to authenticated using (true);
create policy "staff manage grade scale" on public.grade_scale
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
