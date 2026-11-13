'use strict';
/* =====================================================================
   การบ้าน: สั่งงาน · ส่งงาน · ดาวน์โหลดทั้งหมด · ส่งไฟล์ตรวจกลับ (แทนที่ไฟล์เดิม)
   ใช้ตัวแปร/ฟังก์ชันร่วมจาก app.js (sb, S, esc, nf, toast, fail, key, …)
   ไฟล์งานอยู่ที่ Storage bucket "submissions":
     {item_id}/assignment/file.ext         ไฟล์โจทย์
     {item_id}/{student_row_id}/submission.ext   ไฟล์ที่นิสิตส่ง / ไฟล์ตรวจแล้ว (แทนที่)
   ===================================================================== */

const BUCKET = 'submissions';
const QUOTA_MB = Number(window.APP_CONFIG.STORAGE_QUOTA_MB || 1024);
const FILE_LIMIT_MB = 50; // แผนฟรีของ Supabase: ไฟล์ละไม่เกิน 50 MB

const FILE_TYPES = {
  pdf:   { label: 'PDF', exts: ['pdf'], accept: '.pdf,application/pdf' },
  image: { label: 'รูปถ่าย (รวมเป็น PDF ให้)', exts: ['jpg', 'jpeg', 'png', 'webp'], accept: 'image/*' },
  excel: { label: 'Excel / CSV', exts: ['xlsx', 'xls', 'csv'], accept: '.xlsx,.xls,.csv' },
  ipynb: { label: 'Jupyter Notebook', exts: ['ipynb'], accept: '.ipynb' },
  word:  { label: 'Word', exts: ['docx', 'doc'], accept: '.docx,.doc' },
  zip:   { label: 'ZIP', exts: ['zip'], accept: '.zip' },
};

const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const fmtSize = (b) => (b == null ? '-' : b < 1048576 ? `${nf(b / 1024, 0)} KB` : `${nf(b / 1048576, 1)} MB`);
const isAssignment = (it) => !!(it.accept_files || it.due_at || it.description || it.attachment_path || it.link_url);
const allowedSet = (it) => new Set(String(it.file_types || 'pdf').split(',').map((s) => s.trim()).filter(Boolean));
const closeTime = (it) => it.close_at || it.due_at;
const isOpen = (it) => !!it.accept_files && (!closeTime(it) || Date.now() <= new Date(closeTime(it)).getTime());
const subOf = (d, itemId, rowId) => d.subs?.get(key(itemId, rowId));
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
const typesLabel = (it) => [...allowedSet(it)].map((k) => FILE_TYPES[k]?.label.replace(/ \(.*\)/, '')).filter(Boolean).join(' / ');

async function loadSubs(itemIds, rowId) {
  if (!itemIds.length) return new Map();
  const rows = await fetchAll(() => {
    let q = sb.from('submissions').select('*').in('item_id', itemIds);
    if (rowId) q = q.eq('student_row_id', rowId);
    return q;
  });
  return new Map(rows.map((r) => [key(r.item_id, r.student_row_id), r]));
}

// เปิดไฟล์ในแท็บใหม่ (เปิดแท็บก่อน แล้วค่อยใส่ลิงก์ — กันเบราว์เซอร์บล็อกป๊อปอัป)
async function openStored(path, downloadName) {
  const w = window.open('', '_blank');
  try {
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
    if (error) throw error;
    if (w) { w.opener = null; w.location.href = data.signedUrl; } else location.href = data.signedUrl;
  } catch (e) {
    w?.close();
    fail(e, 'เปิดไฟล์ไม่สำเร็จ');
  }
}

async function uploadTo(path, blob, oldPath) {
  if (oldPath && oldPath !== path) await sb.storage.from(BUCKET).remove([oldPath]);
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    upsert: true, cacheControl: '0', contentType: blob.type || 'application/octet-stream',
  });
  if (error) throw error;
}

/* ---------- พื้นที่เก็บไฟล์ ---------- */
async function storageUsage() {
  const { data, error } = await sb.rpc('storage_usage');
  if (error) throw error;
  const r = (data || []).find((x) => x.bucket === BUCKET);
  return { bytes: Number(r?.bytes || 0), files: Number(r?.files || 0) };
}

function meterHtml(usedBytes, extraBytes = 0) {
  const used = usedBytes / 1048576;
  const extra = extraBytes / 1048576;
  const pU = Math.min(100, (used / QUOTA_MB) * 100);
  const pE = Math.max(0, Math.min(100 - pU, (extra / QUOTA_MB) * 100));
  const after = used + extra;
  const lvl = after > QUOTA_MB ? 'bad' : after > QUOTA_MB * 0.8 ? 'warn' : 'ok';
  return `<div class="meter ${lvl}">
    <div class="meter-bar"><span class="m-used" style="width:${pU}%"></span><span class="m-extra" style="left:${pU}%;width:${pE}%"></span></div>
    <div class="meter-txt">ใช้ไปแล้ว <b>${nf(used, 1)} MB</b> จาก ${nf(QUOTA_MB, 0)} MB (เหลือ ${nf(Math.max(0, QUOTA_MB - used), 0)} MB)
      ${extra ? ` · งานนี้อาจใช้เพิ่มสูงสุด <b>${nf(extra, 1)} MB</b>` : ''}</div>
    ${lvl === 'bad' ? '<div class="m-alert bad">⚠ อาจเกินพื้นที่ฟรี — ลดขนาดไฟล์สูงสุดต่อคน หรือลบไฟล์ของงานเก่าที่ตรวจเสร็จแล้ว</div>'
      : lvl === 'warn' ? '<div class="m-alert">⚠ พื้นที่ใกล้เต็ม (เกิน 80%) — ควรลบไฟล์ของงานเก่าที่ตรวจเสร็จแล้ว</div>' : ''}
  </div>`;
}

function capacityText(usedBytes, nStudents, maxMb) {
  const remain = Math.max(0, QUOTA_MB - usedBytes / 1048576);
  const per = nStudents * maxMb;
  if (!per) return '';
  const n = Math.floor(remain / per);
  return `ถ้านิสิต ${nStudents} คนส่งไฟล์เต็ม ${nf(maxMb)} MB ทุกคน งานหนึ่งใช้ ${nf(per, 0)} MB → พื้นที่ที่เหลือสั่งงานแบบนี้ได้อีก <b>${n}</b> งาน
    <span class="muted">(ใช้จริงมักน้อยกว่านี้มาก เช่น PDF จากรูปถ่าย ~1 MB)</span>`;
}

/* =====================================================================
   ฝั่งอาจารย์: แท็บ "การบ้าน"
   ===================================================================== */
function tabHomework(m) {
  const d = S.d;
  if (!d.subsReady) {
    m.innerHTML = `<div class="empty">ยังไม่ได้ติดตั้งระบบการบ้าน — รันไฟล์ <b>04_homework.sql</b> ใน Supabase SQL Editor ก่อน แล้วรีเฟรชหน้านี้</div>`;
    return;
  }
  if (S.hwItem && d.itemById.get(S.hwItem)) return hwDetail(m, d.itemById.get(S.hwItem));
  S.hwItem = null;

  const N = d.students.length;
  const list = d.items.filter(isAssignment).sort((a, b) =>
    (a.due_at ? new Date(a.due_at) : Infinity) - (b.due_at ? new Date(b.due_at) : Infinity) || a.id - b.id);

  const card = (it) => {
    const cat = d.cats.find((c) => c.id === it.category_id);
    let sent = 0, late = 0, ret = 0, graded = 0;
    d.students.forEach((s) => {
      const sub = subOf(d, it.id, s.id);
      if (sub) { sent++; if (sub.is_late) late++; if (sub.returned) ret++; }
      const v = d.scores.get(key(it.id, s.id));
      if (v !== null && v !== undefined) graded++;
    });
    const open = isOpen(it);
    return `<div class="card hwcard">
      <div class="hwhead">
        <div>
          <div class="eyebrow">${esc(cat?.name || '')}</div>
          <h3>${esc(it.title)}</h3>
          <div class="muted sm">${it.due_at ? `กำหนดส่ง ${thaiDT(it.due_at)}` : 'ไม่มีกำหนดส่ง'}
            ${it.close_at ? ` · รับงานช้าถึง ${thaiDT(it.close_at)}` : ''}
            · ${it.accept_files ? `รับไฟล์: ${esc(typesLabel(it))} ≤ ${nf(it.max_file_mb)} MB` : 'ไม่รับไฟล์ทางเว็บ'}</div>
        </div>
        <div class="hwbtns">
          <button class="btn sm" data-hwedit="${it.id}">แก้ไข</button>
          <button class="btn primary sm" data-hwopen="${it.id}">ดูการส่งงาน</button>
        </div>
      </div>
      <div class="hwstats">
        ${it.accept_files ? `<span class="badge ${open ? 'okb' : ''}">${open ? 'เปิดรับอยู่' : 'ปิดรับแล้ว'}</span>` : ''}
        <span>ส่งแล้ว <b>${sent}</b>/${N}</span><span>ส่งช้า <b>${late}</b></span>
        <span>ยังไม่ส่ง <b>${N - sent}</b></span><span>คืนไฟล์แล้ว <b>${ret}</b></span>
        <span>กรอกคะแนนแล้ว <b>${graded}</b></span>
        ${it.visible ? '<span class="badge okb">ประกาศคะแนนแล้ว</span>' : ''}
      </div>
    </div>`;
  };

  m.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-head row">
        <div><h2>การบ้าน / งานที่สั่ง</h2>
          <p class="muted">งานที่สั่งจะเป็น “รายการคะแนน” ในหมวดที่เลือกด้วย · นิสิตเห็นทันทีในหน้าของตัวเอง</p></div>
        <button class="btn primary" id="hwNew">＋ สั่งงานใหม่</button>
      </div>
      <div id="hwMeter" class="muted">กำลังตรวจพื้นที่เก็บไฟล์…</div>
    </div>
    ${list.map(card).join('') || '<div class="empty">ยังไม่มีงานที่สั่ง — กด “＋ สั่งงานใหม่”</div>'}
  </div>`;

  m.querySelector('#hwNew').onclick = () => hwForm(null);
  m.querySelectorAll('[data-hwedit]').forEach((b) => (b.onclick = () => hwForm(d.itemById.get(Number(b.dataset.hwedit)))));
  m.querySelectorAll('[data-hwopen]').forEach((b) => (b.onclick = () => { S.hwItem = Number(b.dataset.hwopen); renderTab(); window.scrollTo(0, 0); }));

  storageUsage().then((u) => {
    const el = m.querySelector('#hwMeter');
    if (!el) return;
    el.classList.remove('muted');
    el.innerHTML = meterHtml(u.bytes) + `<p class="hint">${capacityText(u.bytes, N, 5)} · ไฟล์ทั้งหมด ${u.files} ไฟล์</p>`;
  }).catch((e) => { const el = m.querySelector('#hwMeter'); if (el) el.textContent = 'ตรวจพื้นที่ไม่สำเร็จ: ' + e.message; });
}

/* ---------- ฟอร์มสั่งงาน / แก้ไขงาน ---------- */
function hwForm(it) {
  const d = S.d;
  const isNew = !it;
  if (!d.cats.length) return toast('สร้างหมวดคะแนนก่อน (แท็บ “หมวด / รายการคะแนน”)', 'err');
  const defCat = it?.category_id ?? (d.cats.find((c) => /บ้าน|งาน|homework|assign/i.test(c.name)) || d.cats[0]).id;
  const types = allowedSet(it || { file_types: 'pdf,image' });
  const N = d.students.length;

  const dlg = document.createElement('dialog');
  dlg.className = 'dialog wide';
  dlg.innerHTML = `<form>
    <h3>${isNew ? 'สั่งงานใหม่' : 'แก้ไขงาน'}</h3>
    <div class="fgrid">
      <label class="span2">ชื่องาน<input name="htitle" required value="${esc(it?.title || '')}" placeholder="เช่น ใบงานที่ 3 การทำความสะอาดข้อมูล"></label>
      <label>หมวดคะแนน<select name="cat">${d.cats.map((c) => `<option value="${c.id}" ${c.id === defCat ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label>คะแนนเต็ม<input name="max" inputmode="decimal" required value="${num(it?.max_score ?? 10)}"></label>
      <label class="span2">รายละเอียด / คำสั่งงาน<textarea name="desc" rows="5" placeholder="อธิบายงาน ขอบเขต วิธีส่ง …">${esc(it?.description || '')}</textarea></label>
      <label class="span2">ลิงก์ประกอบ (ถ้ามี)<input name="link" type="url" value="${esc(it?.link_url || '')}" placeholder="https://…"></label>
      <div class="span2 attbox">
        <label>ไฟล์โจทย์ (ถ้ามี · ไม่เกิน ${FILE_LIMIT_MB} MB)<input name="att" type="file"></label>
        ${it?.attachment_path ? `<div class="sm">ปัจจุบัน: <b>${esc(it.attachment_name)}</b> (${fmtSize(it.attachment_size)})
          <label class="inl"><input type="checkbox" name="rmatt"> ลบไฟล์นี้</label></div>` : ''}
      </div>
      <label>กำหนดส่ง<input name="due" type="datetime-local" value="${toLocalInput(it?.due_at)}"></label>
      <label>รับงานช้าได้ถึง <span class="muted">(ว่าง = ปิดตรงกำหนดส่ง)</span><input name="close" type="datetime-local" value="${toLocalInput(it?.close_at)}"></label>
    </div>
    <fieldset>
      <legend><label class="inl"><input type="checkbox" name="accept" ${(it ? it.accept_files : true) ? 'checked' : ''}> รับไฟล์ส่งงานทางเว็บ</label></legend>
      <div class="types">${Object.entries(FILE_TYPES).map(([k, t]) =>
        `<label class="inl"><input type="checkbox" name="type_${k}" ${types.has(k) ? 'checked' : ''}> ${t.label}</label>`).join('')}</div>
      <label>ขนาดไฟล์สูงสุดต่อคน (MB)<input name="maxmb" inputmode="decimal" class="short" value="${num(it?.max_file_mb ?? 5)}"></label>
      <div id="hwEst" class="muted sm">กำลังตรวจพื้นที่เก็บไฟล์…</div>
    </fieldset>
    <div class="dactions">
      ${isNew ? '' : '<button type="button" class="btn danger" data-del>ลบงานนี้</button><span class="spacer"></span>'}
      <button type="button" class="btn" data-cancel>ยกเลิก</button>
      <button type="submit" class="btn primary">${isNew ? 'สั่งงาน' : 'บันทึก'}</button>
    </div>
  </form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const f = dlg.querySelector('form');

  let usedBytes = null;
  const updEst = () => {
    const el = dlg.querySelector('#hwEst');
    const maxmb = Number(f.maxmb.value.replace(',', '.')) || 0;
    if (usedBytes === null) return;
    if (!f.accept.checked) { el.innerHTML = meterHtml(usedBytes); return; }
    el.innerHTML = meterHtml(usedBytes, N * maxmb * 1048576)
      + `<p class="hint">${capacityText(usedBytes, N, maxmb)}</p>`
      + (maxmb > FILE_LIMIT_MB ? `<div class="m-alert bad">⚠ ระบบฟรีรับไฟล์ละไม่เกิน ${FILE_LIMIT_MB} MB</div>` : '');
  };
  storageUsage().then((u) => { usedBytes = u.bytes; updEst(); })
    .catch((e) => { dlg.querySelector('#hwEst').textContent = 'ตรวจพื้นที่ไม่สำเร็จ: ' + e.message; });
  f.addEventListener('input', (e) => { if (['maxmb', 'accept'].includes(e.target.name)) updEst(); });
  f.querySelector('[data-cancel]').onclick = () => dlg.close();

  f.querySelector('[data-del]')?.addEventListener('click', async () => {
    const subs = d.students.map((s) => subOf(d, it.id, s.id)).filter((x) => x?.file_path);
    if (!(await uiConfirm('ลบงานนี้', `ลบงาน “${it.title}” พร้อมคะแนน ไฟล์ที่นิสิตส่ง (${subs.length} ไฟล์) และไฟล์โจทย์\nย้อนกลับไม่ได้`, 'ลบงาน'))) return;
    try {
      const paths = subs.map((x) => x.file_path);
      if (it.attachment_path) paths.push(it.attachment_path);
      for (let i = 0; i < paths.length; i += 100) await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
      const { error } = await sb.from('items').delete().eq('id', it.id);
      if (error) throw error;
      dlg.close();
      S.hwItem = null;
      toast('ลบงานแล้ว');
      refresh();
    } catch (e) { fail(e, 'ลบไม่สำเร็จ'); }
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]');
    const max = Number(f.max.value.replace(',', '.'));
    const maxmb = Number(f.maxmb.value.replace(',', '.'));
    const due = f.due.value ? new Date(f.due.value).toISOString() : null;
    const close = f.close.value ? new Date(f.close.value).toISOString() : null;
    const ftypes = Object.keys(FILE_TYPES).filter((k) => f['type_' + k].checked);
    if (!(max > 0)) return toast('คะแนนเต็มต้องมากกว่า 0', 'err');
    if (f.accept.checked && !(maxmb > 0 && maxmb <= FILE_LIMIT_MB)) return toast(`ขนาดไฟล์สูงสุดต้องอยู่ระหว่าง 0–${FILE_LIMIT_MB} MB`, 'err');
    if (f.accept.checked && !ftypes.length) return toast('เลือกชนิดไฟล์ที่รับอย่างน้อย 1 ชนิด', 'err');
    if (due && close && new Date(close) < new Date(due)) return toast('“รับงานช้าได้ถึง” ต้องอยู่หลังกำหนดส่ง', 'err');
    const att = f.att.files[0];
    if (att && att.size > FILE_LIMIT_MB * 1048576) return toast(`ไฟล์โจทย์ใหญ่เกิน ${FILE_LIMIT_MB} MB`, 'err');

    const payload = {
      category_id: Number(f.cat.value), title: f.elements.htitle.value.trim(), max_score: max,
      description: f.desc.value.trim() || null, link_url: f.link.value.trim() || null,
      due_at: due, close_at: close, accept_files: f.accept.checked,
      file_types: (ftypes.length ? ftypes : ['pdf']).join(','), max_file_mb: maxmb > 0 ? maxmb : 5,
    };
    btn.disabled = true;
    btn.textContent = 'กำลังบันทึก…';
    try {
      let id = it?.id;
      if (isNew) {
        payload.sort = (d.itemsByCat.get(payload.category_id) || []).length + 1;
        const { data, error } = await sb.from('items').insert(payload).select().single();
        if (error) throw error;
        id = data.id;
      } else {
        const { error } = await sb.from('items').update(payload).eq('id', id);
        if (error) throw error;
      }
      if (f.rmatt?.checked && it?.attachment_path && !att) {
        await sb.storage.from(BUCKET).remove([it.attachment_path]);
        await sb.from('items').update({ attachment_path: null, attachment_name: null, attachment_size: null }).eq('id', id);
      }
      if (att) {
        const path = `${id}/assignment/file${extOf(att.name) ? '.' + extOf(att.name) : ''}`;
        await uploadTo(path, att, it?.attachment_path);
        const { error } = await sb.from('items').update({ attachment_path: path, attachment_name: att.name, attachment_size: att.size }).eq('id', id);
        if (error) throw error;
      }
      dlg.close();
      toast(isNew ? 'สั่งงานแล้ว — นิสิตเห็นในหน้าของตัวเองทันที' : 'บันทึกแล้ว');
      refresh();
    } catch (err) {
      fail(err, 'บันทึกไม่สำเร็จ');
      btn.disabled = false;
      btn.textContent = isNew ? 'สั่งงาน' : 'บันทึก';
    }
  });
}

/* ---------- รายละเอียดการส่งงาน (อาจารย์) ---------- */
function hwDetail(m, it) {
  const d = S.d;
  const N = d.students.length;
  const filter = S.hwFilter || 'all';
  const rows = d.students.filter((s) => {
    const sub = subOf(d, it.id, s.id);
    return filter === 'all' || (filter === 'sent' && sub) || (filter === 'none' && !sub) || (filter === 'late' && sub?.is_late);
  });
  const sentN = d.students.filter((s) => subOf(d, it.id, s.id)).length;
  const fileN = d.students.filter((s) => subOf(d, it.id, s.id)?.file_path).length;

  m.innerHTML = `<div class="page">
    <div class="card">
      <div class="card-head row">
        <div><button class="btn ghost sm" id="hwBack">← งานทั้งหมด</button>
          <h2>${esc(it.title)}</h2>
          <p class="muted">${it.due_at ? `กำหนดส่ง ${thaiDT(it.due_at)}` : 'ไม่มีกำหนดส่ง'}${it.close_at ? ` · รับงานช้าถึง ${thaiDT(it.close_at)}` : ''}
            · ส่งแล้ว ${sentN}/${N} คน</p></div>
        <div class="hwbtns">
          <button class="btn sm" id="hwEdit">แก้ไขงาน</button>
        </div>
      </div>
      <div class="hwtools">
        <button class="btn primary" id="hwZip" ${fileN ? '' : 'disabled'}>⬇ ดาวน์โหลดทั้งหมด (.zip · ${fileN} ไฟล์)</button>
        <button class="btn" id="hwRet" ${fileN ? '' : 'disabled'}>⬆ ส่งไฟล์ตรวจกลับ (หลายไฟล์ / .zip)</button>
        <input type="file" id="hwRetIn" multiple hidden>
        <span class="spacer"></span>
        <button class="btn danger sm" id="hwPurge" ${fileN ? '' : 'disabled'}>ลบไฟล์ทั้งหมดของงานนี้</button>
      </div>
      <p class="hint">ไฟล์ใน .zip ตั้งชื่อเป็น <code>รหัสนิสิต_ชื่อ.นามสกุล</code> — ตรวจ/เขียนลงไฟล์แล้ว <b>อัปโหลดกลับโดยคงรหัสนิสิตไว้ในชื่อไฟล์</b>
        ระบบจะจับคู่ด้วยรหัสนิสิตและ <b>แทนที่ไฟล์เดิมของนิสิต</b> (ไม่เพิ่มพื้นที่) นิสิตจะเห็น “อาจารย์ส่งไฟล์ตรวจแล้ว”</p>
    </div>
    <div class="card">
      <div class="toolbar">
        <select id="hwFilter">
          <option value="all" ${filter === 'all' ? 'selected' : ''}>ทั้งหมด (${N})</option>
          <option value="sent" ${filter === 'sent' ? 'selected' : ''}>ส่งแล้ว</option>
          <option value="none" ${filter === 'none' ? 'selected' : ''}>ยังไม่ส่ง</option>
          <option value="late" ${filter === 'late' ? 'selected' : ''}>ส่งช้า</option>
        </select>
        <span class="hint">คะแนนและความเห็นบันทึกอัตโนมัติ · นิสิตเห็นคะแนนเมื่อติ๊ก “ประกาศคะแนน” ของงานนี้</span>
        <span class="spacer"></span>
        <label class="inl"><input type="checkbox" id="hwVis" ${it.visible ? 'checked' : ''}> ประกาศคะแนนงานนี้</label>
      </div>
      <div class="tablewrap"><table class="mini hwtable">
        <thead><tr><th>รหัสนิสิต</th><th>ชื่อ-สกุล</th><th>สถานะ</th><th>ไฟล์</th><th>คะแนน /${nf(it.max_score)}</th><th>ความเห็นถึงนิสิต</th><th></th></tr></thead>
        <tbody>${rows.map((s) => {
          const sub = subOf(d, it.id, s.id);
          const v = d.scores.get(key(it.id, s.id));
          const fb = d.feedback?.get(key(it.id, s.id)) || '';
          const st = !sub ? '<span class="badge">ยังไม่ส่ง</span>'
            : `<span class="badge ${sub.is_late ? 'wait' : 'okb'}">${sub.is_late ? 'ส่งช้า' : 'ส่งแล้ว'}</span>
               <div class="muted sm">${thaiDT(sub.submitted_at)}${sub.submit_count > 1 ? ` · ครั้งที่ ${sub.submit_count}` : ''}</div>`;
          const file = sub?.file_path
            ? `<button class="linkbtn" data-open="${s.id}">${esc(sub.file_name || 'ไฟล์')}</button>
               <div class="muted sm">${fmtSize(sub.file_size)}${sub.returned ? ' · <span class="okt">คืนไฟล์ตรวจแล้ว</span>' : ''}</div>`
            : sub ? '<span class="muted sm">ไฟล์ถูกลบแล้ว</span>' : '';
          return `<tr>
            <td>${esc(s.student_id)}</td>
            <td><button class="namebtn" data-viewas="${s.id}">${esc(s.full_name)}</button>${s.nickname ? ` <span class="nick">(${esc(s.nickname)})</span>` : ''}</td>
            <td>${st}</td><td>${file}</td>
            <td><input class="short hwsc" data-s="${s.id}" value="${v ?? ''}" inputmode="decimal"></td>
            <td><input class="hwfb" data-s="${s.id}" value="${esc(fb)}" placeholder="—"></td>
            <td class="nowrap">${sub?.file_path ? `<button class="btn sm" data-ret1="${s.id}" title="อัปโหลดไฟล์ตรวจแล้ว แทนที่ไฟล์เดิม">⬆ คืนไฟล์</button>` : ''}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" class="muted">ไม่มีรายการ</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>`;

  m.querySelector('#hwBack').onclick = () => { S.hwItem = null; renderTab(); };
  m.querySelector('#hwEdit').onclick = () => hwForm(it);
  m.querySelector('#hwFilter').onchange = (e) => { S.hwFilter = e.target.value; hwDetail(m, it); };
  m.querySelector('#hwVis').onchange = async (e) => {
    const { error } = await sb.from('items').update({ visible: e.target.checked }).eq('id', it.id);
    if (error) { e.target.checked = !e.target.checked; return fail(error, 'บันทึกไม่สำเร็จ'); }
    it.visible = e.target.checked;
    toast(it.visible ? 'ประกาศคะแนนแล้ว' : 'ยกเลิกการประกาศแล้ว');
  };
  m.querySelectorAll('[data-viewas]').forEach((b) => (b.onclick = () => viewAsStudent(b.dataset.viewas)));
  m.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => {
    const s = d.students.find((x) => x.id === Number(b.dataset.open));
    const sub = subOf(d, it.id, s.id);
    openStored(sub.file_path);
  }));

  // คะแนน + ความเห็น
  m.querySelectorAll('.hwsc').forEach((el) => (el.onchange = async () => {
    const raw = el.value.trim();
    const v = raw === '' ? null : Number(raw.replace(',', '.'));
    if (v !== null && isNaN(v)) { el.classList.add('bad'); return toast('ต้องเป็นตัวเลข', 'err'); }
    const sid = Number(el.dataset.s);
    const { error } = await sb.from('scores').upsert({ item_id: it.id, student_row_id: sid, raw_score: v, updated_at: new Date().toISOString() }, { onConflict: 'item_id,student_row_id' });
    if (error) { el.classList.add('bad'); return fail(error, 'บันทึกคะแนนไม่สำเร็จ'); }
    d.scores.set(key(it.id, sid), v);
    el.classList.remove('bad');
    el.classList.toggle('warn', v !== null && v > it.max_score);
    el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 800);
  }));
  m.querySelectorAll('.hwfb').forEach((el) => (el.onchange = async () => {
    const sid = Number(el.dataset.s);
    const fb = el.value.trim() || null;
    const { error } = await sb.from('scores').upsert({ item_id: it.id, student_row_id: sid, feedback: fb }, { onConflict: 'item_id,student_row_id' });
    if (error) return fail(error, 'บันทึกไม่สำเร็จ');
    if (!d.feedback) d.feedback = new Map();
    if (fb) d.feedback.set(key(it.id, sid), fb); else d.feedback.delete(key(it.id, sid));
    el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 800);
  }));
  m.querySelectorAll('.hwsc').forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = el.closest('tr').nextElementSibling?.querySelector('.hwsc');
    if (next) { next.focus(); next.select(); } else el.blur();
  }));

  m.querySelector('#hwZip').onclick = (e) => hwDownloadAll(it, e.currentTarget);
  const retIn = m.querySelector('#hwRetIn');
  let retTarget = null;
  m.querySelector('#hwRet').onclick = () => { retTarget = null; retIn.accept = ''; retIn.multiple = true; retIn.click(); };
  m.querySelectorAll('[data-ret1]').forEach((b) => (b.onclick = () => {
    retTarget = Number(b.dataset.ret1); retIn.multiple = false; retIn.click();
  }));
  retIn.onchange = async () => {
    const files = [...retIn.files];
    retIn.value = '';
    if (!files.length) return;
    if (retTarget) {
      const s = d.students.find((x) => x.id === retTarget);
      return hwReturnFiles(it, [{ s, blob: files[0], name: files[0].name }], []);
    }
    hwPrepareReturn(it, files);
  };

  m.querySelector('#hwPurge').onclick = async () => {
    const subs = d.students.map((s) => subOf(d, it.id, s.id)).filter((x) => x?.file_path);
    const total = subs.reduce((a, x) => a + (x.file_size || 0), 0);
    if (!(await uiConfirm('ลบไฟล์ทั้งหมดของงานนี้',
      `ลบไฟล์ที่นิสิตส่ง/ไฟล์ตรวจกลับ ${subs.length} ไฟล์ (${fmtSize(total)}) เพื่อคืนพื้นที่\nคะแนน ความเห็น และประวัติการส่ง (เวลา/ส่งช้า) ยังอยู่ครบ\nควรดาวน์โหลด .zip เก็บไว้ก่อน — ย้อนกลับไม่ได้`, 'ลบไฟล์'))) return;
    try {
      const paths = subs.map((x) => x.file_path);
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await sb.storage.from(BUCKET).remove(paths.slice(i, i + 100));
        if (error) throw error;
      }
      const { error } = await sb.from('submissions').update({ file_path: null, file_size: 0 }).eq('item_id', it.id);
      if (error) throw error;
      toast(`ลบ ${paths.length} ไฟล์แล้ว คืนพื้นที่ ${fmtSize(total)}`);
      refresh();
    } catch (e) { fail(e, 'ลบไม่สำเร็จ'); }
  };
}

async function hwDownloadAll(it, btn) {
  const d = S.d;
  const list = d.students.map((s) => ({ s, sub: subOf(d, it.id, s.id) })).filter((x) => x.sub?.file_path);
  if (!list.length) return;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const zip = new JSZip();
    const folder = zip.folder(safeName(it.title));
    let done = 0;
    const failed = [];
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const { s, sub } = queue.shift();
        const { data, error } = await sb.storage.from(BUCKET).download(sub.file_path);
        if (error) failed.push(s.student_id);
        else {
          const ext = extOf(sub.file_path) || extOf(sub.file_name);
          folder.file(`${s.student_id}_${safeName(s.full_name)}${sub.is_late ? '_ส่งช้า' : ''}${ext ? '.' + ext : ''}`, data);
        }
        done++;
        btn.textContent = `กำลังดาวน์โหลด ${done}/${list.length}…`;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    btn.textContent = 'กำลังรวมไฟล์ .zip…';
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    download(`${course().code}_${safeName(it.title)}.zip`, blob);
    toast(failed.length ? `ดาวน์โหลดแล้ว — ไม่สำเร็จ ${failed.length} ไฟล์: ${failed.join(', ')}` : `ดาวน์โหลด ${list.length} ไฟล์แล้ว`, failed.length ? 'err' : 'ok');
  } catch (e) {
    fail(e, 'ดาวน์โหลดไม่สำเร็จ');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// รวมไฟล์ที่เลือก (แตก .zip ให้) แล้วจับคู่กับนิสิตด้วยรหัสนิสิตในชื่อไฟล์
async function hwPrepareReturn(it, files) {
  const d = S.d;
  const entries = [];
  try {
    for (const f of files) {
      if (extOf(f.name) === 'zip') {
        const z = await JSZip.loadAsync(f);
        for (const e of Object.values(z.files)) {
          const base = e.name.split('/').pop();
          if (e.dir || !base || e.name.startsWith('__MACOSX') || base.startsWith('.')) continue;
          const blob = await e.async('blob');
          entries.push({ name: base, blob });
        }
      } else entries.push({ name: f.name, blob: f });
    }
  } catch (e) { return fail(e, 'อ่านไฟล์ .zip ไม่สำเร็จ'); }

  const matched = [];
  const unmatched = [];
  const seen = new Set();
  for (const e of entries) {
    const ids = e.name.match(/\d{6,}/g) || [];
    const s = d.students.find((x) => ids.includes(x.student_id));
    const sub = s && subOf(d, it.id, s.id);
    if (!s) unmatched.push(`${e.name} — ไม่พบรหัสนิสิตในชื่อไฟล์`);
    else if (!sub) unmatched.push(`${e.name} — ${s.student_id} ยังไม่ได้ส่งงานนี้`);
    else if (seen.has(s.id)) unmatched.push(`${e.name} — ซ้ำกับไฟล์อื่นของ ${s.student_id}`);
    else if (e.blob.size > FILE_LIMIT_MB * 1048576) unmatched.push(`${e.name} — ใหญ่เกิน ${FILE_LIMIT_MB} MB`);
    else { seen.add(s.id); matched.push({ s, blob: e.blob, name: e.name }); }
  }
  hwReturnFiles(it, matched, unmatched);
}

async function hwReturnFiles(it, matched, unmatched) {
  const d = S.d;
  const total = matched.reduce((a, x) => a + x.blob.size, 0);
  const old = matched.reduce((a, x) => a + (subOf(d, it.id, x.s.id)?.file_size || 0), 0);
  const msg = `จับคู่ได้ ${matched.length} ไฟล์ (${fmtSize(total)}) — จะแทนที่ไฟล์เดิมของนิสิต (${fmtSize(old)})`
    + (matched.length ? `\n\n${matched.slice(0, 12).map((x) => `• ${x.s.student_id} ${x.s.full_name} ← ${x.name}`).join('\n')}${matched.length > 12 ? `\n… และอีก ${matched.length - 12} คน` : ''}` : '')
    + (unmatched.length ? `\n\nข้าม ${unmatched.length} ไฟล์:\n${unmatched.slice(0, 8).map((x) => '• ' + x).join('\n')}${unmatched.length > 8 ? '\n…' : ''}` : '');
  if (!matched.length) return uiConfirm('ส่งไฟล์ตรวจกลับ', msg, 'ตกลง', false);
  if (!(await uiConfirm('ส่งไฟล์ตรวจกลับ (แทนที่ไฟล์เดิม)', msg, `แทนที่ ${matched.length} ไฟล์`, false))) return;

  let ok = 0;
  const failed = [];
  for (const x of matched) {
    try {
      const sub = subOf(d, it.id, x.s.id);
      const ext = extOf(x.name) || extOf(sub.file_path) || 'pdf';
      const path = `${it.id}/${x.s.id}/submission.${ext}`;
      await uploadTo(path, x.blob, sub.file_path);
      const { error } = await sb.from('submissions').update({
        file_path: path, file_size: x.blob.size, returned: true, returned_at: new Date().toISOString(),
      }).eq('id', sub.id);
      if (error) throw error;
      ok++;
      toast(`ส่งไฟล์ตรวจกลับ ${ok}/${matched.length}…`);
    } catch (e) {
      console.error(e);
      failed.push(x.s.student_id);
    }
  }
  toast(failed.length ? `สำเร็จ ${ok} ไฟล์ · ไม่สำเร็จ: ${failed.join(', ')}` : `ส่งไฟล์ตรวจกลับ ${ok} ไฟล์แล้ว`, failed.length ? 'err' : 'ok');
  refresh();
}

/* =====================================================================
   ฝั่งนิสิต: การ์ด "การบ้าน / งานที่ต้องส่ง"
   preview = อาจารย์ดูแบบนิสิต (ไม่มีปุ่มส่งจริง)
   ===================================================================== */
function hwStatus(it, sub, raw) {
  const now = Date.now();
  const due = it.due_at ? new Date(it.due_at).getTime() : null;
  const close = closeTime(it) ? new Date(closeTime(it)).getTime() : null;
  if (sub?.returned) return { t: 'ตรวจแล้ว · มีไฟล์คืน', c: 'okb', o: 3 };
  if (it.visible && raw !== null) return { t: `ตรวจแล้ว · ${nf(raw)}/${nf(it.max_score)}`, c: 'okb', o: 3 };
  if (sub) return { t: sub.is_late ? 'ส่งช้า · รอตรวจ' : 'ส่งแล้ว · รอตรวจ', c: sub.is_late ? 'wait' : 'okb', o: 2 };
  if (it.accept_files && close !== null && now > close) return { t: 'ไม่ได้ส่ง · ปิดรับแล้ว', c: 'bad', o: 2 };
  if (due !== null && now > due) {
    return it.accept_files ? { t: `เลยกำหนด · ยังส่งได้ถึง ${thaiDT(closeTime(it))}`, c: 'hot', o: 1 } : { t: 'เลยกำหนดแล้ว', c: '', o: 2 };
  }
  if (due !== null) {
    const days = Math.ceil((due - now) / 86400000);
    return { t: days <= 1 ? 'ครบกำหนดภายใน 24 ชม.' : `อีก ${days} วัน`, c: days <= 3 ? 'hot' : 'wait', o: 1 };
  }
  return { t: it.accept_files ? 'ยังไม่ส่ง' : '', c: 'wait', o: 1 };
}

function renderHwStudent(box, { row, d, preview, onChanged }) {
  if (!box) return;
  const list = d.items.filter(isAssignment).map((it) => {
    const sub = subOf(d, it.id, row.id);
    const raw = it.visible ? d.scores.get(key(it.id, row.id)) ?? null : null;
    return { it, sub, raw, st: hwStatus(it, sub, raw), cat: d.cats.find((k) => k.id === it.category_id) };
  }).sort((a, b) => a.st.o - b.st.o
    || (a.st.o === 1 ? (a.it.due_at ? new Date(a.it.due_at) : Infinity) - (b.it.due_at ? new Date(b.it.due_at) : Infinity)
      : (b.it.due_at ? new Date(b.it.due_at) : 0) - (a.it.due_at ? new Date(a.it.due_at) : 0)));
  if (!list.length) { box.innerHTML = ''; return; }
  const todo = list.filter((x) => x.st.o === 1).length;

  box.innerHTML = `<section class="card">
    <div class="card-head"><h2>การบ้าน / งานที่ต้องส่ง</h2>
      <p class="muted">${todo ? `ต้องส่งอีก <b>${todo}</b> งาน` : 'ไม่มีงานค้าง'} · กดที่งานเพื่อดูคำสั่งงานและส่งไฟล์</p></div>
    <div class="hwlist">${list.map(({ it, sub, raw, st, cat }) => {
      const fb = it.visible ? d.feedback?.get(key(it.id, row.id)) : null;
      const allow = allowedSet(it);
      const accept = [...allow].map((k) => FILE_TYPES[k]?.accept).filter(Boolean).join(',');
      const open = isOpen(it);
      const lateNow = open && it.due_at && Date.now() > new Date(it.due_at).getTime();
      const uploader = !it.accept_files ? '<p class="muted sm">งานนี้ไม่ได้รับไฟล์ทางเว็บ</p>'
        : !open ? (sub ? '' : '<p class="muted sm">ปิดรับงานแล้ว</p>')
        : preview ? `<div class="upbox preview">มุมมองอาจารย์: ช่องส่งไฟล์ของนิสิตอยู่ตรงนี้ (รับ ${esc(typesLabel(it))} ≤ ${nf(it.max_file_mb)} MB)</div>`
        : `<div class="upbox">
            <label class="upl">เลือกไฟล์${allow.has('image') ? ' หรือถ่ายรูป (หลายรูปได้)' : ''}
              <input type="file" data-up="${it.id}" accept="${accept}" ${allow.has('image') ? 'multiple' : ''}></label>
            <div class="muted sm">รับ: ${esc(typesLabel(it))} · ขนาดไม่เกิน <b>${nf(it.max_file_mb)} MB</b>
              ${allow.has('image') ? ' · รูปหลายรูปจะถูกย่อและรวมเป็น PDF ไฟล์เดียว' : ''}</div>
            ${lateNow ? '<div class="m-alert">⚠ เลยกำหนดส่งแล้ว — ส่งตอนนี้จะนับเป็น “ส่งช้า”</div>' : ''}
            ${sub?.returned ? '<div class="m-alert">⚠ ถ้าส่งใหม่ ไฟล์ที่อาจารย์ตรวจแล้วจะถูกแทนที่</div>' : ''}
            <div class="upact"><button class="btn primary" data-send="${it.id}" disabled>${sub ? 'ส่งใหม่ (แทนไฟล์เดิม)' : 'ส่งงาน'}</button>
              <span class="upmsg" data-msg="${it.id}"></span></div>
          </div>`;
      return `<details class="hw ${st.c}" ${st.o === 1 ? 'open' : ''}>
        <summary>
          <div><div class="todo-title">${esc(it.title)}</div>
            <div class="muted sm">${esc(cat?.name || '')}${it.due_at ? ` · กำหนดส่ง ${thaiDT(it.due_at)}` : ''}</div></div>
          ${st.t ? `<span class="badge ${st.c}">${st.t}</span>` : ''}
        </summary>
        <div class="hwbody">
          ${it.description ? `<div class="hwdesc">${esc(it.description)}</div>` : ''}
          ${it.link_url || it.attachment_path ? `<div class="hwlinks">
            ${it.attachment_path ? `<button class="btn sm" data-att="${it.id}">📎 ${esc(it.attachment_name || 'ไฟล์โจทย์')} <span class="muted">(${fmtSize(it.attachment_size)})</span></button>` : ''}
            ${it.link_url ? `<a class="btn sm" href="${esc(it.link_url)}" target="_blank" rel="noopener">🔗 ลิงก์ประกอบ</a>` : ''}</div>` : ''}
          ${sub ? `<div class="subbox">
            ${sub.file_path ? `<div><b>${sub.returned ? 'ไฟล์ที่อาจารย์ตรวจแล้ว' : 'ไฟล์ที่ส่ง'}:</b>
                <button class="linkbtn" data-mine="${it.id}">${esc(sub.file_name || 'ไฟล์')}</button>
                <span class="muted sm">(${fmtSize(sub.file_size)})</span></div>` : '<div class="muted sm">ไฟล์ถูกลบหลังตรวจเสร็จแล้ว</div>'}
            <div class="muted sm">ส่งเมื่อ ${thaiDT(sub.submitted_at)}${sub.is_late ? ' · <b class="warnt">ส่งช้า</b>' : ''}${sub.submit_count > 1 ? ` · ส่ง ${sub.submit_count} ครั้ง (แสดงครั้งล่าสุด)` : ''}
              ${sub.returned ? ` · อาจารย์ส่งไฟล์คืนเมื่อ ${thaiDT(sub.returned_at)}` : ''}</div>
          </div>` : ''}
          ${raw !== null ? `<div class="subbox okb">คะแนน <b>${nf(raw)}</b> / ${nf(it.max_score)}${fb ? `<div class="fb">💬 ${esc(fb)}</div>` : ''}</div>` : ''}
          ${uploader}
        </div>
      </details>`;
    }).join('')}</div>
  </section>`;

  const chosen = new Map();
  box.querySelectorAll('[data-att]').forEach((b) => (b.onclick = () => {
    const it = d.itemById.get(Number(b.dataset.att));
    openStored(it.attachment_path, it.attachment_name);
  }));
  box.querySelectorAll('[data-mine]').forEach((b) => (b.onclick = () => {
    const sub = subOf(d, Number(b.dataset.mine), row.id);
    openStored(sub.file_path);
  }));
  box.querySelectorAll('[data-up]').forEach((inp) => (inp.onchange = () => {
    const it = d.itemById.get(Number(inp.dataset.up));
    const files = [...inp.files];
    const msg = box.querySelector(`[data-msg="${it.id}"]`);
    const btn = box.querySelector(`[data-send="${it.id}"]`);
    const check = checkFiles(it, files);
    chosen.set(it.id, files);
    msg.className = 'upmsg ' + (check.ok ? '' : 'bad');
    msg.textContent = check.text;
    btn.disabled = !check.ok;
  }));
  box.querySelectorAll('[data-send]').forEach((btn) => (btn.onclick = async () => {
    const it = d.itemById.get(Number(btn.dataset.send));
    const msg = box.querySelector(`[data-msg="${it.id}"]`);
    btn.disabled = true;
    try {
      await studentSubmit(it, row, d, chosen.get(it.id) || [], (t) => (msg.textContent = t));
      toast('ส่งงานแล้ว');
      onChanged?.();
    } catch (e) {
      msg.className = 'upmsg bad';
      msg.textContent = e.message || String(e);
      btn.disabled = false;
    }
  }));
}

function checkFiles(it, files) {
  if (!files.length) return { ok: false, text: '' };
  const allow = allowedSet(it);
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  const limit = it.max_file_mb * 1048576;
  if (imgs.length) {
    if (!allow.has('image')) return { ok: false, text: 'งานนี้ไม่รับรูปภาพ' };
    if (imgs.length !== files.length) return { ok: false, text: 'เลือกรูปอย่างเดียว หรือไฟล์เดียว อย่าปนกัน' };
    const raw = imgs.reduce((a, f) => a + f.size, 0);
    return { ok: true, text: `${imgs.length} รูป (${fmtSize(raw)}) — จะย่อและรวมเป็น PDF ก่อนส่ง` };
  }
  if (files.length > 1) return { ok: false, text: 'ส่งได้ไฟล์เดียว — ถ้ามีหลายไฟล์ให้รวมเป็น PDF หรือ ZIP' };
  const f = files[0];
  const ext = extOf(f.name);
  const okType = [...allow].some((k) => k !== 'image' && FILE_TYPES[k]?.exts.includes(ext));
  if (!okType) return { ok: false, text: `ไม่รับไฟล์ .${ext || '?'} — รับเฉพาะ ${typesLabel(it)}` };
  if (f.size > limit) return { ok: false, text: `ไฟล์ ${fmtSize(f.size)} เกินกำหนด ${nf(it.max_file_mb)} MB — ลดขนาดไฟล์ก่อนส่ง` };
  return { ok: true, text: `${f.name} (${fmtSize(f.size)})` };
}

async function studentSubmit(it, row, d, files, progress) {
  const check = checkFiles(it, files);
  if (!check.ok) throw new Error(check.text || 'ยังไม่ได้เลือกไฟล์');
  let blob, name;
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (imgs.length) {
    progress('กำลังย่อรูปและรวมเป็น PDF…');
    blob = await imagesToPdf(imgs);
    name = `${safeName(it.title)}.pdf`;
  } else {
    blob = files[0];
    name = files[0].name;
  }
  if (blob.size > it.max_file_mb * 1048576) {
    throw new Error(`ไฟล์ ${fmtSize(blob.size)} เกินกำหนด ${nf(it.max_file_mb)} MB — ลองถ่ายรูปให้น้อยลงหรือลดขนาดไฟล์`);
  }
  const ext = extOf(name) || 'pdf';
  const path = `${it.id}/${row.id}/submission.${ext}`;
  const old = subOf(d, it.id, row.id);
  progress(`กำลังอัปโหลด ${fmtSize(blob.size)}…`);
  await uploadTo(path, blob, old?.file_path);
  const { error } = await sb.from('submissions').upsert(
    { item_id: it.id, student_row_id: row.id, file_path: path, file_name: name, file_size: blob.size },
    { onConflict: 'item_id,student_row_id' });
  if (error) throw error;
}

// ย่อรูป (ด้านยาวไม่เกิน 1600px, JPEG 72%) แล้วรวมเป็น PDF หน้าละรูป
async function imagesToPdf(files) {
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const f of files) {
    let bmp;
    try {
      bmp = await createImageBitmap(f);
    } catch {
      throw new Error(`เปิดรูป ${f.name} ไม่ได้ (อาจเป็นไฟล์ HEIC) — ตั้งกล้องเป็น JPG หรือส่งเป็น PDF`);
    }
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    const jpg = cv.toDataURL('image/jpeg', 0.72);
    const pw = 595;
    const ph = Math.round((595 * h) / w);
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation: pw > ph ? 'landscape' : 'portrait' });
    else doc.addPage([pw, ph], pw > ph ? 'landscape' : 'portrait');
    doc.addImage(jpg, 'JPEG', 0, 0, pw, ph);
  }
  return doc.output('blob');
}
