-- =====================================================================
-- 05_nickname.sql — ชื่อเล่นนิสิต
--   - นิสิตแก้ชื่อเล่นตัวเองได้ที่ "ข้อมูลส่วนตัว" (ผ่านฟังก์ชัน set_my_nickname เท่านั้น
--     นิสิตยังแก้ข้อมูลอื่นในโปรไฟล์ เช่น role ไม่ได้)
--   - อาจารย์แก้/นำเข้าชื่อเล่นได้ในแท็บรายชื่อนิสิต
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run (รันซ้ำได้)
-- =====================================================================

alter table public.students add column if not exists nickname text;
alter table public.profiles add column if not exists nickname text;

-- นิสิตตั้งชื่อเล่นของตัวเอง (อัปเดตทั้งโปรไฟล์และทุกรายวิชาที่ผูกบัญชีไว้)
create or replace function public.set_my_nickname(p_nickname text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n text := nullif(btrim(left(coalesce(p_nickname, ''), 40)), '');
begin
  if auth.uid() is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน';
  end if;
  update public.profiles set nickname = n where id = auth.uid();
  update public.students set nickname = n where user_id = auth.uid();
end;
$$;

revoke all on function public.set_my_nickname(text) from public, anon;
grant execute on function public.set_my_nickname(text) to authenticated;

-- สมัครใหม่: เก็บชื่อเล่นจากฟอร์มสมัคร และใส่ให้รายชื่อที่ผูกบัญชี (ถ้าอาจารย์ยังไม่ได้ตั้ง)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  nick text := nullif(btrim(new.raw_user_meta_data ->> 'nickname'), '');
begin
  insert into public.profiles (id, student_id, full_name, nickname)
  values (
    new.id,
    new.raw_user_meta_data ->> 'student_id',
    new.raw_user_meta_data ->> 'full_name',
    nick
  );

  update public.students
     set user_id  = new.id,
         nickname = coalesce(nickname, nick)
   where student_id = new.raw_user_meta_data ->> 'student_id'
     and user_id is null;

  return new;
end;
$$;

-- ตรวจผล: ควรได้ 2 แถว
select table_name, column_name
from information_schema.columns
where table_schema = 'public' and column_name = 'nickname'
order by table_name;
