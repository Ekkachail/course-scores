-- =====================================================================
-- 04_homework.sql — ระบบสั่งงาน / ส่งงาน / ส่งไฟล์ตรวจกลับ
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run
-- (มีคำสั่ง drop policy เพื่อให้รันซ้ำได้ — Supabase จะเตือน กด Run query ได้)
-- =====================================================================

-- ---------- 1) ข้อมูลงานที่สั่ง (เพิ่มในตาราง items) ----------
alter table public.items
  add column if not exists description     text,
  add column if not exists link_url        text,
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_size bigint,
  add column if not exists accept_files    boolean not null default false,
  add column if not exists file_types      text    not null default 'pdf,image',
  add column if not exists max_file_mb     numeric not null default 5,
  add column if not exists close_at        timestamptz;   -- รับงานช้าได้ถึง (null = ปิดตรงกำหนดส่ง)

-- ---------- 2) การส่งงาน (1 แถว ต่อ นิสิต ต่อ งาน) ----------
create table if not exists public.submissions (
  id              bigint generated always as identity primary key,
  item_id         bigint not null references public.items(id)    on delete cascade,
  student_row_id  bigint not null references public.students(id) on delete cascade,
  file_path       text,
  file_name       text,
  file_size       bigint,
  submitted_at    timestamptz not null default now(),
  is_late         boolean not null default false,
  submit_count    int     not null default 1,
  returned        boolean not null default false,   -- อาจารย์ส่งไฟล์ตรวจกลับ (แทนที่ไฟล์เดิม)
  returned_at     timestamptz,
  unique (item_id, student_row_id)
);

-- นิสิตส่งได้เมื่อ: เป็นเจ้าของรายชื่อ + งานเปิดรับไฟล์ + ยังไม่เลยเวลาปิดรับ
create or replace function public.can_submit(p_item bigint, p_row bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.students s
    join public.items i      on i.id = p_item
    join public.categories c on c.id = i.category_id and c.course_id = s.course_id
    where s.id = p_row
      and s.user_id = auth.uid()
      and i.accept_files
      and now() <= coalesce(i.close_at, i.due_at, 'infinity'::timestamptz)
  );
$$;

-- ตรวจจาก path ของไฟล์: {item_id}/{student_row_id}/submission.ext
create or replace function public.can_submit_path(p_name text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  parts text[] := storage.foldername(p_name);
begin
  if coalesce(array_length(parts, 1), 0) <> 2
     or parts[1] !~ '^[0-9]+$' or parts[2] !~ '^[0-9]+$' then
    return false;
  end if;
  return public.can_submit(parts[1]::bigint, parts[2]::bigint);
end;
$$;

-- เวลาส่ง / ส่งช้า กำหนดโดยเซิร์ฟเวอร์ (นิสิตแก้เองไม่ได้)
create or replace function public.submissions_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  due timestamptz;
begin
  if public.is_staff() then
    return new;
  end if;
  select due_at into due from public.items where id = new.item_id;
  new.submitted_at := now();
  new.is_late      := due is not null and now() > due;
  new.returned     := false;
  new.returned_at  := null;
  if tg_op = 'UPDATE' then
    new.item_id        := old.item_id;
    new.student_row_id := old.student_row_id;
    new.submit_count   := old.submit_count + 1;
  else
    new.submit_count := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_guard on public.submissions;
create trigger submissions_guard
  before insert or update on public.submissions
  for each row execute function public.submissions_guard();

alter table public.submissions enable row level security;

drop policy if exists "staff manage submissions" on public.submissions;
drop policy if exists "read own submissions"     on public.submissions;
drop policy if exists "submit own"               on public.submissions;
drop policy if exists "resubmit own"             on public.submissions;

create policy "staff manage submissions" on public.submissions
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "read own submissions" on public.submissions
  for select to authenticated
  using (student_row_id in (select id from public.students where user_id = auth.uid()));
create policy "submit own" on public.submissions
  for insert to authenticated with check (public.can_submit(item_id, student_row_id));
create policy "resubmit own" on public.submissions
  for update to authenticated
  using (public.can_submit(item_id, student_row_id))
  with check (public.can_submit(item_id, student_row_id));

-- ---------- 3) ที่เก็บไฟล์ (Storage bucket แบบส่วนตัว) ----------
-- แผนฟรี: พื้นที่รวม 1 GB, ไฟล์ละไม่เกิน 50 MB
insert into storage.buckets (id, name, public, file_size_limit)
values ('submissions', 'submissions', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "hw staff all"       on storage.objects;
drop policy if exists "hw read own"        on storage.objects;
drop policy if exists "hw read assignment" on storage.objects;
drop policy if exists "hw upload own"      on storage.objects;
drop policy if exists "hw update own"      on storage.objects;
drop policy if exists "hw delete own"      on storage.objects;

-- อาจารย์/TA: ทำได้ทุกอย่าง (ดาวน์โหลดทั้งหมด, ส่งไฟล์ตรวจกลับแทนที่, ลบ)
create policy "hw staff all" on storage.objects
  for all to authenticated
  using (bucket_id = 'submissions' and public.is_staff())
  with check (bucket_id = 'submissions' and public.is_staff());

-- นิสิต: อ่านไฟล์ของตัวเอง ({item}/{row ของตัวเอง}/...)
create policy "hw read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions'
         and (storage.foldername(name))[2] in
             (select id::text from public.students where user_id = auth.uid()));

-- ทุกคนที่ login: อ่านไฟล์โจทย์ ({item}/assignment/...)
create policy "hw read assignment" on storage.objects
  for select to authenticated
  using (bucket_id = 'submissions' and (storage.foldername(name))[2] = 'assignment');

-- นิสิต: อัปโหลด/ส่งใหม่/ลบไฟล์ของตัวเอง เฉพาะช่วงที่งานเปิดรับ
create policy "hw upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'submissions' and public.can_submit_path(name));
create policy "hw update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'submissions' and public.can_submit_path(name))
  with check (bucket_id = 'submissions' and public.can_submit_path(name));
create policy "hw delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'submissions' and public.can_submit_path(name));

-- ---------- 4) ปริมาณพื้นที่ที่ใช้ (อาจารย์เท่านั้น) ----------
create or replace function public.storage_usage()
returns table (bucket text, files bigint, bytes bigint)
language sql stable security definer set search_path = ''
as $$
  select o.bucket_id::text,
         count(*)::bigint,
         coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where public.is_staff()
  group by o.bucket_id;
$$;

-- ตรวจผล
select 'items columns' as what, count(*) as n
from information_schema.columns
where table_schema = 'public' and table_name = 'items' and column_name in ('description', 'accept_files', 'max_file_mb')
union all
select 'bucket', count(*) from storage.buckets where id = 'submissions';
-- ควรได้: items columns = 3, bucket = 1
