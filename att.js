'use strict';
/* =====================================================================
   เช็คชื่อด้วย QR
   - อาจารย์: เปิดคาบ → จอโปรเจกเตอร์แสดง QR ที่เปลี่ยนทุก rotate_sec วินาที
   - QR = ลิงก์ ?ci={session}-{ช่วงเวลา}-{token}  (token = HMAC ของรหัสลับประจำคาบ)
   - นิสิต: สแกนด้วยกล้องมือถือ → เปิดเว็บ → (login) → เรียก check_in() ที่เซิร์ฟเวอร์
   ใช้ตัวแปร/ฟังก์ชันร่วมจาก app.js
   ===================================================================== */

const ATT_LABEL = { present: 'มา', late: 'สาย', excused: 'ลา', absent: 'ขาด', pending: 'ยังไม่เช็ค' };
const ATT_SYM = { present: '✓', late: 'ส', excused: 'ล', absent: '✗', pending: '·' };
let attTimers = [];
function stopAttTimers() { attTimers.forEach((t) => clearInterval(t)); attTimers = []; }

function deviceId() {
  try {
    let id = localStorage.getItem('deviceId');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('deviceId', id); }
    return id;
  } catch { return null; }
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sessOpen = (s, now = Date.now()) => now >= new Date(s.opens_at).getTime() && now <= new Date(s.closes_at).getTime();
const shortDate = (v) => new Date(v).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
const hhmm = (v) => new Date(v).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });

function attStatus(d, sess, rowId) {
  const a = d.att.get(key(sess.id, rowId));
  if (a) return a.status;
  return sessOpen(sess) ? 'pending' : 'absent';
}

/* ---------- โหลดข้อมูล ---------- */
async function loadAttTeacher(d, courseId) {
  try {
    const sessions = await fetchAll(() => sb.from('att_sessions').select('*').eq('course_id', courseId).order('opens_at'));
    const ids = sessions.map((s) => s.id);
    const rows = ids.length ? await fetchAll(() => sb.from('attendance').select('*').in('session_id', ids)) : [];
    d.attSessions = sessions;
    d.att = new Map(rows.map((r) => [key(r.session_id, r.student_row_id), r]));
    d.attReady = true;
  } catch (e) {
    console.warn('attendance ยังไม่พร้อม (รัน 06_attendance.sql)', e);
    d.attSessions = []; d.att = new Map(); d.attReady = false;
  }
}

async function loadAttStudent(d, row) {
  try {
    const sessions = await fetchAll(() => sb.from('att_sessions').select('id,course_id,title,opens_at,closes_at,late_after').eq('course_id', row.course_id).order('opens_at'));
    const rows = await fetchAll(() => sb.from('attendance').select('*').eq('student_row_id', row.id));
    d.attSessions = sessions;
    d.att = new Map(rows.map((r) => [key(r.session_id, r.student_row_id), r]));
    d.attReady = true;
  } catch (e) {
    d.attSessions = []; d.att = new Map(); d.attReady = false;
  }
}

function attCounts(d, rowId) {
  const c = { present: 0, late: 0, excused: 0, absent: 0, pending: 0, total: 0 };
  d.attSessions.forEach((s) => {
    const st = attStatus(d, s, rowId);
    c[st]++;
    if (st !== 'pending') c.total++;
  });
  return c;
}

/* =====================================================================
   ฝั่งอาจารย์: แท็บ "เช็คชื่อ"
   ===================================================================== */
function tabAttendance(m) {
  stopAttTimers();
  const d = S.d;
  if (!d.attReady) {
    m.innerHTML = '<div class="empty">ยังไม่ได้ติดตั้งระบบเช็คชื่อ — รันไฟล์ <b>06_attendance.sql</b> ใน Supabase SQL Editor ก่อน แล้วรีเฟรชหน้านี้</div>';
    return;
  }
  const v = S.attView;
  const sess = v && d.attSessions.find((s) => s.id === v.id);
  if (sess && v.mode === 'qr') return attQr(m, sess);
  if (sess && v.mode === 'detail') return attDetail(m, sess);
  S.attView = null;
  attList(m);
}

// การตั้งค่าเช็คชื่อของรายวิชา (เก็บในตาราง courses — ต้องรัน 08_attendance_settings.sql)
function attCfgOf(c, d) {
  const cat = d.cats.find((k) => /เข้า|attend/i.test(k.name));
  const auto = (cat && (d.itemsByCat.get(cat.id) || [])[0]) || d.items.find((i) => /เข้า|attend/i.test(i.title));
  const itemId = c?.att_item_id && d.itemById.get(c.att_item_id) ? c.att_item_id : auto?.id ?? null;
  return {
    itemId,
    lateW: c?.att_late_weight != null ? Number(c.att_late_weight) : 0.5,
    warn: c?.att_warn_absent != null ? Number(c.att_warn_absent) : 5,
    saved: c ? 'att_late_weight' in c : false,
  };
}
function defaultAttCfg(d) {
  const cfg = S.attCfg?.[S.courseId];
  if (cfg && d.itemById.get(cfg.itemId)) return cfg;
  return attCfgOf(course(), d);
}

function attScore(d, rowId, cfg) {
  const it = d.itemById.get(cfg.itemId);
  if (!it) return null;
  const c = attCounts(d, rowId);
  if (!c.total) return null;
  // มา/ลา = 1 คาบ · สาย = lateW คาบ · ขาด = 0 (เกณฑ์ขาดใช้แจ้งเตือนเท่านั้น ไม่เกี่ยวกับคะแนน)
  const attended = c.present + c.excused + c.late * cfg.lateW;
  return r2((Number(it.max_score) * attended) / c.total);
}

function attList(m) {
  const d = S.d;
  const N = d.students.length;
  const sessions = [...d.attSessions].reverse();
  const cfg = defaultAttCfg(d);
  S.attCfg = { ...(S.attCfg || {}), [S.courseId]: cfg };
  const closed = d.attSessions.filter((s) => !sessOpen(s));
  const counted = d.students.map((st) => ({ st, c: attCounts(d, st.id) }));
  const warnList = cfg.warn > 0 ? counted.filter((x) => x.c.absent >= cfg.warn) : [];
  const nearList = cfg.warn > 1 ? counted.filter((x) => x.c.absent === cfg.warn - 1) : [];
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const sessRow = (s) => {
    let p = 0, l = 0, e = 0, f = 0;
    d.students.forEach((st) => {
      const a = d.att.get(key(s.id, st.id));
      if (a?.status === 'present') p++;
      if (a?.status === 'late') l++;
      if (a?.status === 'excused') e++;
      if (a?.flagged) f++;
    });
    const open = sessOpen(s);
    return `<tr>
      <td class="nowrap">${shortDate(s.opens_at)} <span class="muted sm">${hhmm(s.opens_at)}–${hhmm(s.closes_at)}</span></td>
      <td>${esc(s.title)}</td>
      <td>${open ? '<span class="badge hot">กำลังเปิด</span>' : '<span class="badge">ปิดแล้ว</span>'}</td>
      <td class="n">${p}</td><td class="n">${l}</td><td class="n">${e}</td><td class="n">${open ? '–' : N - p - l - e}</td>
      <td class="n">${f ? `<span class="badge bad">⚑ ${f}</span>` : ''}</td>
      <td class="nowrap">${open ? `<button class="btn primary sm" data-qr="${s.id}">แสดง QR</button>` : ''}
        <button class="btn sm" data-detail="${s.id}">รายชื่อ</button>
        <button class="btn danger sm" data-delsess="${s.id}" title="ลบคาบนี้">ลบ</button></td>
    </tr>`;
  };

  const matrix = d.attSessions.length ? `
    <div class="card">
      <div class="card-head"><h2>สรุปการเข้าเรียน → คะแนน</h2>
        <p class="muted">✓ มา · ส สาย · ล ลา · ✗ ขาด — แก้สถานะรายคนได้ที่ปุ่ม “รายชื่อ” ของแต่ละคาบ</p></div>
      <div class="toolbar">
        <label class="inl">ใส่คะแนนลงรายการ
          <select id="attItem">${d.cats.map((c) => `<optgroup label="${esc(c.name)}">${(d.itemsByCat.get(c.id) || []).map((it) =>
            `<option value="${it.id}" ${it.id === cfg.itemId ? 'selected' : ''}>${esc(it.title)} (/${num(it.max_score)})</option>`).join('')}</optgroup>`).join('')}</select></label>
        <label class="inl">สาย 1 ครั้ง ได้ <input id="attLateW" class="tiny" value="${cfg.lateW}" inputmode="decimal"> คาบ</label>
        <label class="inl">แจ้งเตือนเมื่อขาดครบ <input id="attWarn" class="tiny" value="${cfg.warn}" inputmode="numeric"> ครั้ง</label>
        <button class="btn primary" id="attSave">บันทึกลงคะแนน</button>
      </div>
      <p class="hint">สูตร: คะแนน = คะแนนเต็ม × (มา + ลา + สาย×${cfg.lateW}) ÷ จำนวนคาบที่ปิดแล้ว (${closed.length} คาบ)
        → ขาด 1 คาบ เสีย 1 คาบ · สาย 1 คาบ เสีย ${r2(1 - cfg.lateW)} คาบ ·
        เกณฑ์ขาด ${cfg.warn} ครั้งใช้<b>แจ้งเตือนเท่านั้น</b> ไม่มีผลกับคะแนน</p>
      ${warnList.length ? `<div class="m-alert bad">⚠ ขาดครบ ${cfg.warn} ครั้งแล้ว ${warnList.length} คน: ${warnList.map((x) => esc(x.st.nickname || x.st.full_name) + ` (${x.c.absent})`).join(', ')}</div>` : ''}
      ${nearList.length ? `<div class="m-alert">ใกล้ถึงเกณฑ์ (ขาด ${cfg.warn - 1} ครั้ง) ${nearList.length} คน: ${nearList.map((x) => esc(x.st.nickname || x.st.full_name)).join(', ')}</div>` : ''}
      ${cfg.saved ? '' : '<p class="hint warnt">การตั้งค่านี้ยังไม่ถูกบันทึกกับรายวิชา — รัน 08_attendance_settings.sql แล้วนิสิตจะเห็นคำเตือนการขาดด้วย</p>'}
      <div class="tablewrap attwrap"><table class="mini attm">
        <thead><tr><th>รหัส</th><th>ชื่อ</th>${d.attSessions.map((s) => `<th class="ctr" title="${esc(s.title)}">${shortDate(s.opens_at)}</th>`).join('')}
          <th class="n">มา</th><th class="n">สาย</th><th class="n">ลา</th><th class="n">ขาด</th><th class="n">คะแนนใหม่</th><th class="n">ในระบบ</th></tr></thead>
        <tbody>${d.students.map((st) => {
          const c = attCounts(d, st.id);
          const sc = attScore(d, st.id, cfg);
          const cur = cfg.itemId ? d.scores.get(key(cfg.itemId, st.id)) ?? null : null;
          return `<tr><td>${esc(st.student_id)}</td><td class="nowrap">${esc(st.full_name)}${st.nickname ? ` <span class="nick">(${esc(st.nickname)})</span>` : ''}</td>
            ${d.attSessions.map((s) => { const k = attStatus(d, s, st.id); const a = d.att.get(key(s.id, st.id));
              return `<td class="ctr att-${k}">${ATT_SYM[k]}${a?.flagged ? '<sup>⚑</sup>' : ''}</td>`; }).join('')}
            <td class="n">${c.present}</td><td class="n">${c.late}</td><td class="n">${c.excused}</td><td class="n ${cfg.warn > 0 && c.absent >= cfg.warn ? 'absbad' : cfg.warn > 1 && c.absent === cfg.warn - 1 ? 'warnt' : ''}">${c.absent}${cfg.warn > 0 && c.absent >= cfg.warn ? ' ⚠' : ''}</td>
            <td class="n"><b>${sc ?? '–'}</b></td><td class="n muted">${cur ?? '–'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>` : '';

  m.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-head row">
        <div><h2>เช็คชื่อด้วย QR</h2>
          <p class="muted">กด “เปิดเช็คชื่อ” แล้วแสดงจอนี้บนโปรเจกเตอร์ · QR เปลี่ยนทุกไม่กี่วินาที ถ่ายรูปส่งต่อใช้ไม่ได้ ·
            นิสิตสแกนด้วยกล้องมือถือ (ต้อง login บัญชีตัวเองไว้ก่อนจะเร็วที่สุด)</p></div>
        <button class="btn primary" id="attNew">＋ เปิดเช็คชื่อคาบใหม่</button>
      </div>
      ${local ? '<div class="m-alert">⚠ เว็บยังเปิดจาก localhost — มือถือนิสิตจะเปิดลิงก์ใน QR ไม่ได้ ต้องนำเว็บขึ้นออนไลน์ก่อนใช้จริง (ทดสอบบนเครื่องนี้ได้)</div>' : ''}
    </div>
    <div class="card">
      <div class="tablewrap"><table class="mini">
        <thead><tr><th>วันที่</th><th>คาบ</th><th>สถานะ</th><th class="n">มา</th><th class="n">สาย</th><th class="n">ลา</th><th class="n">ขาด</th><th class="n">ติดธง</th><th></th></tr></thead>
        <tbody>${sessions.map(sessRow).join('') || '<tr><td colspan="9" class="muted">ยังไม่เคยเปิดเช็คชื่อ</td></tr>'}</tbody>
      </table></div>
    </div>
    ${matrix}
  </div>`;

  m.querySelector('#attNew').onclick = attNewSession;
  m.querySelectorAll('[data-qr]').forEach((b) => (b.onclick = () => { S.attView = { mode: 'qr', id: Number(b.dataset.qr) }; renderTab(); }));
  m.querySelectorAll('[data-detail]').forEach((b) => (b.onclick = () => { S.attView = { mode: 'detail', id: Number(b.dataset.detail) }; renderTab(); }));
  m.querySelectorAll('[data-delsess]').forEach((b) => (b.onclick = () => attDeleteSession(d.attSessions.find((s) => s.id === Number(b.dataset.delsess)))));

  if (d.attSessions.length) {
    const upd = async () => {
      const lw = Number(m.querySelector('#attLateW').value.replace(',', '.'));
      const next = {
        itemId: Number(m.querySelector('#attItem').value),
        lateW: Number.isFinite(lw) ? Math.min(1, Math.max(0, lw)) : 0.5,
        warn: Math.max(0, parseInt(m.querySelector('#attWarn').value, 10) || 0),
        saved: cfg.saved,
      };
      S.attCfg[S.courseId] = next;
      if (cfg.saved) {
        const patch = { att_item_id: next.itemId || null, att_late_weight: next.lateW, att_warn_absent: next.warn };
        const { error } = await sb.from('courses').update(patch).eq('id', S.courseId);
        if (error) fail(error, 'บันทึกการตั้งค่าไม่สำเร็จ');
        else Object.assign(course(), patch);
      }
      attList(m);
    };
    m.querySelector('#attItem').onchange = upd;
    m.querySelector('#attWarn').onchange = upd;
    m.querySelector('#attLateW').onchange = upd;
    m.querySelector('#attSave').onclick = async () => {
      const c = S.attCfg[S.courseId];
      const it = d.itemById.get(c.itemId);
      const rows = d.students.map((st) => ({ st, v: attScore(d, st.id, c) })).filter((x) => x.v !== null);
      if (!it || !rows.length) return toast('ยังไม่มีคาบที่ปิดแล้ว', 'err');
      if (!(await uiConfirm('บันทึกคะแนนเข้าเรียน', `ใส่คะแนนรายการ “${it.title}” ให้นิสิต ${rows.length} คน ตามสูตรด้านบน (แทนค่าเดิม)`, 'บันทึก', false))) return;
      const now = new Date().toISOString();
      const { error } = await sb.from('scores').upsert(rows.map((x) => ({ item_id: it.id, student_row_id: x.st.id, raw_score: x.v, updated_at: now })), { onConflict: 'item_id,student_row_id' });
      if (error) return fail(error, 'บันทึกไม่สำเร็จ');
      rows.forEach((x) => d.scores.set(key(it.id, x.st.id), x.v));
      toast(`บันทึกคะแนนเข้าเรียน ${rows.length} คนแล้ว`);
      attList(m);
    };
  }
}

// ลบคาบเช็คชื่อ (ลบสถานะ มา/สาย/ลา ของคาบนั้นด้วย — คะแนนที่บันทึกลงรายการแล้วไม่เปลี่ยน)
async function attDeleteSession(sess) {
  if (!sess) return;
  const d = S.d;
  let n = 0;
  d.students.forEach((st) => { if (d.att.get(key(sess.id, st.id))) n++; });
  const msg = `ลบ “${sess.title}” (${shortDate(sess.opens_at)} ${hhmm(sess.opens_at)}) และข้อมูลการเช็คชื่อ ${n} คนของคาบนี้\n`
    + `${sessOpen(sess) ? 'คาบนี้ยังเปิดอยู่ — QR ที่แสดงอยู่จะใช้ไม่ได้ทันที\n' : ''}`
    + 'คะแนนเข้าเรียนที่เคย “บันทึกลงคะแนน” ไว้แล้วจะไม่เปลี่ยน — กดบันทึกใหม่ถ้าต้องการคำนวณใหม่\nย้อนกลับไม่ได้';
  if (!(await uiConfirm('ลบคาบเช็คชื่อ', msg, 'ลบคาบ'))) return;
  const { error } = await sb.from('att_sessions').delete().eq('id', sess.id);
  if (error) return fail(error, 'ลบไม่สำเร็จ');
  d.attSessions = d.attSessions.filter((s) => s.id !== sess.id);
  [...d.att.keys()].forEach((k) => { if (k.startsWith(sess.id + ':')) d.att.delete(k); });
  S.attView = null;
  toast(`ลบ “${sess.title}” แล้ว`);
  renderTab();
}

async function attNewSession() {
  const d = S.d;
  const n = d.attSessions.length + 1;
  const v = await openForm({
    title: 'เปิดเช็คชื่อคาบใหม่', okText: 'เปิดเช็คชื่อ',
    message: 'เริ่มนับเวลาทันทีที่กด “เปิดเช็คชื่อ”',
    fields: [
      { label: 'ชื่อคาบ', value: `คาบที่ ${n} · ${shortDate(new Date())}`, required: true },
      { label: 'เปิดให้เช็คชื่อนาน (นาที)', value: '15', numeric: true, required: true },
      { label: 'หลังจากกี่นาทีนับเป็น “สาย” (เว้นว่าง = ไม่นับสาย)', value: '10', numeric: true },
      { label: 'QR เปลี่ยนทุก (วินาที)', value: '10', numeric: true, required: true },
    ],
  });
  if (!v) return;
  const dur = Number(v[1]);
  const late = v[2] === '' ? null : Number(v[2]);
  const rot = Math.round(Number(v[3]));
  if (!(dur > 0 && dur <= 600)) return toast('เวลาเปิดต้องอยู่ระหว่าง 1–600 นาที', 'err');
  if (!(rot >= 5 && rot <= 60)) return toast('QR เปลี่ยนทุก 5–60 วินาที', 'err');
  if (late !== null && !(late >= 0 && late <= dur)) return toast('เวลานับสายต้องไม่เกินเวลาเปิด', 'err');
  try {
    const { data: srv } = await sb.rpc('server_now');
    const t0 = srv ? new Date(srv) : new Date();
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const { data: s, error } = await sb.from('att_sessions').insert({
      course_id: S.courseId, title: v[0].trim(), opens_at: t0.toISOString(),
      closes_at: new Date(t0.getTime() + dur * 60000).toISOString(),
      late_after: late === null ? null : new Date(t0.getTime() + late * 60000).toISOString(),
      rotate_sec: rot,
    }).select().single();
    if (error) throw error;
    const { error: e2 } = await sb.from('att_secrets').insert({ session_id: s.id, secret });
    if (e2) throw e2;
    d.attSessions.push(s);
    S.attView = { mode: 'qr', id: s.id };
    renderTab();
  } catch (e) { fail(e, 'เปิดเช็คชื่อไม่สำเร็จ'); }
}

/* ---------- จอแสดง QR (โปรเจกเตอร์) ---------- */
async function attQr(m, sess) {
  const d = S.d;
  const N = d.students.length;
  m.innerHTML = `<div class="qrpage" id="qrPage">
    <div class="qrtop">
      <button class="btn sm" id="qrBack">← กลับ</button>
      <h2>${esc(sess.title)}</h2>
      <span class="spacer"></span>
      <button class="btn sm" id="qrFull">⛶ เต็มจอ</button>
    </div>
    <div class="qrmain">
      <div class="qrbox"><div id="qr"></div><div class="qrbar"><span id="qrBar"></span></div>
        <p class="qrhint">สแกนด้วยกล้องมือถือ · QR เปลี่ยนทุก ${sess.rotate_sec} วินาที</p></div>
      <div class="qrside">
        <div class="qrcount"><b id="qrN">0</b><span> / ${N}</span><div>เช็คชื่อแล้ว</div></div>
        <div class="qrclock" id="qrClock"></div>
        <div class="qrlate" id="qrLate"></div>
        <div class="qrbtns">
          <button class="btn" id="qrPlus">＋5 นาที</button>
          <button class="btn danger" id="qrClose">ปิดเช็คชื่อ</button>
          <button class="btn" id="qrRandBtn">🎲 สุ่มเรียกชื่อ</button>
          <button class="btn" id="qrList">รายชื่อ</button>
        </div>
        <div id="qrRand"></div>
        <ol class="qrrecent" id="qrRecent"></ol>
      </div>
    </div>
  </div>`;
  const $ = (s) => m.querySelector(s);
  $('#qrBack').onclick = () => { S.attView = null; renderTab(); };
  $('#qrList').onclick = () => { S.attView = { mode: 'detail', id: sess.id }; renderTab(); };
  $('#qrFull').onclick = () => { const p = $('#qrPage'); document.fullscreenElement ? document.exitFullscreen() : p.requestFullscreen?.(); };

  // รหัสลับ + นาฬิกาเซิร์ฟเวอร์
  let secret = null;
  let offset = 0;
  try {
    const t1 = Date.now();
    const [{ data: sec, error }, { data: srv }] = await Promise.all([
      sb.from('att_secrets').select('secret').eq('session_id', sess.id).single(),
      sb.rpc('server_now'),
    ]);
    if (error) throw error;
    secret = sec.secret;
    if (srv) offset = new Date(srv).getTime() - (t1 + Date.now()) / 2;
  } catch (e) { return fail(e, 'โหลดข้อมูลคาบไม่สำเร็จ'); }

  const qrEl = $('#qr');
  const qr = new QRCode(qrEl, { text: 'x', width: 640, height: 640, correctLevel: QRCode.CorrectLevel.M });
  let lastWin = null;
  const base = location.origin + location.pathname;

  const tick = async () => {
    if (!m.isConnected) return stopAttTimers();
    const now = Date.now() + offset;
    const close = new Date(sess.closes_at).getTime();
    const left = close - now;
    if (left <= 0) {
      qrEl.classList.add('off');
      $('#qrClock').innerHTML = '<span class="closed">ปิดเช็คชื่อแล้ว</span>';
      $('#qrBar').style.width = '0%';
      $('#qrLate').textContent = '';
      return;
    }
    qrEl.classList.remove('off');
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    $('#qrClock').innerHTML = `ปิดใน <b>${mm}:${String(ss).padStart(2, '0')}</b>`;
    const lateAt = sess.late_after ? new Date(sess.late_after).getTime() : null;
    $('#qrLate').innerHTML = lateAt === null ? '' : now < lateAt
      ? `นับสายใน ${Math.ceil((lateAt - now) / 60000)} นาที` : '<span class="warnt">ตอนนี้นับเป็น “สาย”</span>';
    const rot = sess.rotate_sec * 1000;
    const win = Math.floor(now / rot);
    $('#qrBar').style.width = `${100 - ((now % rot) / rot) * 100}%`;
    if (win !== lastWin) {
      lastWin = win;
      const tok = (await hmacHex(secret, `${sess.id}:${win}`)).slice(0, 12);
      qr.makeCode(`${base}?ci=${sess.id}-${win}-${tok}`);
    }
  };

  const poll = async () => {
    if (!m.isConnected) return stopAttTimers();
    const { data, error } = await sb.from('attendance').select('*').eq('session_id', sess.id);
    if (error) return;
    data.forEach((r) => d.att.set(key(r.session_id, r.student_row_id), r));
    const sorted = data.filter((r) => r.scanned_at).sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));
    $('#qrN').textContent = data.filter((r) => r.status !== 'excused').length;
    $('#qrRecent').innerHTML = sorted.slice(0, 12).map((r) => {
      const st = d.students.find((x) => x.id === r.student_row_id);
      return `<li class="${r.status}">${esc(st?.nickname || st?.full_name || '')}${r.status === 'late' ? ' <span class="badge wait">สาย</span>' : ''}${r.flagged ? ' <span class="badge bad">⚑</span>' : ''}<span class="muted sm"> ${hhmm(r.scanned_at)}</span></li>`;
    }).join('');
  };

  $('#qrPlus').onclick = async () => {
    const base0 = Math.max(Date.now() + offset, new Date(sess.closes_at).getTime());
    const closes = new Date(base0 + 5 * 60000).toISOString();
    const { error } = await sb.from('att_sessions').update({ closes_at: closes }).eq('id', sess.id);
    if (error) return fail(error, 'ขยายเวลาไม่สำเร็จ');
    sess.closes_at = closes;
    toast('ขยายเวลาอีก 5 นาที');
  };
  $('#qrClose').onclick = async () => {
    if (!(await uiConfirm('ปิดเช็คชื่อ', 'ปิดเช็คชื่อคาบนี้ตอนนี้ — คนที่ยังไม่เช็คจะนับเป็นขาด (แก้รายคนได้ภายหลัง)', 'ปิดเช็คชื่อ'))) return;
    const closes = new Date(Date.now() + offset).toISOString();
    const { error } = await sb.from('att_sessions').update({ closes_at: closes }).eq('id', sess.id);
    if (error) return fail(error, 'ปิดไม่สำเร็จ');
    sess.closes_at = closes;
    S.attView = { mode: 'detail', id: sess.id };
    renderTab();
  };
  $('#qrRandBtn').onclick = () => {
    const here = d.students.filter((st) => ['present', 'late'].includes(d.att.get(key(sess.id, st.id))?.status));
    if (!here.length) return toast('ยังไม่มีใครเช็คชื่อ', 'err');
    const pick = [...here].sort(() => Math.random() - 0.5).slice(0, 3);
    $('#qrRand').innerHTML = `<div class="qrrand">🎲 ${pick.map((st) => `<b>${esc(st.nickname || st.full_name)}</b> <span class="muted sm">${esc(st.student_id.slice(-4))}</span>`).join(' · ')}</div>`;
  };

  await tick();
  await poll();
  attTimers.push(setInterval(tick, 500), setInterval(poll, 3000));
}

/* ---------- รายชื่อในคาบ (แก้สถานะรายคน) ---------- */
function attDetail(m, sess) {
  const d = S.d;
  const open = sessOpen(sess);
  const opts = (cur) => ['absent', 'present', 'late', 'excused'].map((k) =>
    `<option value="${k}" ${cur === k ? 'selected' : ''}>${ATT_LABEL[k]}</option>`).join('');
  const counts = { present: 0, late: 0, excused: 0, absent: 0, pending: 0 };
  d.students.forEach((st) => counts[attStatus(d, sess, st.id)]++);

  m.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-head row">
        <div><button class="btn ghost sm" id="adBack">← คาบทั้งหมด</button>
          <h2>${esc(sess.title)}</h2>
          <p class="muted">${shortDate(sess.opens_at)} ${hhmm(sess.opens_at)}–${hhmm(sess.closes_at)}${sess.late_after ? ` · สายหลัง ${hhmm(sess.late_after)}` : ''}
            · มา ${counts.present} · สาย ${counts.late} · ลา ${counts.excused} · ${open ? `ยังไม่เช็ค ${counts.pending}` : `ขาด ${counts.absent}`}</p></div>
        <div class="hwbtns">
          ${open ? '<button class="btn primary sm" id="adQr">แสดง QR</button>' : '<button class="btn sm" id="adReopen">เปิดเช็คชื่ออีก 5 นาที</button>'}
          <button class="btn danger sm" id="adDel">ลบคาบนี้</button>
        </div>
      </div>
    </div>
    <div class="card"><div class="tablewrap"><table class="mini">
      <thead><tr><th>รหัสนิสิต</th><th>ชื่อ-สกุล</th><th>สถานะ</th><th>เวลาสแกน</th><th>หมายเหตุ</th></tr></thead>
      <tbody>${d.students.map((st) => {
        const a = d.att.get(key(sess.id, st.id));
        const cur = a?.status || 'absent';
        return `<tr class="${a?.flagged ? 'flagrow' : ''}">
          <td>${esc(st.student_id)}</td>
          <td>${esc(st.full_name)}${st.nickname ? ` <span class="nick">(${esc(st.nickname)})</span>` : ''}</td>
          <td><select class="attsel att-${cur}" data-s="${st.id}">${opts(cur)}</select></td>
          <td class="muted sm">${a?.scanned_at ? hhmm(a.scanned_at) : ''}</td>
          <td class="sm">${a?.flagged ? `<span class="badge bad">⚑ ${esc(a.note || 'ติดธง')}</span>` : esc(a?.note || '')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="hint">⚑ = เครื่องเดียวกันเช็คชื่อให้หลายบัญชีในคาบนี้ — ควรตรวจสอบ · เปลี่ยนสถานะได้ทันที (บันทึกอัตโนมัติ)</p></div>
  </div>`;

  m.querySelector('#adBack').onclick = () => { S.attView = null; renderTab(); };
  m.querySelector('#adQr')?.addEventListener('click', () => { S.attView = { mode: 'qr', id: sess.id }; renderTab(); });
  m.querySelector('#adReopen')?.addEventListener('click', async () => {
    const closes = new Date(Date.now() + 5 * 60000).toISOString();
    const { error } = await sb.from('att_sessions').update({ closes_at: closes }).eq('id', sess.id);
    if (error) return fail(error, 'เปิดไม่สำเร็จ');
    sess.closes_at = closes;
    S.attView = { mode: 'qr', id: sess.id };
    renderTab();
  });
  m.querySelector('#adDel').onclick = () => attDeleteSession(sess);
  m.querySelectorAll('.attsel').forEach((el) => (el.onchange = async () => {
    const sid = Number(el.dataset.s);
    const k = key(sess.id, sid);
    const prev = d.att.get(k);
    let error;
    if (el.value === 'absent') {
      ({ error } = await sb.from('attendance').delete().eq('session_id', sess.id).eq('student_row_id', sid));
      if (!error) d.att.delete(k);
    } else {
      const row = { session_id: sess.id, student_row_id: sid, status: el.value, scanned_at: prev?.scanned_at ?? null,
        note: prev?.note ?? (prev ? null : 'อาจารย์บันทึกเอง') };
      ({ error } = await sb.from('attendance').upsert(row, { onConflict: 'session_id,student_row_id' }));
      if (!error) d.att.set(k, { ...(prev || {}), ...row });
    }
    if (error) { el.value = prev?.status || 'absent'; return fail(error, 'บันทึกไม่สำเร็จ'); }
    el.className = `attsel att-${el.value}`;
    toast(`บันทึก: ${ATT_LABEL[el.value]}`);
  }));
}

/* =====================================================================
   ฝั่งนิสิต
   ===================================================================== */
// หน้าผลการเช็คชื่อหลังสแกน QR
async function checkInScreen(code) {
  app.innerHTML = header() + '<main class="page"><div class="card cicard"><div class="center muted">กำลังเช็คชื่อ…</div></div></main>';
  bindHeader();
  const box = app.querySelector('.cicard');
  const { data, error } = await sb.rpc('check_in', { p_code: code, p_device: deviceId() });
  const r = error ? { ok: false, error: error.message } : data;
  box.innerHTML = r.ok
    ? `<div class="ci ok ${r.status}">
        <div class="ciicon">${r.status === 'late' ? '⏰' : '✓'}</div>
        <h1>${r.already ? 'เช็คชื่อไว้แล้ว' : 'เช็คชื่อสำเร็จ'}</h1>
        <p class="ciname">${esc(r.name)}</p>
        <p>${esc(r.title)} · ${r.status === 'late' ? '<b class="warnt">สาย</b>' : r.status === 'excused' ? 'ลา' : '<b class="okt">ตรงเวลา</b>'} · ${hhmm(r.scanned_at)} น.</p>
      </div>`
    : `<div class="ci err">
        <div class="ciicon">✗</div>
        <h1>เช็คชื่อไม่สำเร็จ</h1>
        <p class="ciname">${esc(r.error)}</p>
        <p class="muted">ถ้า QR หมดอายุ ให้สแกน QR บนจออีกครั้ง</p>
      </div>`;
  box.insertAdjacentHTML('beforeend', '<div class="center"><button class="btn primary" id="toHome">ไปหน้าคะแนนของฉัน</button></div>');
  box.querySelector('#toHome').onclick = () => boot();
}

// ประวัติการเข้าเรียนในหน้านิสิต
function renderAttStudent(box, { row, d, course: c0 }) {
  if (!box || !d.attReady || !d.attSessions?.length) { if (box) box.innerHTML = ''; return; }
  const c = attCounts(d, row.id);
  const warn = c0?.att_warn_absent != null ? Number(c0.att_warn_absent) : 0; // 0 = ไม่แจ้งเตือน
  const alert = warn > 0 && c.absent >= warn
    ? `<div class="m-alert bad">⚠ ขาดเรียนแล้ว <b>${c.absent}</b> ครั้ง ครบเกณฑ์แจ้งเตือน ${warn} ครั้ง — กรุณาติดต่ออาจารย์ผู้สอน</div>`
    : warn > 1 && c.absent === warn - 1
      ? `<div class="m-alert">ขาดเรียนแล้ว ${c.absent} ครั้ง — อีก 1 ครั้งจะครบเกณฑ์แจ้งเตือน (${warn} ครั้ง)</div>` : '';
  const list = [...d.attSessions].reverse();
  box.innerHTML = `<section class="card">
    <div class="card-head"><h2>การเข้าเรียน</h2>
      <p class="muted">มา <b>${c.present}</b> · สาย <b>${c.late}</b> · ลา <b>${c.excused}</b> · ขาด <b class="${c.absent ? 'warnt' : ''}">${c.absent}</b> จาก ${c.total} คาบ</p></div>
    ${alert}
    <div class="attchips">${list.map((s) => {
      const k = attStatus(d, s, row.id);
      const a = d.att.get(key(s.id, row.id));
      return `<div class="attchip att-${k}" title="${esc(s.title)}">
        <span class="as">${ATT_SYM[k]}</span><span><b>${shortDate(s.opens_at)}</b> ${ATT_LABEL[k]}${a?.scanned_at ? ` <span class="muted sm">${hhmm(a.scanned_at)}</span>` : ''}</span></div>`;
    }).join('')}</div>
  </section>`;
}
