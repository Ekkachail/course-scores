-- =====================================================================
-- 06_attendance.sql — เช็คชื่อด้วย QR ที่เปลี่ยนทุก ~10 วินาที
--   - QR = ลิงก์ที่มีรหัสลับประจำช่วงเวลา (HMAC) ถ่ายรูปส่งต่อไม่ทันเพราะหมดอายุเร็ว
--   - นิสิตต้อง login ด้วยบัญชีตัวเอง · 1 บัญชีเช็คได้ 1 ครั้งต่อคาบ
--   - กรอบเวลา: เปิด–ปิด และเวลาที่เริ่มนับ "สาย" ตรวจโดยเซิร์ฟเวอร์
--   - เครื่องเดียวกันเช็คให้หลายบัญชี → ติดธงให้อาจารย์ตรวจ
-- วิธีใช้: SQL Editor → New snippet → วางทั้งไฟล์ → Run (รันซ้ำได้)
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- คาบเรียนที่เปิดเช็คชื่อ (นิสิตในวิชาอ่านได้ — ไม่มีรหัสลับในตารางนี้)
create table if not exists public.att_sessions (
  id          bigint generated always as identity primary key,
  course_id   bigint not null references public.courses(id) on delete cascade,
  title       text   not null,
  opens_at    timestamptz not null default now(),
  closes_at   timestamptz not null,
  late_after  timestamptz,                         -- null = ไม่นับสาย
  rotate_sec  int not null default 10 check (rotate_sec between 5 and 60),
  created_at  timestamptz not null default now()
);

-- รหัสลับของแต่ละคาบ (อาจารย์เท่านั้น)
create table if not exists public.att_secrets (
  session_id  bigint primary key references public.att_sessions(id) on delete cascade,
  secret      text not null
);

-- การเข้าเรียน (ไม่มีแถว = ขาด)
create table if not exists public.attendance (
  session_id      bigint not null references public.att_sessions(id) on delete cascade,
  student_row_id  bigint not null references public.students(id)     on delete cascade,
  status          text   not null check (status in ('present', 'late', 'excused')),
  scanned_at      timestamptz,
  device_id       text,
  flagged         boolean not null default false,
  note            text,
  primary key (session_id, student_row_id)
);

alter table public.att_sessions enable row level security;
alter table public.att_secrets  enable row level security;
alter table public.attendance   enable row level security;

drop policy if exists "staff manage att_sessions" on public.att_sessions;
drop policy if exists "read own course sessions"  on public.att_sessions;
drop policy if exists "staff manage att_secrets"  on public.att_secrets;
drop policy if exists "staff manage attendance"   on public.attendance;
drop policy if exists "read own attendance"       on public.attendance;

create policy "staff manage att_sessions" on public.att_sessions
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "read own course sessions" on public.att_sessions
  for select to authenticated
  using (course_id in (select course_id from public.students where user_id = auth.uid()));

create policy "staff manage att_secrets" on public.att_secrets
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create policy "staff manage attendance" on public.attendance
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "read own attendance" on public.attendance
  for select to authenticated
  using (student_row_id in (select id from public.students where user_id = auth.uid()));
-- นิสิตไม่มีสิทธิ์เขียนตาราง attendance โดยตรง — ต้องผ่าน check_in() เท่านั้น

-- เวลาของเซิร์ฟเวอร์ (หน้าจอ QR ใช้ปรับนาฬิกาให้ตรงกัน)
create or replace function public.server_now()
returns timestamptz
language sql stable
as $$ select now() $$;

-- เช็คชื่อ: p_code = "{session_id}-{ช่วงเวลา}-{token}" จาก QR
create or replace function public.check_in(p_code text, p_device text)
returns json
language plpgsql security definer set search_path = ''
as $$
declare
  parts    text[];
  v_sid    bigint;
  v_win    bigint;
  v_tok    text;
  v_now    timestamptz := now();
  v_cur    bigint;
  v_secret text;
  v_status text;
  v_flag   boolean := false;
  v_name   text;
  s        public.att_sessions;
  r        public.students;
  e        public.attendance;
begin
  if auth.uid() is null then
    return json_build_object('ok', false, 'error', 'กรุณาเข้าสู่ระบบก่อน');
  end if;

  parts := string_to_array(coalesce(p_code, ''), '-');
  if coalesce(array_length(parts, 1), 0) <> 3
     or parts[1] !~ '^[0-9]+$' or parts[2] !~ '^[0-9]+$' or parts[3] !~ '^[0-9a-f]{12}$' then
    return json_build_object('ok', false, 'error', 'QR ไม่ถูกต้อง');
  end if;
  v_sid := parts[1]::bigint;
  v_win := parts[2]::bigint;
  v_tok := parts[3];

  select * into s from public.att_sessions where id = v_sid;
  if not found then
    return json_build_object('ok', false, 'error', 'ไม่พบคาบเรียนนี้');
  end if;

  select * into r from public.students where course_id = s.course_id and user_id = auth.uid();
  if not found then
    return json_build_object('ok', false, 'error', 'บัญชีนี้ไม่อยู่ในรายชื่อของวิชานี้ — ติดต่ออาจารย์');
  end if;
  v_name := coalesce(nullif(to_jsonb(r) ->> 'nickname', ''), r.full_name);  -- ใช้ได้แม้ยังไม่รัน 05

  -- เช็คไปแล้ว: แจ้งผลเดิม
  select * into e from public.attendance where session_id = v_sid and student_row_id = r.id;
  if found then
    return json_build_object('ok', true, 'already', true, 'status', e.status,
      'scanned_at', e.scanned_at, 'name', v_name, 'title', s.title);
  end if;

  if v_now < s.opens_at then
    return json_build_object('ok', false, 'error', 'ยังไม่เปิดเช็คชื่อ');
  end if;
  if v_now > s.closes_at then
    return json_build_object('ok', false, 'error', 'ปิดเช็คชื่อคาบนี้แล้ว');
  end if;

  -- QR ต้องเป็นของช่วงเวลาปัจจุบัน (ยอมให้ช้าได้ ~2 รอบ เผื่อเน็ตช้า)
  v_cur := floor(extract(epoch from v_now) / s.rotate_sec)::bigint;
  if v_win > v_cur + 1 or v_win < v_cur - 2 then
    return json_build_object('ok', false, 'error', 'QR หมดอายุแล้ว — สแกน QR บนจออีกครั้ง');
  end if;

  select secret into v_secret from public.att_secrets where session_id = v_sid;
  if v_secret is null or v_tok <> left(encode(extensions.hmac(v_sid::text || ':' || v_win::text, v_secret, 'sha256'), 'hex'), 12) then
    return json_build_object('ok', false, 'error', 'QR ไม่ถูกต้อง');
  end if;

  v_status := case when s.late_after is not null and v_now > s.late_after then 'late' else 'present' end;

  -- เครื่องเดียวกันเคยเช็คให้บัญชีอื่นในคาบนี้ → ติดธงทั้งคู่
  if p_device is not null and exists (
       select 1 from public.attendance where session_id = v_sid and device_id = left(p_device, 64)) then
    v_flag := true;
    update public.attendance
       set flagged = true, note = coalesce(note, 'อุปกรณ์เดียวกับนิสิตคนอื่นในคาบนี้')
     where session_id = v_sid and device_id = left(p_device, 64);
  end if;

  insert into public.attendance (session_id, student_row_id, status, scanned_at, device_id, flagged, note)
  values (v_sid, r.id, v_status, v_now, left(p_device, 64), v_flag,
          case when v_flag then 'อุปกรณ์เดียวกับนิสิตคนอื่นในคาบนี้' end);

  return json_build_object('ok', true, 'already', false, 'status', v_status,
    'scanned_at', v_now, 'name', v_name, 'title', s.title, 'flagged', v_flag);
end;
$$;

revoke all on function public.check_in(text, text) from public, anon;
grant execute on function public.check_in(text, text) to authenticated;

-- ตรวจผล: ควรได้ 3 แถว
select table_name from information_schema.tables
where table_schema = 'public' and table_name in ('att_sessions', 'att_secrets', 'attendance')
order by 1;
