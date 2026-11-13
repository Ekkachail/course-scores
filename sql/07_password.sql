-- =====================================================================
-- 07_password.sql — อาจารย์ตั้ง "รหัสผ่านชั่วคราว" ให้นิสิตที่ลืมรหัส
--   ใช้แทนการส่งอีเมลรีเซ็ต (บริการอีเมลฟรีของ Supabase ส่งได้เฉพาะอีเมลสมาชิกทีม
--   และจำกัดจำนวนต่อชั่วโมง)
--   - เฉพาะอาจารย์/TA เรียกได้ · ตั้งได้เฉพาะบัญชีนิสิตที่ผูกกับรายชื่อแล้ว
--   - ตั้งรหัสของอาจารย์/TA ไม่ได้
--   - รหัสถูกเข้ารหัสทางเดียว (bcrypt) เหมือนตอนสมัคร ไม่มีใครอ่านรหัสเดิมได้
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run (รันซ้ำได้)
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_set_password(p_student_row bigint, p_password text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid;
begin
  if not public.is_staff() then
    raise exception 'เฉพาะอาจารย์/TA เท่านั้น';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'รหัสผ่านต้องยาวอย่างน้อย 6 ตัวอักษร';
  end if;

  select user_id into uid from public.students where id = p_student_row;
  if uid is null then
    raise exception 'นิสิตคนนี้ยังไม่ได้สมัครบัญชี';
  end if;
  if exists (select 1 from public.profiles where id = uid and role in ('teacher', 'ta')) then
    raise exception 'ตั้งรหัสผ่านของบัญชีอาจารย์/TA จากหน้านี้ไม่ได้';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = uid;
end;
$$;

revoke all on function public.admin_set_password(bigint, text) from public, anon;
grant execute on function public.admin_set_password(bigint, text) to authenticated;

-- ตรวจผล: ควรได้ 1 แถว
select proname from pg_proc where proname = 'admin_set_password';
