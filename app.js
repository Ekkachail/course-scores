'use strict';
/* =====================================================================
   ระบบคะแนนรายวิชา — ระยะ 1
   - login / สมัคร (นิสิต)
   - อาจารย์: ตารางคะแนน (แก้ในตาราง, วางจาก Excel), หมวด/รายการ (เพดาน),
              เกณฑ์เกรด, รายชื่อนิสิต, ส่งออก Copy / CSV / Excel
   - นิสิต:   ดูคะแนนของตัวเอง (เฉพาะรายการที่เปิดให้เห็น)
   ===================================================================== */

const { SUPABASE_URL, SUPABASE_KEY } = window.APP_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const S = {
  session: null,
  profile: null,
  courses: [],
  courseId: null,
  tab: 'scores',
  exportMode: 'all',
  d: null, // ข้อมูลของรายวิชาที่เลือก
};

/* ---------- utilities ---------- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const num = (x) => (x === null || x === undefined || x === '' ? '' : String(r2(x)));
const f2 = (x) => r2(x).toFixed(2);
const key = (itemId, stuId) => itemId + ':' + stuId;

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 2200);
}
function fail(error, ctx) {
  console.error(ctx, error);
  toast((ctx ? ctx + ': ' : '') + (error?.message || error), 'err');
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

async function fetchAll(build) {
  let out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}

function download(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- กล่องโต้ตอบในหน้าเว็บ (แทน prompt/confirm ที่บางเบราว์เซอร์บล็อก) ----------
   fields ว่าง  → คืน true/false (ยืนยัน/ยกเลิก)
   มี fields   → คืน array ค่าที่กรอก หรือ null ถ้ายกเลิก */
function openForm({ title, message = '', fields = [], okText = 'ตกลง', danger = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.innerHTML = `<form>
      <h3>${esc(title)}</h3>
      ${message ? `<p class="dmsg">${esc(message)}</p>` : ''}
      ${fields.map((f, i) => `<label>${esc(f.label)}
        ${f.options
          ? `<select name="f${i}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
          : `<input name="f${i}" ${f.password ? 'type="password" autocomplete="new-password"' : ''} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}"
          ${f.numeric ? 'inputmode="decimal"' : ''} ${f.required ? 'required' : ''} autocomplete="off">`}</label>`).join('')}
      <div class="dactions">
        <button type="button" class="btn" data-cancel>ยกเลิก</button>
        <button type="submit" class="btn ${danger ? 'dangerfill' : 'primary'}">${esc(okText)}</button>
      </div></form>`;
    document.body.append(dlg);
    let result = null;
    const form = dlg.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = fields.map((_, i) => form.elements['f' + i].value.trim());
      dlg.close();
    });
    dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(fields.length ? result : result !== null); });
    dlg.showModal();
    (dlg.querySelector('input') || dlg.querySelector('[type=submit]')).focus();
  });
}
const uiConfirm = (title, message, okText = 'ยืนยัน', danger = true) => openForm({ title, message, okText, danger });

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* ---------- การคำนวณคะแนน (ตรงกับ view ในฐานข้อมูล) ---------- */
// สีประจำหมวดในตารางคะแนน (เรียงตามลำดับหมวด)
const CAT_COLORS = ['#cfe0f7', '#cdebd7', '#fbdcbc', '#e3d3f5', '#f6cfd4', '#c9eaec', '#f1e6b3', '#dcdcdc'];
const itemPct = (it, cat) => Number(it.item_percent ?? cat.default_item_percent ?? 0);

function compute(d, stuId) {
  let total = 0;
  const per = d.cats.map((c) => {
    let raw = 0;
    (d.itemsByCat.get(c.id) || []).forEach((it) => {
      const v = d.scores.get(key(it.id, stuId));
      if (v !== null && v !== undefined) raw += (Number(v) / Number(it.max_score)) * itemPct(it, c);
    });
    const capped = c.cap_percent === null ? raw : Math.min(Number(c.cap_percent), raw);
    total += capped;
    return { cat: c, raw, capped };
  });
  return { per, total, grade: gradeOf(total, d.scale) };
}

function gradeOf(total, scale) {
  const sorted = [...(scale || [])].sort((a, b) => b.min_percent - a.min_percent);
  const g = sorted.find((s) => r2(total) >= Number(s.min_percent));
  return g ? g.grade : '';
}

function indexData(d) {
  d.itemsByCat = new Map(d.cats.map((c) => [c.id, []]));
  d.items.forEach((it) => d.itemsByCat.get(it.category_id)?.push(it));
  d.itemById = new Map(d.items.map((it) => [it.id, it]));
  return d;
}

/* =====================================================================
   เริ่มระบบ / login
   ===================================================================== */
// ลิงก์ "ตั้งรหัสผ่านใหม่" จากอีเมลจะกลับมาที่หน้านี้พร้อม #...type=recovery
let RECOVERY = /type=recovery/.test(location.hash);
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') setTimeout(boot, 0);
  if (event === 'PASSWORD_RECOVERY') { RECOVERY = true; setTimeout(boot, 0); }
});
window.addEventListener("DOMContentLoaded", boot); // รอให้ hw.js / att.js โหลดครบก่อน

// ลิงก์จาก QR เช็คชื่อ: ?ci=...  (เก็บไว้ก่อน เผื่อต้อง login)
function pendingCheckIn(take = false) {
  try {
    const v = sessionStorage.getItem('pendingCI');
    if (take) sessionStorage.removeItem('pendingCI');
    return v;
  } catch { return null; }
}

async function boot() {
  if (typeof stopAttTimers === 'function') stopAttTimers();
  const ci = new URLSearchParams(location.search).get('ci');
  if (ci) {
    try { sessionStorage.setItem('pendingCI', ci); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  }
  app.innerHTML = '<div class="center muted">กำลังโหลด…</div>';
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  if (session && RECOVERY) return renderRecovery();
  if (!session) return renderAuth();

  const { data: prof, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) { fail(error, 'โหลดโปรไฟล์ไม่สำเร็จ'); return renderAuth(); }
  S.profile = prof || { role: 'student' };
  const code = pendingCheckIn(true);
  if (code) return checkInScreen(code);

  if (['teacher', 'ta'].includes(S.profile.role)) return teacherHome();
  return studentHome();
}

function renderAuth(mode = 'login') {
  const signup = mode === 'signup';
  app.innerHTML = `
  <div class="auth-wrap"><div class="card auth">
    <h1>ระบบคะแนนรายวิชา</h1>
    ${pendingCheckIn() ? '<div class="m-alert">📷 เข้าสู่ระบบเพื่อเช็คชื่อ — ถ้าขึ้นว่า QR หมดอายุ ให้สแกนบนจออีกครั้ง</div>' : ''}
    <div class="segtabs">
      <button data-mode="login" class="${!signup ? 'on' : ''}">เข้าสู่ระบบ</button>
      <button data-mode="signup" class="${signup ? 'on' : ''}">สมัครสมาชิก (นิสิต)</button>
    </div>
    <form id="authForm">
      ${signup ? `
        <label>รหัสนิสิต<input name="student_id" required inputmode="numeric" autocomplete="off"></label>
        <label>ชื่อ-นามสกุล<input name="full_name" required></label>
        <label>ชื่อเล่น (ไม่บังคับ)<input name="nickname" maxlength="40"></label>` : ''}
      <label>อีเมล<input name="email" type="email" required autocomplete="email"></label>
      <label>รหัสผ่าน (อย่างน้อย 6 ตัว)<input name="password" type="password" required minlength="6"
        autocomplete="${signup ? 'new-password' : 'current-password'}"></label>
      <button class="btn primary block" type="submit">${signup ? 'สมัครสมาชิก' : 'เข้าสู่ระบบ'}</button>
    </form>
    ${signup ? '<p class="hint">กรอกรหัสนิสิตให้ถูกต้อง ระบบจะผูกบัญชีกับรายชื่อในรายวิชาให้อัตโนมัติ</p>'
      : '<p class="center-sm"><button type="button" class="linkbtn" id="forgotPw">ลืมรหัสผ่าน?</button></p>'}
  </div></div>`;
  app.querySelector('#forgotPw')?.addEventListener('click', forgotPassword);

  app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => renderAuth(b.dataset.mode)));
  app.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      if (signup) {
        const { data, error } = await sb.auth.signUp({
          email: f.email.trim(),
          password: f.password,
          options: { data: { student_id: f.student_id.trim(), full_name: f.full_name.trim(), nickname: (f.nickname || '').trim() } },
        });
        if (error) throw error;
        if (!data.session) {
          toast('สมัครแล้ว — กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ');
          return renderAuth('login');
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: f.email.trim(), password: f.password });
        if (error) throw error;
      }
      boot();
    } catch (err) {
      toast((signup ? 'สมัครไม่สำเร็จ: ' : 'เข้าสู่ระบบไม่สำเร็จ: ') + AUTH_ERR(err), 'err');
      btn.disabled = false;
    }
  };
}

function header(extra = '') {
  const roleTh = { teacher: 'อาจารย์', ta: 'ผู้ช่วยสอน', student: 'นิสิต' }[S.profile.role] || '';
  return `<header class="top">
    <div class="brand">ระบบคะแนนรายวิชา</div>
    ${extra}
    <div class="spacer"></div>
    <span class="who">${esc(S.profile.nickname || S.profile.full_name || S.session.user.email)} · ${roleTh}</span>
    ${S.profile.role === 'student' ? '<button class="btn ghost" id="myProfile">👤 ข้อมูลส่วนตัว</button>' : ''}
    <button class="btn ghost" id="chgPw">🔑 เปลี่ยนรหัสผ่าน</button>
    <button class="btn ghost" id="logout">ออกจากระบบ</button>
  </header>`;
}
function bindHeader() {
  app.querySelector('#logout').onclick = () => sb.auth.signOut();
  const mp = app.querySelector('#myProfile');
  if (mp) mp.onclick = editMyProfile;
  const cp = app.querySelector('#chgPw');
  if (cp) cp.onclick = changePassword;
}

/* ---------- รหัสผ่าน ---------- */
const AUTH_ERR = (e) => {
  const m = String(e?.message || e || '');
  if (/rate limit|too many|seconds/i.test(m)) return 'ส่งอีเมลบ่อยเกินไป — รอสักครู่แล้วลองใหม่ หรือขอให้อาจารย์ตั้งรหัสผ่านชั่วคราวให้';
  if (/same.*password|different from the old/i.test(m)) return 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม';
  if (/weak|at least|short/i.test(m)) return 'รหัสผ่านสั้นหรือง่ายเกินไป';
  if (/invalid login/i.test(m)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง';
  return m;
};

async function askNewPassword(title, message) {
  const v = await openForm({
    title, message, okText: 'บันทึกรหัสผ่าน',
    fields: [
      { label: 'รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)', required: true, password: true },
      { label: 'พิมพ์รหัสผ่านใหม่อีกครั้ง', required: true, password: true },
    ],
  });
  if (!v) return null;
  if (v[0].length < 6) { toast('รหัสผ่านต้องยาวอย่างน้อย 6 ตัว', 'err'); return null; }
  if (v[0] !== v[1]) { toast('รหัสผ่านสองช่องไม่ตรงกัน', 'err'); return null; }
  return v[0];
}

// เปลี่ยนรหัสผ่าน (ต้อง login อยู่)
async function changePassword() {
  const pw = await askNewPassword('เปลี่ยนรหัสผ่าน', `บัญชี: ${S.session.user.email}`);
  if (!pw) return;
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) return toast('เปลี่ยนรหัสผ่านไม่สำเร็จ: ' + AUTH_ERR(error), 'err');
  toast('เปลี่ยนรหัสผ่านแล้ว — ครั้งหน้าใช้รหัสใหม่');
}

// ลืมรหัสผ่าน: ส่งลิงก์ไปที่อีเมล
async function forgotPassword() {
  const email = app.querySelector('#authForm [name=email]')?.value.trim() || '';
  const v = await openForm({
    title: 'ลืมรหัสผ่าน', okText: 'ส่งลิงก์',
    message: 'ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่อีเมล (ดูในกล่องจดหมายขยะด้วย)\nถ้าไม่ได้รับอีเมล ให้ติดต่ออาจารย์เพื่อตั้งรหัสผ่านชั่วคราว',
    fields: [{ label: 'อีเมลที่ใช้สมัคร', value: email, required: true }],
  });
  if (!v) return;
  const { error } = await sb.auth.resetPasswordForEmail(v[0].trim(), { redirectTo: location.origin + location.pathname });
  if (error) return toast('ส่งไม่สำเร็จ: ' + AUTH_ERR(error), 'err');
  toast('ถ้าอีเมลนี้มีบัญชี จะได้รับลิงก์ภายในไม่กี่นาที');
}

// หน้าตั้งรหัสผ่านใหม่ หลังกดลิงก์ในอีเมล
async function renderRecovery() {
  app.innerHTML = `<div class="auth-wrap"><div class="card auth">
    <h1>ตั้งรหัสผ่านใหม่</h1><p class="muted">บัญชี: ${esc(S.session.user.email)}</p>
    <button class="btn primary block" id="setPw">ตั้งรหัสผ่านใหม่</button></div></div>`;
  const go = async () => {
    const pw = await askNewPassword('ตั้งรหัสผ่านใหม่', `บัญชี: ${S.session.user.email}`);
    if (!pw) return;
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) return toast('ตั้งรหัสผ่านไม่สำเร็จ: ' + AUTH_ERR(error), 'err');
    RECOVERY = false;
    history.replaceState(null, '', location.pathname);
    toast('ตั้งรหัสผ่านใหม่แล้ว');
    boot();
  };
  app.querySelector('#setPw').onclick = go;
  go();
}

// นิสิตแก้ชื่อเล่นของตัวเอง
async function editMyProfile() {
  const p = S.profile;
  const v = await openForm({
    title: 'ข้อมูลส่วนตัว', okText: 'บันทึก',
    message: `รหัสนิสิต: ${p.student_id || '-'}\nชื่อ-สกุล: ${p.full_name || '-'}\nอีเมล: ${S.session.user.email}`,
    fields: [{ label: 'ชื่อเล่น (เว้นว่างได้ — ระบบจะเรียกด้วยชื่อจริง)', value: p.nickname || '', placeholder: 'เช่น ต้น' }],
  });
  if (!v) return;
  const { error } = await sb.rpc('set_my_nickname', { p_nickname: v[0] });
  if (error) return fail(error, 'บันทึกไม่สำเร็จ');
  p.nickname = v[0].trim() || null;
  toast(p.nickname ? `บันทึกแล้ว — สวัสดี ${p.nickname}` : 'ลบชื่อเล่นแล้ว');
  studentHome();
}

/* =====================================================================
   ฝั่งอาจารย์
   ===================================================================== */
async function teacherHome() {
  const { data, error } = await sb.from('courses').select('*').order('id');
  if (error) return fail(error, 'โหลดรายวิชาไม่สำเร็จ');
  S.courses = data;
  if (!data.find((c) => c.id === S.courseId)) {
    const saved = lsGet('courseId');
    S.courseId = data.find((c) => String(c.id) === saved)?.id ?? data[0]?.id ?? null;
  }
  try { await loadCourse(); } catch (e) { fail(e, 'โหลดข้อมูลรายวิชาไม่สำเร็จ'); }
  renderTeacher();
}

const course = () => S.courses.find((c) => c.id === S.courseId);

async function loadCourse() {
  S.d = null;
  if (!S.courseId) return;
  const cid = S.courseId;
  const [cats, students, scale] = await Promise.all([
    fetchAll(() => sb.from('categories').select('*').eq('course_id', cid).order('sort').order('id')),
    fetchAll(() => sb.from('students').select('*').eq('course_id', cid).order('section').order('student_id')),
    fetchAll(() => sb.from('grade_scale').select('*').eq('course_id', cid).order('min_percent', { ascending: false })),
  ]);
  const catIds = cats.map((c) => c.id);
  const items = catIds.length
    ? await fetchAll(() => sb.from('items').select('*').in('category_id', catIds).order('sort').order('id'))
    : [];
  const itemIds = items.map((i) => i.id);
  const scores = itemIds.length
    ? await fetchAll(() => sb.from('scores').select('item_id,student_row_id,raw_score,feedback').in('item_id', itemIds))
    : [];
  S.d = indexData({
    cats, items, students, scale,
    scores: new Map(scores.map((s) => [key(s.item_id, s.student_row_id), s.raw_score])),
    feedback: new Map(scores.filter((s) => s.feedback).map((s) => [key(s.item_id, s.student_row_id), s.feedback])),
  });
  try {
    S.d.subs = await loadSubs(itemIds);
    S.d.subsReady = true;
  } catch (e) {
    console.warn('submissions ยังไม่พร้อม (รัน 04_homework.sql)', e);
    S.d.subs = new Map();
    S.d.subsReady = false;
  }
  await loadAttTeacher(S.d, cid);
}

async function refresh() {
  try { await loadCourse(); } catch (e) { return fail(e, 'โหลดข้อมูลไม่สำเร็จ'); }
  keepFocus(renderTab);
}

function keepFocus(render) {
  const a = document.activeElement;
  const sel = a?.dataset?.edit
    ? `[data-edit="${a.dataset.edit}"][data-id="${a.dataset.id}"][data-field="${a.dataset.field}"]`
    : null;
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
  if (sel) app.querySelector(sel)?.focus();
}

function renderTeacher() {
  const opts = S.courses.map((c) =>
    `<option value="${c.id}" ${c.id === S.courseId ? 'selected' : ''}>${esc(c.code)} ${esc(c.name)}${c.semester ? ' (' + esc(c.semester) + ')' : ''}</option>`
  ).join('');
  const sel = `<select id="courseSel" ${S.courses.length ? '' : 'disabled'}>${opts || '<option>— ยังไม่มีรายวิชา —</option>'}</select>
               <button class="btn" id="newCourse">＋ วิชาใหม่</button>`;
  const tabs = [['scores', 'ตารางคะแนน'], ['hw', 'การบ้าน'], ['att', 'เช็คชื่อ'], ['setup', 'หมวด / รายการคะแนน'], ['scale', 'เกณฑ์เกรด'], ['roster', 'รายชื่อนิสิต'], ['student', '👁 มุมมองนิสิต']];

  app.innerHTML = header(sel) + (S.courseId && S.d
    ? `<nav class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</nav>
       <main id="main"></main>`
    : `<main class="center"><p>ยังไม่มีรายวิชา — กด “＋ วิชาใหม่” เพื่อเริ่ม</p></main>`);
  bindHeader();

  const cs = app.querySelector('#courseSel');
  if (cs) cs.onchange = async () => {
    S.courseId = Number(cs.value);
    lsSet('courseId', S.courseId);
    try { await loadCourse(); } catch (e) { fail(e, 'โหลดข้อมูลไม่สำเร็จ'); }
    renderTeacher();
  };
  app.querySelector('#newCourse').onclick = createCourse;
  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => {
    S.tab = b.dataset.tab;
    app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    renderTab();
  }));
  if (S.courseId && S.d) renderTab();
}

// เปิดแท็บ "มุมมองนิสิต" ที่นิสิตคนนี้ (เรียกจากชื่อในตารางคะแนน / ปุ่มในรายชื่อ)
function viewAsStudent(stuId) {
  S.viewStu = Number(stuId);
  S.tab = 'student';
  app.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'student'));
  renderTab();
  window.scrollTo(0, 0);
}

// ทำสำเนาข้อมูลที่ "เปิด" รายการที่ยังไม่ประกาศแต่กรอกคะแนนของนิสิตคนนี้ไว้แล้ว
// (รายการที่ยังไม่มีคะแนน ยังนับเป็น "ส่วนที่เหลือ" เพื่อให้เส้นชัย/ขาดอีกเท่าไรถูกต้อง)
function withAllPublished(d, stuId) {
  return indexData({
    ...d,
    items: d.items.map((it) => {
      if (it.visible) return it;
      const v = d.scores.get(key(it.id, stuId));
      return v === null || v === undefined ? it : { ...it, visible: true, teacherOnly: true };
    }),
  });
}

/* ---------- แท็บ: มุมมองนิสิต ---------- */
function tabStudent(m) {
  const d = S.d;
  if (!d.students.length) {
    m.innerHTML = '<div class="empty">ยังไม่มีรายชื่อนิสิต — ไปที่แท็บ “รายชื่อนิสิต” เพื่อนำเข้า</div>';
    return;
  }
  const list = d.students;
  let idx = list.findIndex((x) => x.id === S.viewStu);
  if (idx < 0) idx = 0;
  const s = list[idx];
  S.viewStu = s.id;
  const all = S.viewAll === true;
  const hidden = d.items.filter((i) => !i.visible).length;

  m.innerHTML = `<div class="page">
    <div class="svbar card">
      <div class="svpick">
        <button class="btn sm" id="svPrev" ${idx === 0 ? 'disabled' : ''} title="คนก่อนหน้า">‹</button>
        <select id="svSel">${list.map((x) => `<option value="${x.id}" ${x.id === s.id ? 'selected' : ''}>${esc(x.student_id)} ${esc(x.full_name)}${x.nickname ? ` (${esc(x.nickname)})` : ''}${x.section ? ` · กลุ่ม ${esc(x.section)}` : ''}</option>`).join('')}</select>
        <button class="btn sm" id="svNext" ${idx === list.length - 1 ? 'disabled' : ''} title="คนถัดไป">›</button>
        <span class="muted sm">${idx + 1} / ${list.length}</span>
      </div>
      <div class="segtabs svmode">
        <button data-mode="as" class="${all ? '' : 'on'}">เหมือนที่นิสิตเห็น</button>
        <button data-mode="all" class="${all ? 'on' : ''}">ทุกส่วน (รวมที่ยังไม่ประกาศ${hidden ? ` ${hidden} รายการ` : ''})</button>
      </div>
    </div>
    <div class="viewas"><span>${all
      ? 'โหมดอาจารย์: แสดงคะแนนที่กรอกไว้ทุกส่วน — ป้าย “นิสิตยังไม่เห็น” คือกรอกแล้วแต่ยังไม่ประกาศ · รายการที่ยังไม่กรอกคะแนนนับเป็นส่วนที่เหลือ'
      : 'แสดงเหมือนที่นิสิตคนนี้เห็นจริง (เฉพาะคะแนนที่ประกาศแล้ว) · ช่องลองเติมคะแนนจะไม่ถูกบันทึก'}</span>
      ${s.user_id ? '<span class="badge okb">ผูกบัญชีแล้ว</span>' : '<span class="badge">นิสิตยังไม่สมัคร</span>'}</div>
    <div id="sv"></div></div>`;

  const go = (id) => { S.viewStu = Number(id); tabStudent(m); };
  m.querySelector('#svSel').onchange = (e) => go(e.target.value);
  m.querySelector('#svPrev').onclick = () => idx > 0 && go(list[idx - 1].id);
  m.querySelector('#svNext').onclick = () => idx < list.length - 1 && go(list[idx + 1].id);
  m.querySelectorAll('.svmode [data-mode]').forEach((b) => (b.onclick = () => {
    S.viewAll = b.dataset.mode === 'all';
    tabStudent(m);
  }));
  renderStudentView(m.querySelector('#sv'), { course: course(), row: s, d: all ? withAllPublished(d, s.id) : d, persist: false });
}

function renderTab() {
  stopAttTimers();
  const m = app.querySelector('#main');
  if (!m) return;
  ({ scores: tabScores, setup: tabSetup, scale: tabScale, roster: tabRoster, student: tabStudent, hw: tabHomework, att: tabAttendance })[S.tab](m);
}

async function createCourse() {
  const cur = course();
  const v = await openForm({
    title: 'สร้างรายวิชาใหม่', okText: 'สร้าง',
    message: 'เลือก “คัดลอกโครงสร้าง” จากวิชาเดิม เพื่อได้หมวด สัดส่วน เพดาน รายการคะแนน และเกณฑ์เกรดเหมือนเดิม (ไม่คัดลอกรายชื่อ คะแนน กำหนดส่ง และไฟล์)',
    fields: [
      { label: 'รหัสวิชา', placeholder: 'เช่น 265141', required: true, value: cur?.code || '' },
      { label: 'ชื่อวิชา', required: true, value: cur?.name || '' },
      { label: 'ภาคเรียน', placeholder: 'เช่น 2/2569' },
      {
        label: 'คัดลอกโครงสร้างคะแนนจาก',
        value: cur?.id ?? '',
        options: [['', '— ไม่คัดลอก (เริ่มว่าง + เกณฑ์เกรดมาตรฐาน) —'],
          ...S.courses.map((c) => [c.id, `${c.code} ${c.name}${c.semester ? ' (' + c.semester + ')' : ''}`])],
      },
    ],
  });
  if (!v) return;
  const [code, name] = v;
  const semester = v[2] || null;
  const fromId = v[3] ? Number(v[3]) : null;
  if (S.courses.some((c) => c.code === code.trim() && (c.semester || '') === (semester || ''))) {
    if (!(await uiConfirm('มีรายวิชานี้อยู่แล้ว', `${code} ภาค ${semester || '-'} มีอยู่แล้ว ต้องการสร้างซ้ำอีกวิชาหรือไม่`, 'สร้างซ้ำ', false))) return;
  }
  const { data, error } = await sb.from('courses').insert({ code: code.trim(), name: name.trim(), semester }).select().single();
  if (error) return fail(error, 'สร้างรายวิชาไม่สำเร็จ');
  try {
    if (fromId) {
      const n = await copyStructure(fromId, data.id);
      toast(`สร้างรายวิชาแล้ว — คัดลอก ${n.cats} หมวด ${n.items} รายการ และเกณฑ์เกรด ${n.scale} ระดับ`);
    } else {
      await sb.from('grade_scale').insert(STD_SCALE.map((g) => ({ ...g, course_id: data.id })));
      toast('สร้างรายวิชาแล้ว');
    }
  } catch (e) {
    fail(e, 'สร้างวิชาแล้ว แต่คัดลอกโครงสร้างไม่ครบ — ตรวจในแท็บ “หมวด / รายการคะแนน”');
  }
  S.courseId = data.id;
  lsSet('courseId', data.id);
  S.tab = fromId ? 'roster' : 'setup';
  teacherHome();
}

// คัดลอก หมวด + รายการ + เกณฑ์เกรด จากวิชาเดิม (ไม่คัดลอกรายชื่อ คะแนน กำหนดส่ง ไฟล์)
async function copyStructure(fromId, toId) {
  const [cats, scale] = await Promise.all([
    fetchAll(() => sb.from('categories').select('*').eq('course_id', fromId).order('sort').order('id')),
    fetchAll(() => sb.from('grade_scale').select('*').eq('course_id', fromId)),
  ]);
  const OPTIONAL = ['description', 'link_url', 'accept_files', 'file_types', 'max_file_mb'];
  let nItems = 0;
  for (const c of cats) {
    const nc = { course_id: toId, name: c.name, default_item_percent: c.default_item_percent, cap_percent: c.cap_percent, sort: c.sort };
    if ('note' in c) nc.note = c.note;
    const { data: newCat, error } = await sb.from('categories').insert(nc).select().single();
    if (error) throw error;
    const items = await fetchAll(() => sb.from('items').select('*').eq('category_id', c.id).order('sort').order('id'));
    if (!items.length) continue;
    const rows = items.map((it) => {
      const r = { category_id: newCat.id, title: it.title, max_score: it.max_score, item_percent: it.item_percent, sort: it.sort, visible: false };
      OPTIONAL.forEach((k) => { if (k in it) r[k] = it[k]; });
      return r;
    });
    const { error: e2 } = await sb.from('items').insert(rows);
    if (e2) throw e2;
    nItems += rows.length;
  }
  const sc = scale.length ? scale.map((g) => ({ course_id: toId, grade: g.grade, min_percent: g.min_percent })) : STD_SCALE.map((g) => ({ ...g, course_id: toId }));
  const { error: e3 } = await sb.from('grade_scale').insert(sc);
  if (e3) throw e3;
  return { cats: cats.length, items: nItems, scale: sc.length };
}

/* ---------- แก้ข้อมูลทั่วไป (auto-save เมื่อเปลี่ยนค่า) ---------- */
async function onEdit(el) {
  const { edit: table, id, field, type } = el.dataset;
  let v = el.type === 'checkbox' ? el.checked : el.value.trim();
  if (type === 'num') v = v === '' ? 0 : Number(String(v).replace(',', '.'));
  if (type === 'numnull') v = v === '' ? null : Number(String(v).replace(',', '.'));
  if (type === 'int') v = parseInt(v || '0', 10);
  if (type === 'datetime') v = v ? new Date(v).toISOString() : null;
  if (['num', 'numnull', 'int'].includes(type) && v !== null && isNaN(v)) {
    el.classList.add('bad');
    return toast('ต้องเป็นตัวเลข', 'err');
  }
  if (field === 'max_score' && !(v > 0)) {
    el.classList.add('bad');
    return toast('คะแนนเต็มต้องมากกว่า 0', 'err');
  }
  el.classList.remove('bad');
  const { error } = await sb.from(table).update({ [field]: v }).eq('id', id);
  if (error) { el.classList.add('bad'); return fail(error, 'บันทึกไม่สำเร็จ'); }
  el.classList.add('saved');
  setTimeout(() => el.classList.remove('saved'), 800);

  if (table === 'courses') return teacherHome();
  const list = { categories: S.d.cats, items: S.d.items, students: S.d.students }[table];
  const obj = list?.find((o) => String(o.id) === String(id));
  if (obj) obj[field] = v;
  if (table === 'categories' && field === 'sort') S.d.cats.sort((a, b) => a.sort - b.sort || a.id - b.id);
  if (table === 'items' && field === 'sort') S.d.items.sort((a, b) => a.sort - b.sort || a.id - b.id);
  indexData(S.d);
  if (S.tab === 'setup') keepFocus(renderTab);
}

function bindEdits(m) {
  m.querySelectorAll('[data-edit]').forEach((el) => (el.onchange = () => onEdit(el)));
}

/* ---------- แท็บ: ตารางคะแนน ---------- */
function tabScores(m) {
  const d = S.d;
  if (!d.cats.length || !d.items.length) {
    m.innerHTML = '<div class="empty">ยังไม่มีหมวด/รายการคะแนน — ไปที่แท็บ “หมวด / รายการคะแนน” เพื่อสร้าง</div>';
    return;
  }
  if (!d.students.length) {
    m.innerHTML = '<div class="empty">ยังไม่มีรายชื่อนิสิต — ไปที่แท็บ “รายชื่อนิสิต” เพื่อนำเข้า</div>';
    return;
  }

  // ---- เลือกส่วนที่จะแสดง: ทุกหลัก / ทีละหมวด / ทีละรายการ / สรุปรายหมวด ----
  let view = S.scoreView || 'all';
  let showCats = d.cats;
  let onlyItem = null;
  let showItems = true;
  if (view.startsWith('cat:')) {
    showCats = d.cats.filter((c) => c.id === Number(view.slice(4)));
  } else if (view.startsWith('item:')) {
    const it = d.itemById.get(Number(view.slice(5)));
    if (it) { showCats = d.cats.filter((c) => c.id === it.category_id); onlyItem = it.id; }
  } else if (view === 'summary') {
    showItems = false;
  }
  if (!showCats.length) { view = S.scoreView = 'all'; showCats = d.cats; }
  const itemsShown = (c) => (!showItems ? [] : (d.itemsByCat.get(c.id) || []).filter((it) => !onlyItem || it.id === onlyItem));

  const viewOpts = `<option value="all" ${view === 'all' ? 'selected' : ''}>ทุกส่วน (แสดงทุกหลัก)</option>
    <option value="summary" ${view === 'summary' ? 'selected' : ''}>สรุปรายหมวด (ไม่แสดงคะแนนย่อย)</option>
    ${d.cats.map((c) => `<optgroup label="${esc(c.name)}">
      <option value="cat:${c.id}" ${view === 'cat:' + c.id ? 'selected' : ''}>▸ ทั้งหมวด ${esc(c.name)}</option>
      ${(d.itemsByCat.get(c.id) || []).map((it) => `<option value="item:${it.id}" ${view === 'item:' + it.id ? 'selected' : ''}>${esc(it.title)} (/${num(it.max_score)})</option>`).join('')}
    </optgroup>`).join('')}`;

  // สีประจำหมวด: หัวตารางสีเข้ม เนื้อตารางสีอ่อนของสีเดียวกัน
  const cc = (c) => CAT_COLORS[d.cats.indexOf(c) % CAT_COLORS.length];
  const tint = (c) => `background:color-mix(in srgb, ${cc(c)} 38%, var(--surface))`;
  const head = (c) => `background:${cc(c)}`;

  // ส่วนที่ 1: คะแนนดิบทุกรายการ (จัดกลุ่มตามหมวด)
  let h1 = '<th rowspan="2" class="stick c1">รหัสนิสิต</th><th rowspan="2" class="stick c2">ชื่อ-สกุล</th>';
  let h2 = '';
  showCats.forEach((c) => {
    const its = itemsShown(c);
    if (!its.length) return;
    h1 += `<th colspan="${its.length}" class="cat gstart" style="${head(c)}">${esc(c.name)}
             <small>${its.length > 1 ? `${its.length} รายการ · ` : ''}รวมเก็บได้ ${num(its.reduce((a, it) => a + itemPct(it, c), 0))}%</small></th>`;
    its.forEach((it, i) => {
      h2 += `<th class="itemh ${i === 0 ? 'gstart' : ''} ${it.visible ? '' : 'hid'}" style="${head(c)}" title="${it.visible ? 'ประกาศคะแนนแล้ว' : 'ยังไม่ประกาศคะแนน'}">
               ${esc(it.title)}<small>/${num(it.max_score)} · ${num(itemPct(it, c))}%</small></th>`;
    });
  });
  // ส่วนที่ 2: % ที่เก็บจริงของแต่ละหมวด (เกินเพดาน = ได้เท่าเพดาน)
  h1 += `<th colspan="${showCats.length}" class="pctgroup gstart">% ที่เก็บจริงของแต่ละหมวด <small>เกินเพดานได้เท่าเพดาน</small></th>`;
  showCats.forEach((c, i) => {
    h2 += `<th class="sub ${i === 0 ? 'gstart' : ''}" style="${head(c)}">${esc(c.name)}<small>เต็ม ${num(catMax(d, c))}%</small></th>`;
  });
  h1 += '<th rowspan="2" class="tot gstart">รวม %</th><th rowspan="2" class="tot">เกรด</th>';

  const body = d.students.map((s) => {
    let cells = '';
    showCats.forEach((c) => {
      itemsShown(c).forEach((it, i) => {
        const v = d.scores.get(key(it.id, s.id));
        const warn = v !== null && v !== undefined && (v > it.max_score || v < 0) ? 'warn' : '';
        cells += `<td class="${i === 0 ? 'gstart' : ''}" style="${tint(c)}"><input class="sc ${warn}" data-i="${it.id}" data-s="${s.id}" value="${v ?? ''}" inputmode="decimal" autocomplete="off"></td>`;
      });
    });
    showCats.forEach((c, i) => {
      cells += `<td class="sub ${i === 0 ? 'gstart' : ''}" style="${tint(c)}" id="c-${c.id}-${s.id}"></td>`;
    });
    return `<tr data-s="${s.id}" data-q="${esc((s.student_id + ' ' + s.full_name + ' ' + (s.nickname || '')).toLowerCase())}">
      <td class="stick c1">${esc(s.student_id)}</td>
      <td class="stick c2"><button type="button" class="namebtn" data-viewas="${s.id}" title="ดูแบบนิสิต">${esc(s.full_name)}</button>${s.nickname ? ` <span class="nick">(${esc(s.nickname)})</span>` : ''}${s.section ? ` <span class="secno" title="กลุ่ม ${esc(s.section)}">กลุ่ม ${esc(s.section)}</span>` : ''}</td>
      ${cells}
      <td class="tot gstart" id="t-${s.id}"></td><td class="tot grade" id="g-${s.id}"></td></tr>`;
  }).join('');

  const flt = S.scoreFilter || { col: '', op: 'lt', val: '' };
  const fsel = (v) => (flt.col === v ? 'selected' : '');
  const filterColOpts = d.cats.map((c) => `<optgroup label="${esc(c.name)}">
      ${(d.itemsByCat.get(c.id) || []).map((it) => `<option value="item:${it.id}" ${fsel('item:' + it.id)}>${esc(it.title)} (/${num(it.max_score)})</option>`).join('')}
      <option value="cat:${c.id}" ${fsel('cat:' + c.id)}>% ที่เก็บจริง: ${esc(c.name)} (เต็ม ${num(catMax(d, c))})</option>
    </optgroup>`).join('')
    + `<optgroup label="รวม"><option value="total" ${fsel('total')}>รวม %</option><option value="grade" ${fsel('grade')}>เกรด</option></optgroup>`;

  m.innerHTML = `
    <div class="toolbar">
      <label class="inl">แสดง <select id="viewSel">${viewOpts}</select></label>
      <input type="search" id="stuSearch" placeholder="ค้นหารหัส / ชื่อ" value="${esc(S.scoreSearch || '')}">
      <button class="btn primary" id="pasteBtn">📥 วางคะแนนจาก Excel</button>
      <div class="spacer"></div>
      <select id="expMode">
        <option value="all" ${S.exportMode === 'all' ? 'selected' : ''}>ส่งออก: ทุกคอลัมน์</option>
        <option value="summary" ${S.exportMode === 'summary' ? 'selected' : ''}>ส่งออก: สรุปรายหมวด</option>
        <option value="grade" ${S.exportMode === 'grade' ? 'selected' : ''}>ส่งออก: รหัส + ชื่อ + เกรด</option>
      </select>
      <button class="btn" id="expCopy">📋 Copy</button>
      <button class="btn" id="expCsv">CSV</button>
      <button class="btn" id="expXlsx">Excel</button>
    </div>
    <div class="toolbar filterbar">
      <span class="muted">กรองคะแนน</span>
      <select id="fCol"><option value="">— ไม่กรอง —</option>${filterColOpts}</select>
      <select id="fOp">${FILTER_OPS.map(([k, l]) => `<option value="${k}" ${flt.op === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input id="fVal" class="short" value="${esc(flt.val || '')}" placeholder="ค่า">
      <button class="btn sm" id="fClear">ล้างตัวกรอง</button>
      <span id="fCount" class="muted"></span>
    </div>
    <p class="hint">แก้ในตาราง: พิมพ์แล้วกด Enter (บันทึกอัตโนมัติ) · วางจาก Excel ตรงช่องในตาราง = วางตามลำดับแถวที่เห็น ·
      ปุ่ม “📥 วางคะแนนจาก Excel” = จับคู่ด้วย <b>รหัสนิสิต</b> (ลำดับใน Excel ไม่ต้องตรง) ·
      หัวคอลัมน์สีจาง = ยังไม่ประกาศ · <span class="over">ขีดฆ่า</span> = ส่วนที่เกินเพดาน · กดชื่อ = ดูแบบนิสิต</p>
    <div class="tablewrap"><table class="grid">
      <thead><tr>${h1}</tr><tr>${h2}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;

  // ค้นหา + กรองคะแนน (ซ่อนแถวที่ไม่ตรงเงื่อนไข)
  const applySearch = () => {
    const q = (S.scoreSearch || '').trim().toLowerCase();
    const f = S.scoreFilter || {};
    const test = f.col ? makeFilterTest(d, f) : null;
    let shown = 0;
    m.querySelectorAll('tbody tr').forEach((tr) => {
      const ok = (!q || tr.dataset.q.includes(q)) && (!test || test(Number(tr.dataset.s)));
      tr.hidden = !ok;
      if (ok) shown++;
    });
    const fc = m.querySelector('#fCount');
    fc.textContent = q || test ? `แสดง ${shown} จาก ${d.students.length} คน` : `${d.students.length} คน`;
    fc.className = q || test ? 'fcount on' : 'muted';
  };
  const readFilter = () => {
    S.scoreFilter = { col: m.querySelector('#fCol').value, op: m.querySelector('#fOp').value, val: m.querySelector('#fVal').value.trim() };
    const needVal = !['empty', 'has'].includes(S.scoreFilter.op);
    m.querySelector('#fVal').disabled = !needVal;
    m.querySelector('#fVal').placeholder = S.scoreFilter.col === 'grade' ? 'เช่น F' : 'ค่า';
    applySearch();
  };
  m.querySelector('#fCol').onchange = readFilter;
  m.querySelector('#fOp').onchange = readFilter;
  m.querySelector('#fVal').oninput = readFilter;
  m.querySelector('#fClear').onclick = () => {
    m.querySelector('#fCol').value = '';
    m.querySelector('#fVal').value = '';
    readFilter();
  };
  readFilter();
  m.querySelector('#stuSearch').oninput = (e) => { S.scoreSearch = e.target.value; applySearch(); };
  m.querySelector('#viewSel').onchange = (e) => { S.scoreView = e.target.value; tabScores(m); };
  m.querySelector('#pasteBtn').onclick = () => scoreImport(onlyItem);

  d.students.forEach((s) => updateRow(s.id));

  m.querySelector('#expMode').onchange = (e) => (S.exportMode = e.target.value);
  m.querySelector('#expCopy').onclick = async () => {
    const aoa = buildExport(S.exportMode);
    await copyText(aoa.map((r) => r.map((v) => String(v ?? '').replace(/[\t\n\r]/g, ' ')).join('\t')).join('\n'));
    toast('คัดลอกแล้ว — ไปวาง (Ctrl/⌘+V) ใน Excel ได้เลย');
  };
  m.querySelector('#expCsv').onclick = () => {
    const aoa = buildExport(S.exportMode);
    const csv = aoa.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    download(fileBase() + '.csv', new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  };
  m.querySelector('#expXlsx').onclick = () => {
    const aoa = buildExport(S.exportMode);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = aoa[0].map((h, i) => ({ wch: i === 1 ? 28 : Math.max(10, String(h).length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'คะแนน');
    XLSX.writeFile(wb, fileBase() + '.xlsx');
  };

  const tbody = m.querySelector('tbody');
  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('[data-viewas]');
    if (b) viewAsStudent(b.dataset.viewas);
  });
  tbody.addEventListener('change', (e) => {
    if (e.target.classList.contains('sc')) saveCells([e.target]);
  });
  tbody.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.classList.contains('sc')) return;
    if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let tr = el.closest('tr');
      do { tr = e.key === 'ArrowUp' ? tr.previousElementSibling : tr.nextElementSibling; } while (tr && tr.hidden);
      const next = tr?.querySelector(`input.sc[data-i="${el.dataset.i}"]`);
      if (next) { next.focus(); next.select(); } else el.blur();
    }
  });
  tbody.addEventListener('paste', (e) => {
    const el = e.target;
    if (!el.classList.contains('sc')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!/[\t\n]/.test(text.trim())) return; // ค่าเดียว ให้วางตามปกติ
    e.preventDefault();
    const grid = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').map((l) => l.split('\t'));
    const rows = [...tbody.querySelectorAll('tr')].filter((r) => !r.hidden);
    const r0 = rows.indexOf(el.closest('tr'));
    const c0 = [...el.closest('tr').querySelectorAll('input.sc')].indexOf(el);
    const changed = [];
    grid.forEach((line, ri) => {
      const row = rows[r0 + ri];
      if (!row) return;
      const ins = [...row.querySelectorAll('input.sc')];
      line.forEach((val, ci) => {
        const t = ins[c0 + ci];
        if (!t) return;
        t.value = val.trim();
        changed.push(t);
      });
    });
    saveCells(changed);
    toast(`วาง ${changed.length} ช่อง`);
  });
}

/* ---------- ตัวกรองคะแนน ---------- */
const FILTER_OPS = [
  ['lt', 'น้อยกว่า <'], ['le', 'ไม่เกิน ≤'], ['ge', 'ตั้งแต่ ≥'], ['gt', 'มากกว่า >'], ['eq', 'เท่ากับ ='],
  ['empty', 'ยังไม่มีคะแนน'], ['has', 'มีคะแนนแล้ว'],
];

function makeFilterTest(d, f) {
  const valueOf = (sid) => {
    if (f.col.startsWith('item:')) return d.scores.get(key(Number(f.col.slice(5)), sid)) ?? null;
    const r = compute(d, sid);
    if (f.col.startsWith('cat:')) {
      const cid = Number(f.col.slice(4));
      const its = d.itemsByCat.get(cid) || [];
      if (!its.some((it) => d.scores.get(key(it.id, sid)) != null)) return null; // ยังไม่มีคะแนนในหมวดนี้เลย
      return r2(r.per.find((x) => x.cat.id === cid)?.capped ?? 0);
    }
    if (f.col === 'total') return r2(r.total);
    if (f.col === 'grade') return r.grade;
    return null;
  };
  return (sid) => {
    const v = valueOf(sid);
    if (f.op === 'empty') return v === null || v === '';
    if (f.op === 'has') return v !== null && v !== '';
    if (f.val === '') return true; // ยังไม่ได้ใส่ค่า = ไม่กรอง
    if (f.col === 'grade') {
      const g = String(v || '').toUpperCase();
      const w = f.val.toUpperCase();
      if (f.op === 'eq') return g === w;
      // เปรียบเทียบเกรดตามลำดับเกณฑ์ (A สูงสุด)
      const order = [...d.scale].sort((a, b) => b.min_percent - a.min_percent).map((x) => x.grade.toUpperCase());
      const gi = order.indexOf(g), wi = order.indexOf(w);
      if (gi < 0 || wi < 0) return false;
      return { lt: gi > wi, le: gi >= wi, ge: gi <= wi, gt: gi < wi }[f.op];
    }
    const x = Number(f.val.replace(',', '.'));
    if (!Number.isFinite(x)) return true;
    if (v === null) return false;
    return { lt: v < x, le: v <= x, ge: v >= x, gt: v > x, eq: Math.abs(v - x) < 1e-9 }[f.op];
  };
}

/* ---------- วางคะแนนจาก Excel (จับคู่ด้วยรหัสนิสิต) ---------- */
const cleanSid = (v) => String(v ?? '').replace(/[^0-9]/g, '');
const normTitle = (v) => String(v ?? '').replace(/\s*\(\/[\d.]+\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

function scoreImport(defaultItem) {
  const d = S.d;
  const target0 = defaultItem || S.importTarget || 'multi';
  const opts = `<option value="multi" ${target0 === 'multi' ? 'selected' : ''}>หลายช่องพร้อมกัน (แถวแรกเป็นหัวคอลัมน์ = ชื่อรายการ)</option>`
    + d.cats.map((c) => `<optgroup label="${esc(c.name)}">${(d.itemsByCat.get(c.id) || []).map((it) =>
      `<option value="${it.id}" ${String(target0) === String(it.id) ? 'selected' : ''}>${esc(it.title)} (/${num(it.max_score)})</option>`).join('')}</optgroup>`).join('');

  const dlg = document.createElement('dialog');
  dlg.className = 'dialog wide';
  dlg.innerHTML = `<form>
    <h3>วางคะแนนจาก Excel</h3>
    <label>วางลงช่องคะแนน<select name="dest">${opts}</select></label>
    <p class="hint" id="impHint"></p>
    <textarea name="data" rows="9" placeholder="คัดลอกจาก Excel แล้ววาง (Ctrl/⌘+V) ที่นี่"></textarea>
    <label class="inl"><input type="checkbox" name="blank"> ช่องว่างใน Excel = ลบคะแนนเดิม (ปกติ: ข้ามช่องว่าง)</label>
    <div id="impPrev"></div>
    <div class="dactions">
      <button type="button" class="btn" data-cancel>ยกเลิก</button>
      <button type="button" class="btn" data-check>ตรวจสอบ</button>
      <button type="submit" class="btn primary" disabled>บันทึก</button>
    </div>
  </form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const f = dlg.querySelector('form');
  const saveBtn = f.querySelector('[type=submit]');
  let plan = [];

  const hint = () => {
    const multi = f.elements.dest.value === 'multi';
    const it = multi ? null : d.itemById.get(Number(f.elements.dest.value));
    dlg.querySelector('#impHint').innerHTML = multi
      ? `แถวแรก: <code>รหัสนิสิต | ชื่อรายการ 1 | ชื่อรายการ 2 | …</code> — ชื่อหัวคอลัมน์ต้องตรงกับชื่อรายการในระบบ
         (เช่น ${esc(d.items.slice(0, 3).map((i) => i.title).join(', '))}) · คอลัมน์อื่น เช่น ชื่อ-สกุล รวม เกรด จะถูกข้ามเอง ·
         ไฟล์ที่ “ส่งออก: ทุกคอลัมน์” จากหน้านี้ แก้แล้ววางกลับได้เลย`
      : `คัดลอก 2 คอลัมน์: <code>รหัสนิสิต | คะแนน</code> (มีคอลัมน์ชื่อคั่นกลางได้ — ใช้คอลัมน์แรกเป็นรหัส คอลัมน์สุดท้ายเป็นคะแนน)
         · คะแนนเต็ม ${num(it.max_score)} · ลำดับแถวไม่ต้องตรงกับในระบบ`;
    saveBtn.disabled = true;
    dlg.querySelector('#impPrev').innerHTML = '';
  };
  hint();
  f.elements.dest.onchange = hint;
  f.data.oninput = () => { saveBtn.disabled = true; };
  f.blank.onchange = () => { saveBtn.disabled = true; };
  f.querySelector('[data-cancel]').onclick = () => dlg.close();

  const bySid = new Map(d.students.map((s) => [s.student_id, s]));

  const check = () => {
    plan = [];
    const lines = f.data.value.replace(/\r/g, '').split('\n').map((l) => l.split('\t').map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
    const notFound = [];
    const bad = [];
    const skippedCols = [];
    const blankDel = f.blank.checked;
    const push = (s, it, rawCell) => {
      const old = d.scores.get(key(it.id, s.id)) ?? null;
      if (rawCell === '' || rawCell === '-') {
        if (blankDel && old !== null) plan.push({ s, it, old, nv: null });
        return;
      }
      const nv = Number(rawCell.replace(',', '.'));
      if (!Number.isFinite(nv)) { bad.push(`${s.student_id} ${it.title}: “${rawCell}”`); return; }
      if (old === nv) return;
      plan.push({ s, it, old, nv });
    };

    if (f.elements.dest.value === 'multi') {
      if (lines.length < 2) return show('ต้องมีแถวหัวคอลัมน์ และข้อมูลอย่างน้อย 1 แถว', notFound, bad, skippedCols);
      const head = lines[0];
      let sidCol = head.findIndex((h) => /รหัส|student|id/i.test(h));
      if (sidCol < 0) sidCol = 0;
      const colItem = head.map((h, i) => {
        if (i === sidCol) return null;
        const it = d.items.find((x) => normTitle(x.title) === normTitle(h));
        if (!it && h) skippedCols.push(h);
        return it || null;
      });
      lines.slice(1).forEach((r) => {
        const s = bySid.get(cleanSid(r[sidCol]));
        if (!s) { if (cleanSid(r[sidCol])) notFound.push(cleanSid(r[sidCol])); return; }
        colItem.forEach((it, i) => { if (it) push(s, it, r[i] ?? ''); });
      });
    } else {
      const it = d.itemById.get(Number(f.elements.dest.value));
      lines.forEach((r) => {
        const sid = cleanSid(r[0]);
        if (!sid || sid.length < 6) return; // แถวหัวตาราง / แถวว่าง
        const s = bySid.get(sid);
        if (!s) { notFound.push(sid); return; }
        push(s, it, r.length > 1 ? r[r.length - 1] : '');
      });
    }
    // ถ้ารหัสซ้ำ ใช้ค่าสุดท้าย
    const last = new Map();
    plan.forEach((p) => last.set(key(p.it.id, p.s.id), p));
    plan = [...last.values()];
    show('', notFound, bad, skippedCols);
  };

  const show = (err, notFound, bad, skippedCols) => {
    const over = plan.filter((p) => p.nv !== null && (p.nv > p.it.max_score || p.nv < 0));
    const box = dlg.querySelector('#impPrev');
    if (err) { box.innerHTML = `<div class="m-alert bad">${esc(err)}</div>`; saveBtn.disabled = true; return; }
    box.innerHTML = `
      <div class="impsum">
        <span class="badge okb">จะบันทึก ${plan.length} ช่อง</span>
        ${notFound.length ? `<span class="badge bad">ไม่พบรหัส ${notFound.length}</span>` : ''}
        ${bad.length ? `<span class="badge bad">ไม่ใช่ตัวเลข ${bad.length}</span>` : ''}
        ${over.length ? `<span class="badge wait">เกินคะแนนเต็ม ${over.length}</span>` : ''}
        ${skippedCols.length ? `<span class="badge">ข้ามคอลัมน์ ${skippedCols.length}</span>` : ''}
      </div>
      ${notFound.length ? `<p class="hint">ไม่พบในรายชื่อ: ${esc(notFound.slice(0, 15).join(', '))}${notFound.length > 15 ? ' …' : ''}</p>` : ''}
      ${bad.length ? `<p class="hint">ไม่ใช่ตัวเลข (ข้าม): ${esc(bad.slice(0, 8).join(' · '))}${bad.length > 8 ? ' …' : ''}</p>` : ''}
      ${skippedCols.length ? `<p class="hint">คอลัมน์ที่ไม่ตรงชื่อรายการ (ข้าม): ${esc(skippedCols.join(', '))}</p>` : ''}
      ${plan.length ? `<div class="tablewrap impwrap"><table class="mini">
        <thead><tr><th>รหัส</th><th>ชื่อ</th><th>รายการ</th><th>เดิม</th><th>ใหม่</th></tr></thead>
        <tbody>${plan.slice(0, 200).map((p) => `<tr>
          <td>${esc(p.s.student_id)}</td><td>${esc(p.s.full_name)}</td><td>${esc(p.it.title)}</td>
          <td class="muted">${p.old ?? '–'}</td>
          <td class="${p.nv !== null && (p.nv > p.it.max_score || p.nv < 0) ? 'warnt' : ''}"><b>${p.nv ?? 'ลบ'}</b></td></tr>`).join('')}
        </tbody></table></div>${plan.length > 200 ? `<p class="hint">… แสดง 200 จาก ${plan.length} รายการ</p>` : ''}`
      : '<p class="muted">ไม่มีคะแนนที่เปลี่ยนแปลง</p>'}`;
    saveBtn.disabled = !plan.length;
    saveBtn.textContent = plan.length ? `บันทึก ${plan.length} ช่อง` : 'บันทึก';
  };

  f.querySelector('[data-check]').onclick = check;
  f.data.addEventListener('paste', () => setTimeout(check, 0));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!plan.length) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'กำลังบันทึก…';
    const now = new Date().toISOString();
    const rows = plan.map((p) => ({ item_id: p.it.id, student_row_id: p.s.id, raw_score: p.nv, updated_at: now }));
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await sb.from('scores').upsert(rows.slice(i, i + 500), { onConflict: 'item_id,student_row_id' });
        if (error) throw error;
      }
      rows.forEach((r) => d.scores.set(key(r.item_id, r.student_row_id), r.raw_score));
      S.importTarget = f.elements.dest.value;
      dlg.close();
      toast(`บันทึก ${rows.length} ช่องแล้ว`);
      renderTab();
    } catch (err) {
      fail(err, 'บันทึกไม่สำเร็จ');
      saveBtn.disabled = false;
      saveBtn.textContent = `บันทึก ${plan.length} ช่อง`;
    }
  });
}

function updateRow(stuId) {
  const r = compute(S.d, stuId);
  r.per.forEach(({ cat, raw, capped }) => {
    const td = document.getElementById(`c-${cat.id}-${stuId}`);
    if (td) td.innerHTML = raw - capped > 1e-9
      ? `<span class="over">${f2(raw)}</span> ${f2(capped)}`
      : f2(capped);
  });
  const t = document.getElementById('t-' + stuId);
  if (t) t.textContent = f2(r.total);
  const g = document.getElementById('g-' + stuId);
  if (g) g.textContent = r.grade;
}

async function saveCells(els) {
  const rows = [];
  const ok = [];
  for (const el of els) {
    const it = S.d.itemById.get(Number(el.dataset.i));
    const raw = el.value.trim();
    let v = null;
    if (raw !== '') {
      v = Number(raw.replace(',', '.'));
      if (isNaN(v)) { el.classList.add('bad'); toast(`"${raw}" ไม่ใช่ตัวเลข`, 'err'); continue; }
    }
    el.classList.remove('bad');
    el.classList.toggle('warn', v !== null && (v > it.max_score || v < 0));
    el.classList.add('saving');
    ok.push(el);
    rows.push({ item_id: it.id, student_row_id: Number(el.dataset.s), raw_score: v, updated_at: new Date().toISOString() });
  }
  if (!rows.length) return;
  const { error } = await sb.from('scores').upsert(rows, { onConflict: 'item_id,student_row_id' });
  ok.forEach((el) => el.classList.remove('saving'));
  if (error) { ok.forEach((el) => el.classList.add('bad')); return fail(error, 'บันทึกคะแนนไม่สำเร็จ'); }
  rows.forEach((r) => S.d.scores.set(key(r.item_id, r.student_row_id), r.raw_score));
  new Set(rows.map((r) => r.student_row_id)).forEach(updateRow);
  ok.forEach((el) => { el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 800); });
  if (rows.some((r) => r.raw_score !== null && r.raw_score > S.d.itemById.get(r.item_id).max_score)) {
    toast('มีคะแนนที่เกินคะแนนเต็ม (ช่องสีส้ม) — ตรวจสอบอีกครั้ง', 'err');
  }
}

function fileBase() {
  const c = course();
  const date = new Date().toISOString().slice(0, 10);
  return `${c.code}_${(c.semester || '').replace(/\//g, '-')}_คะแนน_${date}`;
}

function buildExport(mode) {
  const d = S.d;
  const head = ['รหัสนิสิต', 'ชื่อ-สกุล'];
  if (mode !== 'grade') head.push('กลุ่ม');
  if (mode === 'all') {
    d.cats.forEach((c) => (d.itemsByCat.get(c.id) || []).forEach((it) => head.push(`${it.title} (/${num(it.max_score)})`)));
    d.cats.forEach((c) => head.push(`${c.name} (%)`));
  } else if (mode === 'summary') {
    d.cats.forEach((c) => head.push(`${c.name} (%)`));
  }
  if (mode !== 'grade') head.push('รวม (%)');
  head.push('เกรด');

  const rows = d.students.map((s) => {
    const r = compute(d, s.id);
    const row = [s.student_id, s.full_name];
    if (mode !== 'grade') row.push(s.section || '');
    if (mode === 'all') {
      r.per.forEach(({ cat }) => (d.itemsByCat.get(cat.id) || []).forEach((it) => row.push(d.scores.get(key(it.id, s.id)) ?? '')));
      r.per.forEach(({ capped }) => row.push(r2(capped)));
    } else if (mode === 'summary') {
      r.per.forEach(({ capped }) => row.push(r2(capped)));
    }
    if (mode !== 'grade') row.push(r2(r.total));
    row.push(r.grade);
    return row;
  });
  return [head, ...rows];
}

/* ---------- แท็บ: หมวด / รายการคะแนน ---------- */
function tabSetup(m) {
  const d = S.d;
  const c0 = course();
  let sumEff = 0;

  const catHtml = d.cats.map((c) => {
    const its = d.itemsByCat.get(c.id) || [];
    const possible = its.reduce((a, it) => a + itemPct(it, c), 0);
    const eff = c.cap_percent === null ? possible : Math.min(possible, Number(c.cap_percent));
    sumEff += eff;
    const short = c.cap_percent !== null && possible < Number(c.cap_percent);
    return `<section class="card">
      <div class="row wrap">
        <label class="grow">ชื่อหมวด<input data-edit="categories" data-id="${c.id}" data-field="name" value="${esc(c.name)}"></label>
        <label>ค่าต่อรายการ (%)<input class="short" data-edit="categories" data-id="${c.id}" data-field="default_item_percent" data-type="num" value="${num(c.default_item_percent)}"></label>
        <label>เพดานหมวด (%)<input class="short" data-edit="categories" data-id="${c.id}" data-field="cap_percent" data-type="numnull" value="${num(c.cap_percent)}" placeholder="ไม่จำกัด"></label>
        <label>ลำดับ<input class="tiny" data-edit="categories" data-id="${c.id}" data-field="sort" data-type="int" value="${c.sort}"></label>
        <button class="btn danger sm" data-delcat="${c.id}">ลบหมวด</button>
      </div>
      <div class="row"><label class="grow">หมายเหตุ (นิสิตเห็น เช่น “ขาดได้ไม่เกิน 2 ครั้ง”)
        <input data-edit="categories" data-id="${c.id}" data-field="note" value="${esc(c.note)}"></label></div>
      <p class="hint">เก็บได้รวม <b>${num(possible)}%</b>
        ${c.cap_percent !== null ? ` → นับจริงไม่เกิน <b>${num(c.cap_percent)}%</b>` : ''}
        ${short ? ' <span class="warnt">⚠ รายการยังรวมไม่ถึงเพดาน</span>' : ''}</p>
      <div class="tablewrap"><table class="mini">
        <thead><tr><th>ชื่อรายการ</th><th>คะแนนเต็ม</th><th>ค่า (%)</th><th>กำหนดส่ง</th><th>ประกาศคะแนน</th><th>ลำดับ</th><th></th></tr></thead>
        <tbody>${its.map((it) => `<tr>
          <td><input data-edit="items" data-id="${it.id}" data-field="title" value="${esc(it.title)}"></td>
          <td><input class="short" data-edit="items" data-id="${it.id}" data-field="max_score" data-type="num" value="${num(it.max_score)}"></td>
          <td><input class="short" data-edit="items" data-id="${it.id}" data-field="item_percent" data-type="numnull" value="${num(it.item_percent)}" placeholder="${num(c.default_item_percent)}"></td>
          <td><input type="datetime-local" data-edit="items" data-id="${it.id}" data-field="due_at" data-type="datetime" value="${toLocalInput(it.due_at)}"></td>
          <td class="ctr"><input type="checkbox" data-edit="items" data-id="${it.id}" data-field="visible" ${it.visible ? 'checked' : ''}></td>
          <td><input class="tiny" data-edit="items" data-id="${it.id}" data-field="sort" data-type="int" value="${it.sort}"></td>
          <td><button class="btn danger sm" data-delitem="${it.id}">ลบ</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">ยังไม่มีรายการ</td></tr>'}</tbody>
      </table></div>
      <div class="row">
        <button class="btn sm" data-additem="${c.id}">＋ เพิ่ม 1 รายการ</button>
        <button class="btn sm" data-addmany="${c.id}">＋ เพิ่มหลายรายการ</button>
        <button class="btn sm" data-showall="${c.id}">ประกาศคะแนนทุกรายการในหมวดนี้</button>
      </div>
    </section>`;
  }).join('');

  m.innerHTML = `
    <div class="card summary">รวมทุกหมวด (คิดตามเพดาน) = <b>${num(sumEff)}%</b>
      ${Math.abs(sumEff - 100) > 0.001 ? '<span class="warnt">⚠ ยังไม่เท่ากับ 100%</span>' : '<span class="okt">✓ ครบ 100%</span>'}
      <p class="hint">ช่อง “ค่า (%)” ของรายการ: เว้นว่าง = ใช้ “ค่าต่อรายการ” ของหมวด · ช่อง “เพดานหมวด” เว้นว่าง = ไม่จำกัด</p>
    </div>
    ${catHtml}
    <div class="card"><button class="btn primary" id="addCat">＋ เพิ่มหมวดคะแนน</button></div>
    <div class="card">
      <h3>ข้อมูลรายวิชา</h3>
      <div class="row wrap">
        <label>รหัสวิชา<input data-edit="courses" data-id="${c0.id}" data-field="code" value="${esc(c0.code)}"></label>
        <label class="grow">ชื่อวิชา<input data-edit="courses" data-id="${c0.id}" data-field="name" value="${esc(c0.name)}"></label>
        <label>ภาคเรียน<input data-edit="courses" data-id="${c0.id}" data-field="semester" value="${esc(c0.semester)}"></label>
        <button class="btn danger sm" id="delCourse">ลบรายวิชานี้</button>
      </div>
    </div>`;

  bindEdits(m);

  m.querySelector('#addCat').onclick = async () => {
    const v = await openForm({
      title: 'เพิ่มหมวดคะแนน', okText: 'เพิ่ม',
      fields: [
        { label: 'ชื่อหมวด', placeholder: 'เช่น สอบย่อย, การบ้าน, สอบปลายภาค', required: true },
        { label: 'ค่าต่อรายการ (%)', value: '0', numeric: true },
        { label: 'เพดานหมวด (%) — เว้นว่างถ้าไม่จำกัด', placeholder: 'เช่น 12', numeric: true },
      ],
    });
    if (!v) return;
    const [name, per, cap] = v;
    const { error } = await sb.from('categories').insert({
      course_id: S.courseId, name: name.trim(),
      default_item_percent: Number(per) || 0,
      cap_percent: cap === '' ? null : Number(cap),
      sort: d.cats.length + 1,
    });
    if (error) return fail(error, 'เพิ่มหมวดไม่สำเร็จ');
    refresh();
  };

  m.querySelectorAll('[data-delcat]').forEach((b) => (b.onclick = async () => {
    const c = d.cats.find((x) => x.id === Number(b.dataset.delcat));
    if (!(await uiConfirm('ลบหมวดคะแนน', `ลบหมวด “${c.name}” พร้อมรายการและคะแนนทั้งหมดในหมวดนี้\nย้อนกลับไม่ได้`, 'ลบหมวด'))) return;
    const { error } = await sb.from('categories').delete().eq('id', c.id);
    if (error) return fail(error, 'ลบไม่สำเร็จ');
    refresh();
  }));

  m.querySelectorAll('[data-delitem]').forEach((b) => (b.onclick = async () => {
    const it = d.itemById.get(Number(b.dataset.delitem));
    if (!(await uiConfirm('ลบรายการ', `ลบรายการ “${it.title}” พร้อมคะแนนของนิสิตทุกคนในรายการนี้\nย้อนกลับไม่ได้`, 'ลบรายการ'))) return;
    const { error } = await sb.from('items').delete().eq('id', it.id);
    if (error) return fail(error, 'ลบไม่สำเร็จ');
    refresh();
  }));

  m.querySelectorAll('[data-additem]').forEach((b) => (b.onclick = async () => {
    const cid = Number(b.dataset.additem);
    const n = (d.itemsByCat.get(cid) || []).length + 1;
    const v = await openForm({
      title: 'เพิ่มรายการ', okText: 'เพิ่ม',
      fields: [
        { label: 'ชื่อรายการ', value: `รายการ ${n}`, required: true },
        { label: 'คะแนนเต็ม', value: '10', numeric: true, required: true },
      ],
    });
    if (!v) return;
    const title = v[0];
    const max = Number(v[1]);
    if (!(max > 0)) return toast('คะแนนเต็มต้องมากกว่า 0', 'err');
    const { error } = await sb.from('items').insert({ category_id: cid, title: title.trim(), max_score: max, sort: n });
    if (error) return fail(error, 'เพิ่มรายการไม่สำเร็จ');
    refresh();
  }));

  m.querySelectorAll('[data-addmany]').forEach((b) => (b.onclick = async () => {
    const cid = Number(b.dataset.addmany);
    const v = await openForm({
      title: 'เพิ่มหลายรายการ', okText: 'เพิ่ม',
      fields: [
        { label: 'จำนวนรายการ', value: '5', numeric: true, required: true },
        { label: 'ชื่อนำหน้า (เช่น Q จะได้ Q1, Q2, …)', value: 'Q' },
        { label: 'คะแนนเต็มของแต่ละรายการ', value: '10', numeric: true, required: true },
      ],
    });
    if (!v) return;
    const count = parseInt(v[0], 10);
    if (!(count > 0 && count <= 50)) return toast('จำนวนรายการต้องอยู่ระหว่าง 1–50', 'err');
    const prefix = v[1];
    const max = Number(v[2]);
    if (!(max > 0)) return toast('คะแนนเต็มต้องมากกว่า 0', 'err');
    const start = (d.itemsByCat.get(cid) || []).length;
    const rows = Array.from({ length: count }, (_, i) => ({
      category_id: cid, title: `${prefix}${start + i + 1}`, max_score: max, sort: start + i + 1,
    }));
    const { error } = await sb.from('items').insert(rows);
    if (error) return fail(error, 'เพิ่มรายการไม่สำเร็จ');
    refresh();
  }));

  m.querySelectorAll('[data-showall]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('items').update({ visible: true }).eq('category_id', Number(b.dataset.showall));
    if (error) return fail(error, 'บันทึกไม่สำเร็จ');
    refresh();
  }));

  m.querySelector('#delCourse').onclick = async () => {
    const v = await openForm({
      title: 'ลบรายวิชา', danger: true, okText: 'ลบรายวิชา',
      message: `ลบรายวิชา ${c0.code} พร้อมรายชื่อและคะแนนทั้งหมด — ย้อนกลับไม่ได้`,
      fields: [{ label: `พิมพ์รหัสวิชา “${c0.code}” เพื่อยืนยัน`, required: true }],
    });
    if (!v) return;
    if (v[0] !== c0.code) return toast('รหัสวิชาไม่ตรง — ยกเลิกการลบ', 'err');
    const { error } = await sb.from('courses').delete().eq('id', c0.id);
    if (error) return fail(error, 'ลบไม่สำเร็จ');
    S.courseId = null;
    S.tab = 'scores';
    teacherHome();
  };
}

/* ---------- แท็บ: เกณฑ์เกรด ---------- */
const STD_SCALE = [
  { grade: 'A', min_percent: 80 }, { grade: 'B+', min_percent: 75 }, { grade: 'B', min_percent: 70 },
  { grade: 'C+', min_percent: 65 }, { grade: 'C', min_percent: 60 }, { grade: 'D+', min_percent: 55 },
  { grade: 'D', min_percent: 50 }, { grade: 'F', min_percent: 0 },
];

function tabScale(m) {
  const d = S.d;
  const rowHtml = (g) => `<tr>
    <td><input class="short g" value="${esc(g.grade)}"></td>
    <td><input class="short p" value="${num(g.min_percent)}" inputmode="decimal"></td>
    <td><button class="btn danger sm del">ลบ</button></td></tr>`;

  const dist = new Map(d.scale.map((g) => [g.grade, 0]));
  d.students.forEach((s) => {
    const g = compute(d, s.id).grade;
    dist.set(g || '(ไม่มี)', (dist.get(g || '(ไม่มี)') || 0) + 1);
  });
  const maxN = Math.max(1, ...dist.values());

  m.innerHTML = `
    <div class="cols">
      <div class="card">
        <h3>เกณฑ์เกรด</h3>
        <p class="hint">คะแนนรวม ≥ ค่าขั้นต่ำ จะได้เกรดนั้น · แก้แล้วกด “บันทึกเกณฑ์” ตารางคะแนนจะใช้เกณฑ์ใหม่ทันที</p>
        <table class="mini"><thead><tr><th>เกรด</th><th>ขั้นต่ำ (%)</th><th></th></tr></thead>
          <tbody id="scaleBody">${d.scale.map(rowHtml).join('')}</tbody></table>
        <div class="row wrap">
          <button class="btn sm" id="addG">＋ เพิ่มแถว</button>
          <button class="btn sm" id="stdG">ใช้เกณฑ์มาตรฐาน (A 80 … F 0)</button>
          <button class="btn primary" id="saveG">บันทึกเกณฑ์</button>
        </div>
      </div>
      <div class="card">
        <h3>การกระจายเกรดตอนนี้ (${d.students.length} คน)</h3>
        ${[...dist.entries()].map(([g, n]) => `
          <div class="bar"><span class="bl">${esc(g)}</span>
            <span class="bt"><span class="bf" style="width:${(n / maxN) * 100}%"></span></span>
            <span class="bn">${n}</span></div>`).join('')}
      </div>
    </div>`;

  const body = m.querySelector('#scaleBody');
  body.addEventListener('click', (e) => { if (e.target.classList.contains('del')) e.target.closest('tr').remove(); });
  m.querySelector('#addG').onclick = () => body.insertAdjacentHTML('beforeend', rowHtml({ grade: '', min_percent: '' }));
  m.querySelector('#stdG').onclick = () => (body.innerHTML = STD_SCALE.map(rowHtml).join(''));
  m.querySelector('#saveG').onclick = async () => {
    const rows = [...body.querySelectorAll('tr')].map((tr) => ({
      course_id: S.courseId,
      grade: tr.querySelector('.g').value.trim(),
      min_percent: Number(tr.querySelector('.p').value.trim().replace(',', '.')),
    })).filter((r) => r.grade);
    if (rows.some((r) => isNaN(r.min_percent))) return toast('ค่าขั้นต่ำต้องเป็นตัวเลข', 'err');
    if (new Set(rows.map((r) => r.grade)).size !== rows.length) return toast('มีชื่อเกรดซ้ำกัน', 'err');
    const del = await sb.from('grade_scale').delete().eq('course_id', S.courseId);
    if (del.error) return fail(del.error, 'บันทึกไม่สำเร็จ');
    if (rows.length) {
      const ins = await sb.from('grade_scale').insert(rows);
      if (ins.error) return fail(ins.error, 'บันทึกไม่สำเร็จ');
    }
    toast('บันทึกเกณฑ์เกรดแล้ว');
    refresh();
  };
}

/* ---------- แท็บ: รายชื่อนิสิต ---------- */
async function tabRoster(m) {
  const d = S.d;
  const linked = d.students.filter((s) => s.user_id).length;

  m.innerHTML = `
    <div class="cols">
      <div class="card">
        <h3>นำเข้า / อัปเดตรายชื่อ</h3>
        <p class="hint">คัดลอกจาก Excel: <b>รหัสนิสิต | ชื่อ-สกุล | กลุ่ม | ชื่อเล่น</b> (กลุ่มและชื่อเล่นเว้นได้) แล้ววางด้านล่าง
          — รหัสที่มีอยู่แล้วจะถูกอัปเดตชื่อ/กลุ่ม ไม่กระทบคะแนน</p>
        <textarea id="rosterIn" rows="8" placeholder="66000001	นายตัวอย่าง ใจดี	1&#10;66000002	นางสาวทดสอบ รักเรียน	1"></textarea>
        <div class="row"><button class="btn primary" id="importBtn">นำเข้า</button>
          <button class="btn" id="linkBtn">ผูกบัญชีที่สมัครไว้แล้ว</button></div>
      </div>
      <div class="card">
        <h3>สรุป</h3>
        <p>รายชื่อทั้งหมด <b>${d.students.length}</b> คน · สมัครและผูกบัญชีแล้ว <b>${linked}</b> คน</p>
        <div id="orphans" class="muted">กำลังตรวจบัญชีที่สมัครแล้วแต่ไม่อยู่ในรายชื่อ…</div>
      </div>
    </div>
    <div class="card">
      <div class="tablewrap"><table class="mini">
        <thead><tr><th>รหัสนิสิต</th><th>ชื่อ-สกุล</th><th>ชื่อเล่น</th><th>กลุ่ม</th><th>บัญชี</th><th></th></tr></thead>
        <tbody>${d.students.map((s) => `<tr>
          <td>${esc(s.student_id)}</td>
          <td><input data-edit="students" data-id="${s.id}" data-field="full_name" value="${esc(s.full_name)}"></td>
          <td><input class="short" data-edit="students" data-id="${s.id}" data-field="nickname" value="${esc(s.nickname)}" placeholder="—"></td>
          <td><input class="tiny" data-edit="students" data-id="${s.id}" data-field="section" value="${esc(s.section)}"></td>
          <td>${s.user_id ? '<span class="okt">✓ ผูกแล้ว</span>' : '<span class="muted">ยังไม่สมัคร</span>'}</td>
          <td class="nowrap">
            <button class="btn sm" data-viewas="${s.id}">ดูแบบนิสิต</button>
            ${s.user_id ? `<button class="btn sm" data-setpw="${s.id}" title="นิสิตลืมรหัสผ่าน">🔑 ตั้งรหัสชั่วคราว</button>
              <button class="btn sm" data-unlink="${s.id}">ยกเลิกการผูก</button>` : ''}
            <button class="btn danger sm" data-delstu="${s.id}">ลบ</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">ยังไม่มีรายชื่อ</td></tr>'}</tbody>
      </table></div>
    </div>`;

  bindEdits(m);

  m.querySelector('#importBtn').onclick = async () => {
    const lines = m.querySelector('#rosterIn').value.replace(/\r/g, '').split('\n');
    const rows = [];
    for (const line of lines) {
      const cols = line.split(/\t|,/).map((x) => x.trim());
      if (!cols[0] || /รหัส/.test(cols[0])) continue;
      const r = { course_id: S.courseId, student_id: cols[0], full_name: cols[1] || cols[0], section: cols[2] || null };
      if (cols[3]) r.nickname = cols[3]; // ไม่มีคอลัมน์ชื่อเล่น = ไม่ทับชื่อเล่นเดิม
      rows.push(r);
    }
    if (!rows.length) return toast('ไม่พบข้อมูลที่จะนำเข้า', 'err');
    const withNick = rows.filter((r) => 'nickname' in r);
    const noNick = rows.filter((r) => !('nickname' in r));
    for (const part of [withNick, noNick]) {
      if (!part.length) continue;
      const { error } = await sb.from('students').upsert(part, { onConflict: 'course_id,student_id' });
      if (error) return fail(error, 'นำเข้าไม่สำเร็จ');
    }
    await loadCourse();
    const n = await linkExisting();
    toast(`นำเข้า ${rows.length} รายชื่อ${n ? ` · ผูกบัญชีเพิ่ม ${n} คน` : ''}`);
    refresh();
  };

  m.querySelector('#linkBtn').onclick = async () => {
    const n = await linkExisting();
    toast(n ? `ผูกบัญชีเพิ่ม ${n} คน` : 'ไม่พบบัญชีใหม่ที่ผูกได้');
    refresh();
  };

  m.querySelectorAll('[data-viewas]').forEach((b) => (b.onclick = () => viewAsStudent(b.dataset.viewas)));

  m.querySelectorAll('[data-setpw]').forEach((b) => (b.onclick = async () => {
    const s = d.students.find((x) => x.id === Number(b.dataset.setpw));
    const suggest = String(Math.floor(100000 + Math.random() * 900000));
    const v = await openForm({
      title: 'ตั้งรหัสผ่านชั่วคราว',
      message: `${s.student_id} ${s.full_name}${s.nickname ? ` (${s.nickname})` : ''}\nแจ้งรหัสนี้ให้นิสิตโดยตรง แล้วให้นิสิตกด “🔑 เปลี่ยนรหัสผ่าน” หลังเข้าสู่ระบบ`,
      okText: 'ตั้งรหัสผ่าน',
      fields: [{ label: 'รหัสผ่านชั่วคราว (อย่างน้อย 6 ตัว)', value: suggest, required: true }],
    });
    if (!v) return;
    const { error } = await sb.rpc('admin_set_password', { p_student_row: s.id, p_password: v[0] });
    if (error) return fail(error, /admin_set_password|schema cache/.test(error.message) ? 'ต้องรัน 07_password.sql ก่อน' : 'ตั้งรหัสผ่านไม่สำเร็จ');
    await uiConfirm('ตั้งรหัสผ่านแล้ว', `${s.full_name}\nรหัสผ่านชั่วคราว: ${v[0]}\n\nเข้าสู่ระบบด้วยอีเมลเดิมของนิสิต + รหัสนี้`, 'ตกลง', false);
  }));

  m.querySelectorAll('[data-unlink]').forEach((b) => (b.onclick = async () => {
    if (!(await uiConfirm('ยกเลิกการผูกบัญชี', 'ยกเลิกการผูกบัญชีนี้กับรายชื่อ (คะแนนยังอยู่ครบ นิสิตจะไม่เห็นคะแนนจนกว่าจะผูกใหม่)', 'ยกเลิกการผูก', false))) return;
    const { error } = await sb.from('students').update({ user_id: null }).eq('id', Number(b.dataset.unlink));
    if (error) return fail(error, 'บันทึกไม่สำเร็จ');
    refresh();
  }));

  m.querySelectorAll('[data-delstu]').forEach((b) => (b.onclick = async () => {
    const s = d.students.find((x) => x.id === Number(b.dataset.delstu));
    if (!(await uiConfirm('ลบนิสิตออกจากรายวิชา', `ลบ ${s.student_id} ${s.full_name} ออกจากรายวิชา พร้อมคะแนนทั้งหมดของคนนี้\nย้อนกลับไม่ได้`, 'ลบ'))) return;
    const { error } = await sb.from('students').delete().eq('id', s.id);
    if (error) return fail(error, 'ลบไม่สำเร็จ');
    refresh();
  }));

  // บัญชีที่สมัครแล้วแต่ไม่อยู่ในรายชื่อวิชานี้
  const { data: profs, error } = await sb.from('profiles').select('id,student_id,full_name,nickname').eq('role', 'student');
  const box = m.querySelector('#orphans');
  if (!box) return;
  if (error) { box.textContent = 'ตรวจไม่สำเร็จ'; return; }
  const linkedIds = new Set(d.students.map((s) => s.user_id).filter(Boolean));
  const orphans = profs.filter((p) => !linkedIds.has(p.id));
  box.classList.remove('muted');
  box.innerHTML = orphans.length
    ? `<p><b>สมัครแล้วแต่ยังไม่ผูกกับรายชื่อวิชานี้ (${orphans.length})</b></p>
       <ul class="plain">${orphans.map((p) => `<li>${esc(p.student_id || '(ไม่ระบุรหัส)')} ${esc(p.full_name)}
         <button class="btn sm" data-adopt="${p.id}">เพิ่มเข้าวิชานี้</button></li>`).join('')}</ul>
       <p class="hint">มักเกิดจากพิมพ์รหัสนิสิตผิดตอนสมัคร หรือยังไม่ได้นำเข้ารายชื่อ</p>`
    : '<p class="okt">✓ ไม่มีบัญชีค้าง</p>';
  box.querySelectorAll('[data-adopt]').forEach((b) => (b.onclick = async () => {
    const p = orphans.find((x) => x.id === b.dataset.adopt);
    const v = await openForm({
      title: 'เพิ่มบัญชีเข้ารายวิชานี้', okText: 'ผูกบัญชี',
      message: `${p.full_name || ''}`,
      fields: [{ label: 'รหัสนิสิตที่ถูกต้องของบัญชีนี้', value: p.student_id || '', required: true }],
    });
    if (!v) return;
    const sid = v[0];
    const existing = d.students.find((s) => s.student_id === sid.trim());
    const res = existing
      ? await sb.from('students').update({ user_id: p.id, nickname: existing.nickname || p.nickname || null }).eq('id', existing.id)
      : await sb.from('students').insert({ course_id: S.courseId, student_id: sid.trim(), full_name: p.full_name || sid, nickname: p.nickname || null, user_id: p.id });
    if (res.error) return fail(res.error, 'บันทึกไม่สำเร็จ');
    toast('ผูกบัญชีแล้ว');
    refresh();
  }));
}

async function linkExisting() {
  const { data: profs, error } = await sb.from('profiles').select('id,student_id,nickname').eq('role', 'student');
  if (error) { fail(error, 'อ่านบัญชีไม่สำเร็จ'); return 0; }
  const used = new Set(S.d.students.map((s) => s.user_id).filter(Boolean));
  let n = 0;
  for (const s of S.d.students.filter((x) => !x.user_id)) {
    const p = profs.find((x) => (x.student_id || '').trim() === s.student_id && !used.has(x.id));
    if (!p) continue;
    const { error: e2 } = await sb.from('students').update({ user_id: p.id, nickname: s.nickname || p.nickname || null }).eq('id', s.id);
    if (!e2) { n++; used.add(p.id); }
  }
  return n;
}

/* =====================================================================
   ฝั่งนิสิต (ดัดแปลงจากหน้าคะแนน 252110)
   ===================================================================== */
const nf = (x, digits = 2) =>
  x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toLocaleString('th-TH', { maximumFractionDigits: digits });
const ceil2 = (x) => Math.ceil(x * 100 - 1e-9) / 100;

function computeWith(d, getRaw) {
  let total = 0;
  const per = d.cats.map((c) => {
    let raw = 0;
    (d.itemsByCat.get(c.id) || []).forEach((it) => {
      const v = getRaw(it);
      if (v !== null && v !== undefined) raw += (Number(v) / Number(it.max_score)) * itemPct(it, c);
    });
    const capped = c.cap_percent === null ? raw : Math.min(Number(c.cap_percent), raw);
    total += capped;
    return { cat: c, raw, capped };
  });
  return { per, total, grade: gradeOf(total, d.scale) };
}

const catMax = (d, c) => {
  const s = (d.itemsByCat.get(c.id) || []).reduce((a, it) => a + itemPct(it, c), 0);
  return c.cap_percent === null ? s : Math.min(Number(c.cap_percent), s);
};
const courseMax = (d) => d.cats.reduce((a, c) => a + catMax(d, c), 0);

// "เส้นชัย" ของแต่ละเกรด: ต้องได้อีกเท่าไร และต้องทำได้เฉลี่ยกี่ % ของส่วนที่ยังไม่ประกาศ
function finishLines(d, pub) {
  const at = (f) => computeWith(d, (it) => (it.visible ? pub(it) : f * it.max_score)).total;
  const current = at(0);
  const max = at(1);
  const lines = [...d.scale]
    .sort((a, b) => b.min_percent - a.min_percent)
    .map(({ grade, min_percent }) => {
      const min = Number(min_percent);
      if (r2(current) >= min) return { grade, min, status: 'reached', need: 0, fraction: 0 };
      if (r2(max) < min) return { grade, min, status: 'impossible', need: ceil2(min - current), fraction: null };
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (r2(at(mid)) >= min) hi = mid; else lo = mid;
      }
      return { grade, min, status: 'open', need: ceil2(min - current), fraction: hi };
    });
  return { current, max, remaining: max - current, lines };
}

function defaultGrade(lines) {
  const asc = lines.filter((l) => l.min > 0).sort((a, b) => a.min - b.min);
  return (asc.find((l) => l.status === 'open') || [...asc].reverse().find((l) => l.status === 'reached') || asc[0])?.grade;
}

function finishLineChart({ current, max, remaining, projected, lines, selected, scale }) {
  const pct = (v) => Math.max(0, Math.min(100, (v / (scale || 100)) * 100));
  const flags = lines.filter((l) => l.min > 0).sort((a, b) => a.min - b.min);
  const sel = flags.find((l) => l.grade === selected);
  const flagHtml = flags.map((l, i) => `
    <button type="button" class="flag ${l.status} lvl${i % 3} ${l === sel ? 'sel' : ''}" style="left:${pct(l.min)}%"
      data-grade="${esc(l.grade)}" aria-pressed="${l === sel}" aria-label="เกรด ${esc(l.grade)} เกณฑ์ ${nf(l.min)}">
      <span class="flag-label"><b>${esc(l.grade)}</b><span class="fl-num"> ${nf(l.min)}</span></span>
      <span class="flag-pole"></span>
    </button>`).join('');
  const gap = sel && sel.status === 'open'
    ? `<div class="rseg gap" style="left:${pct(current)}%;width:${pct(sel.min) - pct(current)}%"><span>+${nf(sel.need)}</span></div>` : '';
  const proj = projected != null && Math.abs(projected - current) > 1e-9
    ? `<div class="marker proj" style="left:${pct(projected)}%"><span>คาดการณ์ ${nf(projected, 1)}</span></div>` : '';
  let callout = '';
  if (sel?.status === 'open') {
    callout = `<div class="callout open"><span class="c-grade">${esc(sel.grade)}</span>
      <div><div class="c-main">ขาดอีก <b>${nf(sel.need)}</b> คะแนน</div>
      <div class="c-sub">จากที่ยังเก็บได้อีก ${nf(remaining)} · ต้องได้เฉลี่ย ≥ ${nf(sel.fraction * 100, 0)}% ของส่วนที่ยังไม่ประกาศ</div></div></div>`;
  } else if (sel?.status === 'reached') {
    callout = `<div class="callout reached"><span class="c-grade">${esc(sel.grade)}</span><div class="c-main">✓ ถึงเกณฑ์เกรด ${esc(sel.grade)} แล้ว</div></div>`;
  } else if (sel) {
    callout = `<div class="callout impossible"><span class="c-grade">${esc(sel.grade)}</span><div class="c-main">ได้เต็มทุกส่วนที่เหลือ ก็ยังไม่ถึงเกรด ${esc(sel.grade)}</div></div>`;
  }
  return `<div class="race">
    ${callout}
    <p class="race-hint">แตะที่ธงเกรดเพื่อดูว่าขาดอีกกี่คะแนน</p>
    <div class="race-flags">${flagHtml}</div>
    <div class="race-track" role="img" aria-label="ตอนนี้ ${nf(current, 1)} สูงสุดที่ยังทำได้ ${nf(max, 1)}">
      <div class="rseg done" style="width:${pct(current)}%"></div>
      <div class="rseg possible" style="left:${pct(current)}%;width:${pct(max) - pct(current)}%"></div>
      ${gap}${proj}
      <div class="marker now" style="left:${pct(current)}%"><span>ตอนนี้ ${nf(current, 1)}</span></div>
    </div>
    <div class="race-axis"><span>0</span><span>${nf(scale / 2)}</span><span>${nf(scale)}</span></div>
    <div class="legend">
      <span><i class="sw done"></i>ประกาศแล้ว</span>
      <span><i class="sw possible"></i>ยังเก็บได้ (สูงสุด ${nf(max)})</span>
      ${gap ? '<span><i class="sw gap"></i>ส่วนที่ขาด</span>' : ''}
      ${proj ? '<span><i class="sw proj"></i>คาดการณ์</span>' : ''}
    </div></div>`;
}

function gradeTable(scale, lines, selected) {
  const cuts = [...scale].sort((a, b) => b.min_percent - a.min_percent);
  return cuts.map((c, i) => {
    const min = Number(c.min_percent);
    const range = i === 0 ? `≥ ${nf(min)}` : min === 0 ? `< ${nf(cuts[i - 1].min_percent)}` : `${nf(min)}–${nf(cuts[i - 1].min_percent - 0.01)}`;
    const l = lines.find((x) => x.grade === c.grade);
    const status = min === 0 ? 'base' : l?.status;
    const tag = status === 'reached' ? '✓ ถึงแล้ว' : status === 'open' ? `ขาดอีก ${nf(l.need)}` : status === 'impossible' ? 'ไม่ถึงแล้ว' : '';
    const click = min > 0;
    return `<${click ? 'button type="button"' : 'div'} class="g ${status || ''} ${c.grade === selected ? 'sel' : ''}" ${click ? `data-grade="${esc(c.grade)}"` : ''}>
      <b class="g-name">${esc(c.grade)}</b><span class="g-range">${range}</span>${tag ? `<span class="g-tag">${tag}</span>` : ''}
    </${click ? 'button' : 'div'}>`;
  }).join('');
}

const thaiDT = (v) => new Date(v).toLocaleString('th-TH', {
  timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
}) + ' น.';

// หน้าคะแนนของนิสิต — อาจารย์ใช้หน้าเดียวกันใน "ดูแบบนิสิต"
function renderStudentView(root, { course: c, row, d, persist = true, onChanged }) {
  root._ac?.abort();
  const ac = new AbortController();
  root._ac = ac;

  const rawOf = (it) => d.scores.get(key(it.id, row.id)) ?? null;
  const pub = (it) => (it.visible ? rawOf(it) : null);
  const fbOf = (it) => (it.visible ? d.feedback?.get(key(it.id, row.id)) : null);
  const wKey = `whatif:${c.id}:${row.id}`;
  let whatIf = {};
  if (persist) { try { whatIf = JSON.parse(lsGet(wKey) || '{}'); } catch { whatIf = {}; } }
  for (const k of Object.keys(whatIf)) if (!d.items.find((i) => String(i.id) === k && !i.visible)) delete whatIf[k];
  const saveWI = () => persist && lsSet(wKey, JSON.stringify(whatIf));
  const parseWI = (it) => {
    const s = String(whatIf[it.id] ?? '').trim().replace(',', '.');
    if (s === '') return null;
    const v = Number(s);
    return Number.isFinite(v) ? Math.max(0, Math.min(Number(it.max_score), v)) : null;
  };
  const unpublished = d.items.filter((it) => !it.visible);
  const scale = courseMax(d);
  let selGrade = null;

  const itemRow = (it, cat) => {
    const fb = fbOf(it);
    const due = it.due_at ? ` <span class="badge">ส่ง ${thaiDT(it.due_at)}</span>` : '';
    if (it.visible) {
      const raw = pub(it);
      return `<div class="item">
        <div class="item-name">${esc(it.title)}${it.teacherOnly ? ' <span class="badge tonly">นิสิตยังไม่เห็น</span>' : ''}${due}${fb ? `<div class="fb">💬 ${esc(fb)}</div>` : ''}</div>
        <div class="item-raw">${raw === null ? '<span class="muted">ไม่มีคะแนน</span>' : `${nf(raw)} <span class="muted">/ ${nf(it.max_score)}</span>`}</div>
        <div class="item-w">${nf(raw === null ? 0 : (raw / it.max_score) * itemPct(it, cat))} <span class="muted">/ ${nf(itemPct(it, cat))}%</span></div>
      </div>`;
    }
    return `<div class="item pending">
      <div class="item-name">${esc(it.title)} <span class="badge wait">ยังไม่ประกาศ</span>${due}</div>
      <label class="item-raw whatif"><span class="sr">ลองเติมคะแนน ${esc(it.title)}</span>
        <input type="number" inputmode="decimal" min="0" max="${it.max_score}" step="any" data-whatif="${it.id}"
          value="${esc(whatIf[it.id] ?? '')}" placeholder="ลองเติม"> <span class="muted">/ ${nf(it.max_score)}</span></label>
      <div class="item-w" data-w="${it.id}"></div>
    </div>`;
  };

  const sectionHtml = (cat) => {
    const its = d.itemsByCat.get(cat.id) || [];
    const max = catMax(d, cat);
    const capNote = cat.cap_percent !== null && its.reduce((a, it) => a + itemPct(it, cat), 0) > Number(cat.cap_percent)
      ? `เก็บได้รวม ${nf(its.reduce((a, it) => a + itemPct(it, cat), 0))}% นับจริงไม่เกิน ${nf(cat.cap_percent)}%` : '';
    const note = [cat.note, capNote].filter(Boolean).join(' · ');
    const head = `<div class="sec-name">${esc(cat.name)} <span class="chip">${nf(max)}%</span>${its.some((i) => i.teacherOnly) ? ' <span class="badge tonly">นิสิตยังไม่เห็น</span>' : ''}
        ${note ? `<div class="sec-note">${esc(note)}</div>` : ''}</div>
      <div class="sec-score" data-sec="${cat.id}"></div>`;
    if (its.length <= 1 && (its[0]?.visible ?? true)) return `<div class="sec single">${head}</div>`;
    return `<details class="sec" ${its.some((i) => !i.visible) ? '' : ''}>
      <summary>${head}<span class="chev" aria-hidden="true"></span></summary>
      <div class="sec-body">${its.map((it) => itemRow(it, cat)).join('')}</div></details>`;
  };

  root.innerHTML = `
    <section class="hello">
      <p class="eyebrow">${esc(c.code)} ${esc(c.name)}${c.semester ? ` · ภาค ${esc(c.semester)}` : ''}${row.section ? ` · กลุ่ม ${esc(row.section)}` : ''}</p>
      <h1>สวัสดี ${esc(row.nickname || row.full_name)}</h1>
      <p class="muted">${row.nickname ? `${esc(row.full_name)} · ` : ''}รหัสนิสิต ${esc(row.student_id)}</p>
    </section>
    <section class="tiles" id="sv-tiles"></section>
    <section class="card"><div class="card-head"><h2>เส้นชัยของแต่ละเกรด</h2></div><div id="sv-race"></div></section>
    <div id="sv-hw"></div>
    <div id="sv-att"></div>
    <section class="card">
      <div class="card-head"><h2>คะแนนรายส่วน</h2>
        <p class="muted">กดที่แต่ละส่วนเพื่อดูคะแนนย่อย · ช่องที่ยังไม่ประกาศ ลองเติมคะแนนเพื่อประเมินเกรดตัวเองได้</p></div>
      ${unpublished.length ? `<div class="quickfill">
        <label for="qf">ลองเติมทุกช่องที่ยังไม่ประกาศเป็น <b id="qf-v">–</b></label>
        <input type="range" id="qf" min="0" max="100" step="5" value="0">
        <button type="button" class="btn ghost sm" id="qf-clear">ล้างค่าที่ลองเติม</button></div>` : ''}
      <div class="sections">${d.cats.map(sectionHtml).join('')}</div>
      <div class="sec total-row"><div class="sec-name">รวม</div><div class="sec-score" id="sv-total"></div></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>เกณฑ์การตัดเกรด</h2>
        <p class="muted">ตามประมวลรายวิชา · “ขาดอีก” นับจากคะแนนที่ประกาศแล้ว · เกรดที่ขีดฆ่าคือได้เต็มทุกส่วนที่เหลือก็ไม่ถึงแล้ว</p></div>
      <div class="grade-table" id="sv-grades"></div>
    </section>`;

  const $ = (s) => root.querySelector(s);

  function update() {
    const now = computeWith(d, pub);
    const fl = finishLines(d, pub);
    const anyWI = unpublished.some((it) => parseWI(it) !== null);
    const proj = computeWith(d, (it) => (it.visible ? pub(it) : parseWI(it) ?? 0));
    const announcedMax = computeWith(d, (it) => (it.visible ? Number(it.max_score) : null)).total;

    $('#sv-tiles').innerHTML = `
      <div class="tile"><span class="t-label">คะแนนที่ประกาศแล้ว</span><span class="t-val">${nf(now.total)}</span>
        <span class="t-sub">จากที่ประกาศแล้วเต็ม ${nf(announcedMax)} · ทั้งวิชา ${nf(scale)}</span></div>
      <div class="tile"><span class="t-label">สูงสุดที่ยังทำได้</span><span class="t-val">${nf(fl.max)}</span>
        <span class="t-sub">ถ้าส่วนที่เหลือได้เต็มทุกช่อง (เหลือ ${nf(fl.remaining)})</span></div>
      <div class="tile accent"><span class="t-label">เกรดคาดการณ์</span><span class="t-val">${anyWI ? esc(proj.grade) : '–'}</span>
        <span class="t-sub">${anyWI ? `คะแนนรวมคาดการณ์ ${nf(proj.total)}` : 'ลองเติมคะแนนในช่องที่ยังไม่ประกาศ'}</span></div>`;

    if (!selGrade || !fl.lines.some((l) => l.grade === selGrade && l.min > 0)) selGrade = defaultGrade(fl.lines);
    $('#sv-race').innerHTML = d.scale.length
      ? finishLineChart({ current: fl.current, max: fl.max, remaining: fl.remaining, projected: anyWI ? proj.total : null, lines: fl.lines, selected: selGrade, scale })
      : '<p class="muted">ยังไม่ได้ตั้งเกณฑ์เกรด</p>';
    $('#sv-grades').innerHTML = gradeTable(d.scale, fl.lines, selGrade);

    now.per.forEach(({ cat, capped }) => {
      const el = root.querySelector(`[data-sec="${cat.id}"]`);
      const its = d.itemsByCat.get(cat.id) || [];
      const anyPub = its.some((i) => i.visible);
      const allPub = its.every((i) => i.visible);
      const p = proj.per.find((x) => x.cat.id === cat.id);
      const pj = anyWI && !allPub ? `<span class="proj-chip">คาดการณ์ ${nf(p.capped)}</span>` : '';
      el.innerHTML = anyPub
        ? `<b>${nf(capped)}</b><span class="muted"> / ${nf(catMax(d, cat))}</span>${allPub ? '' : ' <span class="badge wait">บางส่วนยังไม่ประกาศ</span>'}${pj}`
        : `<span class="badge wait">ยังไม่ประกาศ</span>${pj}`;
    });
    $('#sv-total').innerHTML = `<b>${nf(now.total)}</b><span class="muted"> / ${nf(scale)}</span>${anyWI ? `<span class="proj-chip">คาดการณ์ ${nf(proj.total)} · ${esc(proj.grade)}</span>` : ''}`;
    unpublished.forEach((it) => {
      const el = root.querySelector(`[data-w="${it.id}"]`);
      if (!el) return;
      const cat = d.cats.find((k) => k.id === it.category_id);
      const v = parseWI(it);
      el.innerHTML = v === null ? `<span class="muted">– / ${nf(itemPct(it, cat))}%</span>`
        : `${nf((v / it.max_score) * itemPct(it, cat))} <span class="muted">/ ${nf(itemPct(it, cat))}%</span>`;
    });
  }

  root.addEventListener('input', (e) => {
    const id = e.target.dataset?.whatif;
    if (id) { whatIf[id] = e.target.value; saveWI(); update(); }
    if (e.target.id === 'qf') {
      const f = Number(e.target.value) / 100;
      $('#qf-v').textContent = `${e.target.value}%`;
      unpublished.forEach((it) => {
        whatIf[it.id] = String(r2(f * it.max_score));
        const inp = root.querySelector(`[data-whatif="${it.id}"]`);
        if (inp) inp.value = whatIf[it.id];
      });
      saveWI();
      update();
    }
  }, { signal: ac.signal });
  root.addEventListener('click', (e) => {
    if (e.target.id === 'qf-clear') {
      whatIf = {};
      saveWI();
      root.querySelectorAll('[data-whatif]').forEach((i) => (i.value = ''));
      $('#qf').value = 0;
      $('#qf-v').textContent = '–';
      return update();
    }
    const g = e.target.closest('[data-grade]');
    if (!g) return;
    selGrade = g.dataset.grade;
    update();
    if (g.closest('#sv-grades')) $('#sv-race').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, { signal: ac.signal });

  update();
  renderHwStudent(root.querySelector('#sv-hw'), { row, d, preview: !persist, onChanged });
  renderAttStudent(root.querySelector('#sv-att'), { row, d, course: c });
}

async function loadStudentCourse(row) {
  const [cats, scale] = await Promise.all([
    fetchAll(() => sb.from('categories').select('*').eq('course_id', row.course_id).order('sort').order('id')),
    fetchAll(() => sb.from('grade_scale').select('*').eq('course_id', row.course_id).order('min_percent', { ascending: false })),
  ]);
  const items = cats.length
    ? await fetchAll(() => sb.from('items').select('*').in('category_id', cats.map((c) => c.id)).order('sort').order('id'))
    : [];
  const scores = await fetchAll(() => sb.from('scores').select('item_id,student_row_id,raw_score,feedback').eq('student_row_id', row.id));
  let subs = new Map();
  try { subs = await loadSubs(items.map((i) => i.id), row.id); } catch (e) { console.warn(e); }
  const d = indexData({
    cats, items, students: [row], scale, subs,
    scores: new Map(scores.map((s) => [key(s.item_id, s.student_row_id), s.raw_score])),
    feedback: new Map(scores.filter((s) => s.feedback).map((s) => [key(s.item_id, s.student_row_id), s.feedback])),
  });
  await loadAttStudent(d, row);
  return d;
}

async function studentHome() {
  app.innerHTML = header('<span id="courseSw"></span>') + '<main id="main" class="page"><div class="center muted">กำลังโหลด…</div></main>';
  bindHeader();
  const m = app.querySelector('#main');

  const { data: rows, error } = await sb.from('students').select('*, courses(*)').eq('user_id', S.session.user.id).order('id');
  if (error) return fail(error, 'โหลดข้อมูลไม่สำเร็จ');
  if (!rows.length) {
    m.innerHTML = `<div class="card"><h2>ยังไม่พบรายชื่อของคุณในรายวิชาใด</h2>
      <p>รหัสนิสิตที่ใช้สมัคร: <b>${esc(S.profile.student_id || '-')}</b></p>
      <p class="hint">ถ้ารหัสถูกต้อง อาจารย์อาจยังไม่ได้นำเข้ารายชื่อ — แจ้งอาจารย์ผู้สอนได้</p></div>`;
    return;
  }

  const show = async (row, keepScroll = false) => {
    lsSet('stuCourse', row.course_id);
    const y = window.scrollY;
    if (!keepScroll) m.innerHTML = '<div class="center muted">กำลังโหลดคะแนน…</div>';
    try {
      const d = await loadStudentCourse(row);
      renderStudentView(m, { course: row.courses, row, d, onChanged: () => show(row, true) });
      if (keepScroll) window.scrollTo(0, y);
    } catch (e) { fail(e, 'โหลดคะแนนไม่สำเร็จ'); }
  };

  if (rows.length > 1) {
    const saved = lsGet('stuCourse');
    const cur = rows.find((r) => String(r.course_id) === saved) || rows[0];
    app.querySelector('#courseSw').innerHTML = `<select id="stuSel">${rows.map((r) =>
      `<option value="${r.id}" ${r === cur ? 'selected' : ''}>${esc(r.courses.code)} ${esc(r.courses.name)}</option>`).join('')}</select>`;
    app.querySelector('#stuSel').onchange = (e) => show(rows.find((r) => String(r.id) === e.target.value));
    show(cur);
  } else {
    show(rows[0]);
  }
}
