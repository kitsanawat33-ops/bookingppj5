// =====================================================================
// ระบบยื่นคำร้องแก้ไขผลการเรียน (0 ร มส มผ) — Firebase เวอร์ชัน 1.0 (เฟส 1)
// =====================================================================
import * as F from './fb.js';
import { GAS_URL, BOOTSTRAP_ADMIN, STUDENT_EMAIL_DOMAIN } from './config.js';
import { readPdfPages, pp6ToImportRows } from './pp6.js';
const { auth, db } = F;

/* ------------------------------ ค่าคงที่ ------------------------------ */
const ST_LABEL = {
  SUBMITTED: 'ยื่นคำร้องแล้ว รอครูรับเรื่อง', ASSIGNED: 'ครูมอบหมายงาน รอส่งงาน',
  WORK_SUBMITTED: 'ส่งงานแล้ว รอครูตรวจ', REVISE: 'ครูให้แก้ไขงาน', RETURNED: 'ส่งกลับให้ครูทบทวน',
  TEACHER_APPROVED: 'ครูตรวจผ่าน รองานวัดผล', MEASURE_APPROVED: 'งานวัดผลตรวจแล้ว รอวิชาการ',
  ACADEMIC_APPROVED: 'วิชาการตรวจแล้ว รอออกบันทึก', IN_MEMO: 'เสนอบันทึก รอ ผอ. อนุมัติ',
  COMPLETED: 'อนุมัติแล้ว ปรับผลการเรียนแล้ว', FAILED: 'ไม่ผ่านการแก้ไขครั้งนี้',
  REJECTED: 'ไม่รับคำร้อง/ไม่อนุมัติ', CANCELLED: 'ยกเลิกคำร้อง'
};
const ST_COLOR = {
  SUBMITTED: 'blue', ASSIGNED: 'amber', WORK_SUBMITTED: 'violet', REVISE: 'orange', RETURNED: 'orange',
  TEACHER_APPROVED: 'teal', MEASURE_APPROVED: 'teal', ACADEMIC_APPROVED: 'teal', IN_MEMO: 'indigo',
  COMPLETED: 'green', FAILED: 'red', REJECTED: 'gray', CANCELLED: 'gray'
};
const ACTIVE = ['SUBMITTED', 'ASSIGNED', 'WORK_SUBMITTED', 'REVISE', 'RETURNED', 'TEACHER_APPROVED',
  'MEASURE_APPROVED', 'ACADEMIC_APPROVED', 'IN_MEMO'];
const WORKING = ['ASSIGNED', 'REVISE', 'WORK_SUBMITTED', 'RETURNED'];
const TERMINAL_RETRY = ['FAILED', 'REJECTED', 'CANCELLED'];
const ROLE_LABEL = { teacher: 'ครูผู้สอน', measure: 'หัวหน้างานวัดผล', academic: 'หัวหน้าวิชาการ', director: 'ผู้อำนวยการ', admin: 'ผู้ดูแลระบบ' };
const REQ_TYPE = { '0': 'แก้ผลการเรียน 0', 'ร': 'แก้ผลการเรียน ร (รอการตัดสิน)', 'มส': 'แก้ผลการเรียน มส (ไม่มีสิทธิ์สอบ)', 'มผ': 'แก้ผลการประเมิน มผ (ไม่ผ่านกิจกรรม)' };
const STEPS = ['ยื่นคำร้อง', 'ครูมอบหมายงาน', 'ส่งงาน', 'ครูตรวจผ่าน', 'งานวัดผล', 'วิชาการ', 'ผอ. อนุมัติ'];
const STEP_DONE = { SUBMITTED: 1, ASSIGNED: 2, REVISE: 2, WORK_SUBMITTED: 3, RETURNED: 3, TEACHER_APPROVED: 4, MEASURE_APPROVED: 5, ACADEMIC_APPROVED: 6, IN_MEMO: 6, COMPLETED: 7 };

function computeAllowed(m0, mms) {
  const up = m => ['4', '3.5', '3', '2.5', '2', '1.5', '1'].filter(g => Number(g) <= Number(m));
  return { '0': up(m0), 'มส': up(mms), 'ร': ['4', '3.5', '3', '2.5', '2', '1.5', '1', '0'], 'มผ': ['ผ'] };
}
const DEFAULT_SETTINGS = {
  school_name: 'โรงเรียนบ้านโพนแพง เจียรวนนท์อุทิศ 5', current_year: '2569', current_semester: '1',
  fail_grades: ['0', 'ร', 'มส', 'มผ'], max_attempts: 2, max_grade_0: 1, max_grade_ms: 1, max_upload_mb: 10,
  memo_department: 'กลุ่มบริหารวิชาการ โรงเรียนบ้านโพนแพง เจียรวนนท์อุทิศ 5', memo_prefix: '',
  memo_to: 'ผู้อำนวยการโรงเรียนบ้านโพนแพง เจียรวนนท์อุทิศ 5', director_name: '',
  director_position: 'ผู้อำนวยการโรงเรียนบ้านโพนแพง เจียรวนนท์อุทิศ 5', garuda_url: '',
  allowed: computeAllowed(1, 1)
};

/* ------------------------------ state ------------------------------ */
const S = { me: null, settings: { ...DEFAULT_SETTINGS }, view: null, live: {}, liveUnsubs: [], viewUnsubs: [], modalUnsubs: [], activating: false, staffList: null };

/* ------------------------------ utils ------------------------------ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hasRole = r => !!S.me && (S.me.roles || []).includes(r);
const oversight = () => ['measure', 'academic', 'director', 'admin'].some(hasRole);
const dataAdmin = () => hasRole('admin') || hasRole('measure');
const isStudent = () => S.me && S.me.type === 'student';
const lowerSid = s => String(s || '').trim().toLowerCase();
const classKey = c => String(c || '').trim().replace(/[\/\\\s.#$\[\]]+/g, '-');
const failSet = () => S.settings.fail_grades || DEFAULT_SETTINGS.fail_grades;

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function loading(on, text) {
  $('#loading').classList.toggle('hidden', !on);
  if (text) $('#loading-text').textContent = text;
}
function errMsg(e) {
  const c = (e && e.code) || '';
  const map = {
    'permission-denied': 'ไม่มีสิทธิ์ทำรายการนี้ หรือสถานะคำร้องเปลี่ยนไปแล้ว (ลองรีเฟรช)',
    'auth/invalid-credential': 'เลขประจำตัวหรือรหัสผ่านไม่ถูกต้อง', 'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
    'auth/user-not-found': 'ยังไม่ได้เปิดใช้งานบัญชี', 'auth/too-many-requests': 'ลองหลายครั้งเกินไป กรุณารอสักครู่',
    'auth/weak-password': 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', 'auth/popup-closed-by-user': 'ปิดหน้าต่างเข้าสู่ระบบก่อนเสร็จ',
    'auth/network-request-failed': 'เชื่อมต่ออินเทอร์เน็ตไม่ได้', 'unavailable': 'เชื่อมต่อฐานข้อมูลไม่ได้ชั่วคราว'
  };
  return map[c] || (e && e.message) || String(e);
}
async function run(fn, text) {
  loading(true, text || 'กำลังดำเนินการ...');
  try { return await fn(); }
  catch (e) { console.error(e); toast(errMsg(e), 'bad'); throw e; }
  finally { loading(false); }
}
const quiet = p => p.catch(() => {});

function toDate(ts) { if (!ts) return null; if (ts.toDate) return ts.toDate(); const d = new Date(ts); return isNaN(d) ? null : d; }
const TM = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TMF = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function fmtTs(ts, withTime = true) {
  const d = toDate(ts); if (!d) return '';
  const s = d.getDate() + ' ' + TM[d.getMonth()] + ' ' + String(d.getFullYear() + 543).slice(-2);
  return withTime ? s + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' น.' : s;
}
function thaiDateFull(v) {
  let d = null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const [y, m, dd] = v.slice(0, 10).split('-').map(Number); d = new Date(y, m - 1, dd); }
  else d = toDate(v);
  return d ? d.getDate() + ' ' + TMF[d.getMonth()] + ' ' + (d.getFullYear() + 543) : '';
}
function isoToday() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
const codeHash = (sid, code) => sha256(lowerSid(sid) + '|' + String(code).trim().toUpperCase());
function genCode(n = 6) {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r).map(x => A[x % A.length]).join('');
}
const studentEmail = (sid, v) => lowerSid(sid) + (v ? '.v' + v : '') + '@' + STUDENT_EMAIL_DOMAIN;
const badge = st => `<span class="badge b-${ST_COLOR[st] || 'gray'}">${esc(ST_LABEL[st] || st)}</span>`;
const gradeChip = (g, cls = '') => `<span class="grade ${cls}">${esc(g === '' || g == null ? '–' : g)}</span>`;
const normName = s => { let x = String(s || '').trim(); for (let i = 0; i < 3; i++) x = x.replace(/^(นางสาว|นาง|นาย|น\.ส\.|ครู|ว่าที่\s*ร\.?ต\.?|ว่าที่ร้อยตรี|ดร\.|mr\.|mrs\.|ms\.)\s*/i, ''); return x.replace(/\s+/g, ''); };
const normGrade = g => { const s = String(g == null ? '' : g).trim().replace(/\s+/g, ''); return /^\d+(\.\d+)?$/.test(s) ? String(parseFloat(s)) : s; };
function download(name, text, mime = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: mime }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
const csv = rows => rows.map(r => r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');

/* ------------------------------ refs ------------------------------ */
const R = {
  settings: () => F.doc(db, 'config', 'settings'),
  meta: () => F.doc(db, 'config', 'meta'),
  counters: () => F.doc(db, 'config', 'counters'),
  staff: em => F.doc(db, 'staff', em),
  sig: em => F.doc(db, 'signatures', em),
  student: sid => F.doc(db, 'students', sid),
  ver: sid => F.doc(db, 'student_ver', sid),
  secret: sid => F.doc(db, 'student_secrets', sid),
  link: sid => F.doc(db, 'student_links', sid),
  term: id => F.doc(db, 'terms', id),
  course: id => F.doc(db, 'courses', id),
  req: id => F.doc(db, 'requests', id),
  memo: id => F.doc(db, 'memos', id),
  col: name => F.collection(db, name)
};
const snapList = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
function logRef(rid) { return F.doc(F.collection(db, 'requests', rid, 'logs')); }
function logData(action, detail, role) {
  return { at: F.serverTimestamp(), actor: S.me.email, actor_name: S.me.name, role: role || myRoleLabel(), action, detail: detail || '' };
}
function myRoleLabel() { return isStudent() ? 'นักเรียน' : (S.me.roles || []).map(r => ROLE_LABEL[r] || r).join('/') || 'บุคลากร'; }

/* ------------------------------ modal ------------------------------ */
function modal(html, opts = {}) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${opts.lg ? 'lg' : ''}" role="dialog">${html}</div>`;
  bg.addEventListener('mousedown', e => { if (e.target === bg && !opts.sticky) closeModal(); });
  $('#modal-root').appendChild(bg);
  $$('[data-close]', bg).forEach(b => b.onclick = closeModal);
  return bg;
}
function closeModal() {
  S.modalUnsubs.forEach(u => u()); S.modalUnsubs = [];
  $('#modal-root').innerHTML = '';
}
// กล่องยืนยันซ้อนบนหน้าต่างเดิม (ไม่ปิดหน้าคำร้องที่เปิดอยู่)
function confirmDlg(title, body, okText = 'ยืนยัน', cls = 'pri') {
  return new Promise(res => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg'; bg.style.zIndex = 160; bg.style.alignItems = 'center';
    bg.innerHTML = `<div class="modal" style="max-width:460px"><div class="modal-h"><h3>${esc(title)}</h3><button class="x" data-c>×</button></div>
      <div class="modal-b">${body}</div>
      <div class="modal-f"><button class="btn" data-c>ยกเลิก</button><button class="btn ${cls}" id="cf-ok">${esc(okText)}</button></div></div>`;
    document.body.appendChild(bg);
    const ld = $('#loading'); const wasLoading = !ld.classList.contains('hidden');
    ld.classList.add('hidden'); // ไม่ให้หน้าจอโหลดบังปุ่มยืนยัน
    const done = v => { bg.remove(); if (wasLoading && v) ld.classList.remove('hidden'); res(v); };
    $$('[data-c]', bg).forEach(b => b.onclick = () => done(false));
    $('#cf-ok', bg).onclick = () => done(true);
  });
}

/* =========================== เริ่มต้น / เข้าสู่ระบบ =========================== */
async function loadSettings() {
  try {
    const s = await F.getDoc(R.settings());
    if (s.exists()) S.settings = { ...DEFAULT_SETTINGS, ...s.data() };
  } catch (e) { console.warn('settings', e); }
}

async function handleUser(user) {
  stopLive();
  closeModal();
  ['_terms', '_termSel', '_memos', 'staffList', '_svCls', '_inboxTab'].forEach(k => S[k] = null);
  if (!user) { S.me = null; renderLogin(); return; }
  try {
    loading(true, 'กำลังเข้าสู่ระบบ...');
    await resolveMe(user);
    await loadSettings();
    startLive();
    renderShell();
  } catch (e) {
    console.error(e);
    const msg = e.noAccess ? null : errMsg(e);
    if (e.noAccess) { renderNoAccess(e.email); }
    else { await quiet(F.signOut(auth)); renderLogin(msg); }
  } finally { loading(false); }
}

async function resolveMe(user) {
  const em = String(user.email || '').toLowerCase();
  if (em.endsWith('@' + STUDENT_EMAIL_DOMAIN)) {
    const sid = em.split('@')[0].split('.')[0];
    const link = await F.getDoc(R.link(sid));
    if (!link.exists() || link.data().uid !== user.uid) throw new Error('บัญชีนี้ยังไม่ได้เปิดใช้งาน หรือถูกรีเซ็ตแล้ว กรุณาเปิดใช้งานด้วยรหัสเริ่มต้นใหม่');
    const st = await F.getDoc(R.student(sid));
    const d = st.exists() ? st.data() : {};
    if (d.active === false) throw new Error('บัญชีนักเรียนถูกระงับ');
    S.me = { type: 'student', sid, email: em, name: d.name || sid, cls: d.class || '', number: d.number || '', roles: ['student'] };
    return;
  }
  if (!user.emailVerified) throw new Error('อีเมลนี้ยังไม่ได้รับการยืนยัน');
  let sd = await F.getDoc(R.staff(em));
  if (!sd.exists() && em === BOOTSTRAP_ADMIN.toLowerCase()) {
    await F.setDoc(R.staff(em), { name: user.displayName || 'ผู้ดูแลระบบ', position: 'ผู้ดูแลระบบ', department: '', roles: ['admin'], active: true, created_at: F.serverTimestamp() });
    const st = await F.getDoc(R.settings());
    if (!st.exists()) await F.setDoc(R.settings(), DEFAULT_SETTINGS);
    sd = await F.getDoc(R.staff(em));
  }
  if (!sd.exists() || sd.data().active === false) { const e = new Error('no access'); e.noAccess = true; e.email = em; throw e; }
  const d = sd.data();
  const sig = await F.getDoc(R.sig(em));
  S.me = { type: 'staff', email: em, name: d.name, position: d.position || '', department: d.department || '', roles: d.roles || [], has_signature: sig.exists() };
}

function renderLogin(msg) {
  closeModal();
  const sn = esc(S.settings.school_name || '');
  $('#app').innerHTML = `
  <div class="login-wrap"><div class="login">
    <div class="center" style="margin-bottom:14px">
      <div class="brand" style="justify-content:center"><div class="logo">✎</div></div>
      <h2>ระบบยื่นคำร้องแก้ไขผลการเรียน</h2>
      <div class="muted">${sn}</div>
    </div>
    <div class="card">
      <div class="seg"><button id="t-stu" class="on">นักเรียน</button><button id="t-staff">ครู / บุคลากร</button></div>
      ${msg ? `<div class="alert bad small" style="margin-bottom:12px">${esc(msg)}</div>` : ''}
      <div id="login-body"></div>
    </div>
    <div class="center small muted" style="margin-top:12px">ผล 0 · ร · มส · มผ — ยื่นคำร้อง ติดตามสถานะ และส่งงานออนไลน์</div>
  </div></div>`;
  const tabs = { stu: $('#t-stu'), staff: $('#t-staff') };
  const show = which => { tabs.stu.classList.toggle('on', which === 'stu'); tabs.staff.classList.toggle('on', which === 'staff'); which === 'stu' ? stuLoginForm() : staffLoginForm(); };
  tabs.stu.onclick = () => show('stu'); tabs.staff.onclick = () => show('staff');
  show('stu');
}

function stuLoginForm() {
  $('#login-body').innerHTML = `
    <form id="f-login">
      <label class="f"><span>เลขประจำตัวนักเรียน</span><input class="in" name="sid" inputmode="numeric" autocomplete="username" required></label>
      <label class="f"><span>รหัสผ่าน</span><input class="in" type="password" name="pw" autocomplete="current-password" required></label>
      <button class="btn pri" style="width:100%;justify-content:center">เข้าสู่ระบบ</button>
    </form>
    <div class="center" style="margin-top:12px"><a href="#" id="go-act">เข้าใช้ครั้งแรก / ได้รับรหัสเริ่มต้นใหม่</a></div>
    <div class="center small muted" style="margin-top:6px">ลืมรหัสผ่าน ติดต่อครูที่ปรึกษาหรืองานวัดผลเพื่อขอรหัสเริ่มต้นใหม่</div>`;
  $('#go-act').onclick = e => { e.preventDefault(); stuActivateForm(); };
  $('#f-login').onsubmit = async e => {
    e.preventDefault();
    const f = e.target; const sid = lowerSid(f.sid.value);
    await quiet(run(async () => {
      const v = await getVer(sid);
      await F.signInWithEmailAndPassword(auth, studentEmail(sid, v), f.pw.value);
    }, 'กำลังเข้าสู่ระบบ...'));
  };
}

async function getVer(sid) {
  const s = await F.getDoc(R.ver(sid));
  if (!s.exists()) throw new Error('ไม่พบเลขประจำตัวนี้ในระบบ');
  return Number(s.data().v || 0);
}

function stuActivateForm() {
  $('#login-body').innerHTML = `
    <div class="alert info small" style="margin-bottom:12px">ใช้ <b>รหัสเริ่มต้น 6 ตัว</b> ที่ได้รับจากครู แล้วตั้งรหัสผ่านของตัวเอง</div>
    <form id="f-act">
      <label class="f"><span>เลขประจำตัวนักเรียน</span><input class="in" name="sid" inputmode="numeric" required></label>
      <label class="f"><span>รหัสเริ่มต้น</span><input class="in" name="code" style="text-transform:uppercase;letter-spacing:.15em" required></label>
      <label class="f"><span>ตั้งรหัสผ่านใหม่ (อย่างน้อย 6 ตัว)</span><input class="in" type="password" name="pw" minlength="6" autocomplete="new-password" required></label>
      <label class="f"><span>ยืนยันรหัสผ่านใหม่</span><input class="in" type="password" name="pw2" minlength="6" autocomplete="new-password" required></label>
      <button class="btn pri" style="width:100%;justify-content:center">เปิดใช้งานบัญชี</button>
    </form>
    <div class="center" style="margin-top:12px"><a href="#" id="go-login">← กลับไปหน้าเข้าสู่ระบบ</a></div>`;
  $('#go-login').onclick = e => { e.preventDefault(); stuLoginForm(); };
  $('#f-act').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    if (f.pw.value !== f.pw2.value) return toast('รหัสผ่านทั้งสองช่องไม่ตรงกัน', 'bad');
    await quiet(run(() => activateStudent(lowerSid(f.sid.value), f.code.value, f.pw.value), 'กำลังเปิดใช้งาน...'));
  };
}

async function activateStudent(sid, code, pw) {
  const v = await getVer(sid);
  S.activating = true;
  let cred;
  try {
    try { cred = await F.createUserWithEmailAndPassword(auth, studentEmail(sid, v), pw); }
    catch (e) {
      if (e.code === 'auth/email-already-in-use') throw new Error('บัญชีนี้เปิดใช้งานแล้ว ให้เข้าสู่ระบบด้วยรหัสผ่านที่ตั้งไว้ หากลืมรหัสผ่านให้ติดต่อครูเพื่อขอรหัสเริ่มต้นใหม่');
      throw e;
    }
    try {
      await F.setDoc(R.link(sid), { uid: cred.user.uid, h: await codeHash(sid, code), at: F.serverTimestamp() });
    } catch (e) {
      await quiet(F.deleteUser(cred.user));
      throw new Error('รหัสเริ่มต้นไม่ถูกต้อง');
    }
  } finally { S.activating = false; }
  toast('เปิดใช้งานบัญชีเรียบร้อย', 'ok');
  await handleUser(auth.currentUser);
}

function staffLoginForm() {
  $('#login-body').innerHTML = `
    <p class="muted small" style="margin-top:0">บุคลากรเข้าสู่ระบบด้วยบัญชี Google ที่ผู้ดูแลระบบลงทะเบียนไว้ (อีเมลโรงเรียนหรือ Gmail)</p>
    <button class="btn" id="g-login" style="width:100%;justify-content:center;padding:11px">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>
      เข้าสู่ระบบด้วย Google</button>`;
  $('#g-login').onclick = () => quiet(run(() => F.signInWithPopup(auth, new F.GoogleAuthProvider()), 'กำลังเข้าสู่ระบบ...'));
}

function renderNoAccess(em) {
  $('#app').innerHTML = `<div class="login-wrap"><div class="login"><div class="card center">
    <h3>ยังไม่มีสิทธิ์เข้าใช้งาน</h3>
    <p class="muted">บัญชี <b>${esc(em)}</b> ยังไม่ได้ลงทะเบียนเป็นบุคลากร<br>กรุณาแจ้งผู้ดูแลระบบให้เพิ่มอีเมลนี้ในเมนู "บุคลากร/สิทธิ์"</p>
    <button class="btn" id="na-out">ออกจากระบบ</button></div></div></div>`;
  $('#na-out').onclick = () => F.signOut(auth);
}

/* =========================== ข้อมูลเรียลไทม์ =========================== */
function stopLive() { S.liveUnsubs.forEach(u => u()); S.liveUnsubs = []; S.live = {}; }
function liveSub(key, q) {
  const u = F.onSnapshot(q, s => {
    S.live[key] = snapList(s);
    renderNav();
    if (VIEW_DEPS[S.view] && VIEW_DEPS[S.view].includes(key)) renderView(true);
  }, e => console.warn('live ' + key, e));
  S.liveUnsubs.push(u);
}
function startLive() {
  const rq = R.col('requests');
  if (isStudent()) { liveSub('mine', F.query(rq, F.where('student_id', '==', S.me.sid))); return; }
  liveSub('teacher', F.query(rq, F.where('teacher_email', '==', S.me.email)));
  if (hasRole('measure')) liveSub('measure', F.query(rq, F.where('status', '==', 'TEACHER_APPROVED')));
  if (hasRole('academic')) liveSub('academic', F.query(rq, F.where('status', 'in', ['MEASURE_APPROVED', 'ACADEMIC_APPROVED'])));
  if (hasRole('director')) liveSub('memosPending', F.query(R.col('memos'), F.where('status', '==', 'PENDING')));
}
const VIEW_DEPS = { grades: ['mine'], myreq: ['mine'], inbox: ['teacher'], measure: ['measure'], academic: ['academic'], memos: ['academic'], director: ['memosPending'] };

function counts() {
  const L = S.live;
  return {
    inbox: (L.teacher || []).filter(r => ['SUBMITTED', 'WORK_SUBMITTED', 'RETURNED'].includes(r.status)).length,
    measure: (L.measure || []).length,
    academic: (L.academic || []).filter(r => r.status === 'MEASURE_APPROVED').length,
    memos: (L.academic || []).filter(r => r.status === 'ACADEMIC_APPROVED').length,
    director: (L.memosPending || []).length,
    myreq: (L.mine || []).filter(r => ['ASSIGNED', 'REVISE'].includes(r.status)).length
  };
}

/* =========================== Shell / navigation =========================== */
const NAV = [
  { sec: 'นักเรียน', roles: ['student'] },
  { id: 'grades', label: 'ผลการเรียนของฉัน', ico: '📘', roles: ['student'] },
  { id: 'myreq', label: 'คำร้องของฉัน', ico: '📝', roles: ['student'], cnt: 'myreq' },
  { id: 'spw', label: 'เปลี่ยนรหัสผ่าน', ico: '🔑', roles: ['student'] },
  { sec: 'งานของฉัน', staff: true },
  { id: 'dash', label: 'ภาพรวม', ico: '📊', staff: true },
  { id: 'inbox', label: 'คำร้องถึงครู', ico: '📥', staff: true, cnt: 'inbox' },
  { id: 'measure', label: 'รอตรวจ (งานวัดผล)', ico: '✅', roles: ['measure'], cnt: 'measure' },
  { id: 'academic', label: 'รอตรวจ (วิชาการ)', ico: '🏫', roles: ['academic'], cnt: 'academic' },
  { id: 'memos', label: 'บันทึกข้อความ', ico: '📄', roles: ['academic', 'director', 'measure', 'admin'], cnt: 'memos' },
  { id: 'director', label: 'รอ ผอ. อนุมัติ', ico: '✍️', roles: ['director'], cnt: 'director' },
  { id: 'all', label: 'ติดตามคำร้องทั้งหมด', ico: '🔎', roles: ['measure', 'academic', 'director', 'admin'] },
  { id: 'signature', label: 'ลายเซ็นของฉัน', ico: '🖊️', staff: true },
  { sec: 'จัดการข้อมูล', roles: ['admin', 'measure'] },
  { id: 'import', label: 'นำเข้าผลการเรียน', ico: '⬆️', roles: ['admin', 'measure'] },
  { id: 'students', label: 'นักเรียน / รหัสเริ่มต้น', ico: '🎓', roles: ['admin', 'measure'] },
  { id: 'courses', label: 'รายวิชา–ครูผู้สอน', ico: '📚', roles: ['admin', 'measure'] },
  { id: 'users', label: 'บุคลากร / สิทธิ์', ico: '👥', roles: ['admin'] },
  { id: 'settings', label: 'ตั้งค่าระบบ', ico: '⚙️', roles: ['admin'] }
];
const navVisible = n => n.staff ? !isStudent() : (n.roles || []).some(hasRole);

function renderShell() {
  const first = isStudent() ? 'grades' : 'dash';
  const fromHash = location.hash.replace('#', '');
  S.view = NAV.find(n => n.id === fromHash && navVisible(n)) ? fromHash : first;
  $('#app').innerHTML = `
  <div class="shell">
    <aside class="side" id="side">
      <div class="brand"><div class="logo">✎</div><div>แก้ไขผลการเรียน<small>${esc(S.settings.school_name)}</small></div></div>
      <nav class="nav" id="nav"></nav>
    </aside>
    <main class="main">
      <div class="top">
        <div class="row"><button class="btn sm menu-btn" id="menu-btn">☰</button><h2 id="view-title"></h2></div>
        <div class="user">
          <div class="right small"><b>${esc(S.me.name)}</b><div class="muted">${esc(isStudent() ? ('นักเรียน ' + S.me.cls) : (S.me.position || myRoleLabel()))}</div></div>
          <div class="avatar">${esc((S.me.name || '?').replace(/^(นาย|นางสาว|นาง|ด\.ช\.|ด\.ญ\.)/, '').trim().charAt(0))}</div>
          <button class="btn sm" id="logout">ออก</button>
        </div>
      </div>
      <div id="view"></div>
    </main>
  </div>`;
  $('#logout').onclick = async () => { if (await confirmDlg('ออกจากระบบ', 'ต้องการออกจากระบบใช่ไหม', 'ออกจากระบบ')) { location.hash = ''; F.signOut(auth); } };
  $('#menu-btn').onclick = () => $('#side').classList.toggle('open');
  renderNav();
  renderView();
}

function renderNav() {
  const nav = $('#nav'); if (!nav) return;
  const c = counts();
  nav.innerHTML = NAV.filter(navVisible).map(n => n.sec
    ? `<div class="sec">${esc(n.sec)}</div>`
    : `<a data-v="${n.id}" class="${S.view === n.id ? 'on' : ''}"><span class="ico">${n.ico}</span>${esc(n.label)}${n.cnt && c[n.cnt] ? `<span class="cnt">${c[n.cnt]}</span>` : ''}</a>`).join('');
  $$('a[data-v]', nav).forEach(a => a.onclick = () => go(a.dataset.v));
}
function go(v) { S.view = v; location.hash = v; $('#side') && $('#side').classList.remove('open'); renderNav(); renderView(); }

function renderView(isLiveRefresh) {
  const n = NAV.find(x => x.id === S.view);
  if (!isLiveRefresh) { S.viewUnsubs.forEach(u => u()); S.viewUnsubs = []; }
  $('#view-title').textContent = n ? n.label : '';
  const fn = VIEWS[S.view];
  if (!fn) { $('#view').innerHTML = '<div class="empty">ไม่พบหน้า</div>'; return; }
  Promise.resolve(fn(isLiveRefresh)).catch(e => { console.error(e); $('#view').innerHTML = `<div class="alert bad">${esc(errMsg(e))}</div>`; });
}

/* =========================== ตารางคำร้อง =========================== */
function reqTable(rows, opts = {}) {
  if (!rows.length) return `<div class="empty">${opts.empty || 'ไม่มีรายการ'}</div>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>
    ${opts.check ? '<th><input type="checkbox" id="chk-all"></th>' : ''}
    <th>เลขคำร้อง</th>${opts.noStudent ? '' : '<th>นักเรียน</th><th>ชั้น</th>'}<th>รายวิชา</th><th>ผลเดิม</th><th>ผลใหม่</th>${opts.noTeacher ? '' : '<th>ครูผู้สอน</th>'}<th>สถานะ</th><th>อัปเดต</th>
  </tr></thead><tbody>${rows.map(r => `
    <tr class="click" data-rid="${esc(r.id)}">
      ${opts.check ? `<td onclick="event.stopPropagation()"><input type="checkbox" class="chk-row" value="${esc(r.id)}"></td>` : ''}
      <td><b>${esc(r.request_no)}</b>${r.seq > 1 ? `<div class="small muted">ครั้งที่ ${r.seq}</div>` : ''}</td>
      ${opts.noStudent ? '' : `<td>${esc(r.student_name)}<div class="small muted">${esc(r.student_id)}</div></td><td>${esc(r.class)}</td>`}
      <td>${esc(r.subject_code)}<div class="small muted">${esc(r.subject_name)}</div></td>
      <td>${gradeChip(r.original_grade, 'fail')}</td><td>${r.new_grade ? gradeChip(r.new_grade, 'fixed') : '<span class="muted">–</span>'}</td>
      ${opts.noTeacher ? '' : `<td class="small">${esc(r.teacher_name || '') || '<span class="badge b-red">ยังไม่มีครู</span>'}</td>`}
      <td>${badge(r.status)}${r.due_date && ['ASSIGNED', 'REVISE'].includes(r.status) ? `<div class="small ${r.due_date < isoToday() ? 'muted' : 'muted'}">ส่งภายใน ${esc(fmtTs(r.due_date, false))}${r.due_date < isoToday() ? ' <span class="badge b-red">เลยกำหนด</span>' : ''}</div>` : ''}</td>
      <td class="small muted">${esc(fmtTs(r.updated_at))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}
function bindReqTable(root) {
  $$('tr[data-rid]', root).forEach(tr => tr.onclick = () => openRequest(tr.dataset.rid));
  const all = $('#chk-all', root);
  if (all) all.onchange = () => $$('.chk-row', root).forEach(c => c.checked = all.checked);
}
const byUpdated = rows => rows.slice().sort((a, b) => (toDate(b.updated_at) || 0) - (toDate(a.updated_at) || 0));

/* =========================== หน้า: นักเรียน =========================== */
const VIEWS = {};

VIEWS.grades = async (live) => {
  const v = $('#view');
  if (!live || !S._terms) {
    if (!live) v.innerHTML = '<div class="empty">กำลังโหลดผลการเรียน...</div>';
    const s = await F.getDocs(F.query(R.col('terms'), F.where('student_id', '==', S.me.sid)));
    S._terms = snapList(s).sort((a, b) => (b.academic_year + b.semester).localeCompare(a.academic_year + a.semester));
  }
  const terms = S._terms;
  const mine = S.live.mine || [];
  if (!terms.length) { v.innerHTML = '<div class="card empty">ยังไม่มีข้อมูลผลการเรียนในระบบ</div>'; return; }
  const sel = S._termSel && terms.find(t => t.id === S._termSel) ? S._termSel : terms[0].id;
  S._termSel = sel;
  const fail = failSet();
  const maxAtt = Number(S.settings.max_attempts || 2);
  const allFails = [];
  const termRows = t => Object.keys(t.subjects || {}).map(code => {
    const sub = t.subjects[code];
    const gk = t.academic_year + '_' + t.semester + '_' + S.me.sid + '_' + code;
    const rs = mine.filter(r => r.grade_key === gk).sort((a, b) => b.seq - a.seq);
    const completed = rs.find(r => r.status === 'COMPLETED');
    const active = rs.find(r => ACTIVE.includes(r.status));
    const failed = rs.filter(r => r.status === 'FAILED').length;
    const grade = completed ? completed.new_grade : sub.grade;
    const isFail = fail.includes(grade);
    return { code, sub, gk, rs, completed, active, failed, grade, isFail, t,
      canReq: isFail && !active && !completed && failed < maxAtt && (!rs[0] || TERMINAL_RETRY.includes(rs[0].status)) };
  }).sort((a, b) => (b.isFail - a.isFail) || a.code.localeCompare(b.code));
  terms.forEach(x => termRows(x).forEach(r => { if (r.isFail) allFails.push(r); }));
  const t = terms.find(x => x.id === sel);
  const rows = termRows(t);
  let cr = 0, pt = 0;
  rows.forEach(r => { const c = parseFloat(r.sub.credit); if (/^[0-4](\.5)?$/.test(r.grade) && c > 0) { cr += c; pt += c * parseFloat(r.grade); } });
  const gpa = cr ? (Math.floor(pt / cr * 100) / 100).toFixed(2) : '-';
  v.innerHTML = `
    ${allFails.length ? `<div class="alert bad" style="margin-bottom:14px"><b>คุณมีผลการเรียนที่ต้องแก้ไข ${allFails.length} รายวิชา</b>
      <div class="small">${allFails.map(r => `${esc(r.code)} ${esc(r.sub.name || '')} (${esc(r.grade)}) — ภาคเรียนที่ ${esc(r.t.semester)}/${esc(r.t.academic_year)}${r.active ? ' · ' + esc(ST_LABEL[r.active.status]) : ''}`).join('<br>')}</div></div>`
      : `<div class="alert ok" style="margin-bottom:14px">ไม่มีผลการเรียนที่ต้องแก้ไข 🎉</div>`}
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <div class="tabs" style="margin:0">${terms.map(x => `<button class="tab ${x.id === sel ? 'on' : ''}" data-t="${esc(x.id)}">ภาคเรียนที่ ${esc(x.semester)}/${esc(x.academic_year)}</button>`).join('')}</div>
        <div class="small muted">เกรดเฉลี่ย (เฉพาะรายวิชาที่มีผลเป็นตัวเลข) <b style="font-size:1.1rem;color:var(--ink)">${gpa}</b></div>
      </div>
      <div class="small muted" style="margin-bottom:8px">${esc(S.me.name)} · เลขประจำตัว ${esc(S.me.sid)} · ชั้น ${esc(t.class || S.me.cls)}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>รหัสวิชา</th><th>รายวิชา</th><th>หน่วยกิต</th><th>ผลการเรียน</th><th>สถานะ/การดำเนินการ</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.isFail ? 'fail' : ''}">
        <td><b>${esc(r.code)}</b></td><td>${esc(r.sub.name || '')}<div class="small muted">${esc(r.sub.teacher_name || '')}</div></td>
        <td>${esc(r.sub.credit || '')}</td>
        <td>${r.completed ? `${gradeChip(r.completed.original_grade, 'fail')} → ${gradeChip(r.grade, 'fixed')}` : gradeChip(r.grade, r.isFail ? 'fail' : '')}</td>
        <td>${r.active ? `<a href="#" data-open="${esc(r.active.id)}">${badge(r.active.status)}</a>`
          : r.canReq ? `<button class="btn sm pri" data-req="${esc(r.code)}">ยื่นคำร้องแก้ไข</button>${r.failed ? `<div class="small muted">เหลือสิทธิ์ ${maxAtt - r.failed} ครั้ง</div>` : ''}`
          : r.completed ? `<span class="badge b-green">แก้ไขแล้ว</span>`
          : r.isFail ? `<span class="small muted">ยื่นครบจำนวนครั้งแล้ว ติดต่องานวัดผล</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>
    </div>`;
  $$('[data-t]', v).forEach(b => b.onclick = () => { S._termSel = b.dataset.t; VIEWS.grades(true); });
  $$('[data-open]', v).forEach(a => a.onclick = e => { e.preventDefault(); openRequest(a.dataset.open); });
  $$('[data-req]', v).forEach(b => b.onclick = () => newRequestDlg(rows.find(r => r.code === b.dataset.req)));
};

function newRequestDlg(row) {
  const g = row.grade;
  const m = modal(`<div class="modal-h"><h3>ยื่นคำร้องขอแก้ไขผลการเรียน</h3><button class="x" data-close>×</button></div>
    <div class="modal-b">
      <div class="kv" style="margin-bottom:12px">
        <div>รายวิชา</div><div><b>${esc(row.code)}</b> ${esc(row.sub.name || '')}</div>
        <div>ภาคเรียน</div><div>${esc(row.t.semester)}/${esc(row.t.academic_year)}</div>
        <div>ผลการเรียนเดิม</div><div>${gradeChip(g, 'fail')} ${esc(REQ_TYPE[g] || '')}</div>
        <div>ครั้งที่ยื่น</div><div>${row.failed + 1}</div>
      </div>
      <label class="f"><span>เหตุผล / รายละเอียดที่ขอแก้ไข</span><textarea class="in" id="nr-reason" placeholder="เช่น ขอสอบแก้ตัว / ขอส่งงานที่ค้าง ... "></textarea></label>
      <div class="small muted">คำร้องจะส่งถึงครูผู้สอนโดยตรง และติดตามสถานะได้ที่เมนู "คำร้องของฉัน"</div>
    </div>
    <div class="modal-f"><button class="btn" data-close>ยกเลิก</button><button class="btn pri" id="nr-ok">ส่งคำร้อง</button></div>`);
  $('#nr-ok', m).onclick = () => quiet(run(async () => {
    const reason = $('#nr-reason', m).value.trim();
    if (!reason) throw new Error('กรุณาระบุเหตุผล');
    const t = row.t;
    const seq = (row.rs[0] ? row.rs[0].seq : 0) + 1;
    const courseId = t.academic_year + '_' + t.semester + '_' + row.code + '_' + classKey(t.class);
    let teacher_email = '', teacher_name = row.sub.teacher_name || '', course_id = '';
    const c = await F.getDoc(R.course(courseId));
    if (c.exists() && c.data().teacher_email) { teacher_email = c.data().teacher_email; teacher_name = c.data().teacher_name || teacher_name; course_id = courseId; }
    else if (row.sub.teacher_email) { teacher_email = row.sub.teacher_email; }
    if (c.exists()) course_id = courseId;
    const id = row.gk + '_' + seq;
    const d = new Date();
    const no = 'RQ' + String(d.getFullYear() + 543).slice(-2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '-' + genCode(4);
    const b = F.writeBatch(db);
    b.set(R.req(id), {
      request_no: no, grade_key: row.gk, term_id: t.id, course_id, seq, academic_year: t.academic_year, semester: t.semester,
      student_id: S.me.sid, student_name: S.me.name, class: t.class || S.me.cls, subject_code: row.code,
      subject_name: row.sub.name || '', credit: String(row.sub.credit || ''), original_grade: g,
      request_type: REQ_TYPE[g] || ('แก้ผลการเรียน ' + g), reason, teacher_email, teacher_name, status: 'SUBMITTED',
      assignment: '', due_date: '', new_grade: '', teacher_comment: '', measure_comment: '', academic_comment: '',
      director_comment: '', memo_id: '', memo_no: '', work_note: '', files_count: 0, signs: {},
      created_at: F.serverTimestamp(), updated_at: F.serverTimestamp()
    });
    b.set(logRef(id), logData('ยื่นคำร้อง', (REQ_TYPE[g] || g) + ' — ' + reason, 'นักเรียน'));
    await b.commit();
    closeModal(); toast('ส่งคำร้องเรียบร้อย ' + no, 'ok');
  }, 'กำลังส่งคำร้อง...'));
}

VIEWS.myreq = () => {
  const rows = byUpdated(S.live.mine || []);
  $('#view').innerHTML = `<div class="card">${reqTable(rows, { noStudent: true, empty: 'ยังไม่มีคำร้อง — ยื่นได้จากเมนู "ผลการเรียนของฉัน"' })}</div>`;
  bindReqTable($('#view'));
};

VIEWS.spw = () => {
  $('#view').innerHTML = `<div class="card" style="max-width:440px"><form id="f-pw">
    <label class="f"><span>รหัสผ่านเดิม</span><input class="in" type="password" name="old" required></label>
    <label class="f"><span>รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)</span><input class="in" type="password" name="n1" minlength="6" required></label>
    <label class="f"><span>ยืนยันรหัสผ่านใหม่</span><input class="in" type="password" name="n2" minlength="6" required></label>
    <button class="btn pri">บันทึกรหัสผ่านใหม่</button></form></div>`;
  $('#f-pw').onsubmit = e => {
    e.preventDefault(); const f = e.target;
    if (f.n1.value !== f.n2.value) return toast('รหัสผ่านใหม่ไม่ตรงกัน', 'bad');
    quiet(run(async () => {
      const u = auth.currentUser;
      await F.reauthenticateWithCredential(u, F.EmailAuthProvider.credential(u.email, f.old.value));
      await F.updatePassword(u, f.n1.value);
      f.reset(); toast('เปลี่ยนรหัสผ่านเรียบร้อย', 'ok');
    }));
  };
};

/* =========================== รายละเอียดคำร้อง =========================== */
function canFlags(r) {
  const own = isStudent() && r.student_id === S.me.sid;
  const isT = !isStudent() && !!r.teacher_email && r.teacher_email === S.me.email;
  const s = r.status;
  return {
    cancel: own && s === 'SUBMITTED',
    upload_student: own && ['ASSIGNED', 'REVISE', 'WORK_SUBMITTED'].includes(s),
    upload_teacher: isT && WORKING.includes(s),
    assign: isT && (s === 'SUBMITTED' || WORKING.includes(s)),
    reject: isT && s === 'SUBMITTED',
    review: isT && WORKING.includes(s),
    measure: hasRole('measure') && s === 'TEACHER_APPROVED',
    academic: hasRole('academic') && s === 'MEASURE_APPROVED',
    set_teacher: !isStudent() && dataAdmin() && ['SUBMITTED', ...WORKING].includes(s)
  };
}

function openRequest(rid) {
  const st = { r: null, logs: [], files: [] };
  const m = modal(`<div class="modal-h"><h3 id="rq-title">คำร้อง</h3><button class="x" data-close>×</button></div><div class="modal-b" id="rq-body"><div class="empty">กำลังโหลด...</div></div>`, { lg: true });
  const draw = () => { if (st.r) drawRequest(m, st); };
  S.modalUnsubs.push(F.onSnapshot(R.req(rid), s => { if (!s.exists()) return; st.r = { id: s.id, ...s.data() }; draw(); }, e => { $('#rq-body', m).innerHTML = `<div class="alert bad">${esc(errMsg(e))}</div>`; }));
  S.modalUnsubs.push(F.onSnapshot(F.collection(db, 'requests', rid, 'logs'), s => { st.logs = snapList(s).sort((a, b) => (toDate(a.at) || 0) - (toDate(b.at) || 0)); draw(); }, () => {}));
  S.modalUnsubs.push(F.onSnapshot(F.collection(db, 'requests', rid, 'files'), s => { st.files = snapList(s).sort((a, b) => (toDate(a.uploaded_at) || 0) - (toDate(b.uploaded_at) || 0)); draw(); }, () => {}));
}

function stepper(status) {
  const stop = ['FAILED', 'REJECTED', 'CANCELLED'].includes(status);
  const done = STEP_DONE[status] || 0;
  return `<div class="steps">${STEPS.map((s, i) => {
    const cls = stop && i === Math.max(done, 1) ? 'stop' : (i < done ? 'done' : (i === done && !stop ? 'cur' : ''));
    return `<div class="step ${cls}"><div class="dot">${i < done ? '✓' : (cls === 'stop' ? '✕' : i + 1)}</div>${s}</div>`;
  }).join('')}</div>`;
}

function drawRequest(m, st) {
  const r = st.r, can = canFlags(r);
  const body = $('#rq-body', m);
  // จำค่าที่พิมพ์ค้างไว้ไม่ให้หายตอนข้อมูลอัปเดต
  const keep = {}; $$('textarea,input,select', body).forEach(el => { if (el.id) keep[el.id] = el.value; });
  $('#rq-title', m).innerHTML = `คำร้อง ${esc(r.request_no)} ${badge(r.status)}`;
  const sg = r.signs || {};
  const signChip = (k, label) => sg[k] ? `<div class="sigchip">✓ ${label}: ${esc(sg[k].name)}<div class="small">${esc(fmtTs(sg[k].at))}</div></div>` : '';
  const allowed = (S.settings.allowed || DEFAULT_SETTINGS.allowed)[r.original_grade] || [];
  body.innerHTML = `
    ${stepper(r.status)}
    <div class="grid g2">
      <div class="kv">
        <div>นักเรียน</div><div><b>${esc(r.student_name)}</b> (${esc(r.student_id)}) ชั้น ${esc(r.class)}</div>
        <div>รายวิชา</div><div><b>${esc(r.subject_code)}</b> ${esc(r.subject_name)} ${r.credit ? '(' + esc(r.credit) + ' นก.)' : ''}</div>
        <div>ภาคเรียน</div><div>${esc(r.semester)}/${esc(r.academic_year)} · ยื่นครั้งที่ ${esc(r.seq)}</div>
        <div>ผลการเรียน</div><div>${gradeChip(r.original_grade, 'fail')} ${r.new_grade ? '→ ' + gradeChip(r.new_grade, 'fixed') : ''} <span class="small muted">${esc(r.request_type)}</span></div>
        <div>ครูผู้สอน</div><div>${esc(r.teacher_name) || '<span class="badge b-red">ยังไม่กำหนด</span>'}</div>
        <div>ยื่นเมื่อ</div><div>${esc(fmtTs(r.created_at))}</div>
        ${r.memo_no ? `<div>บันทึกข้อความ</div><div>ที่ ${esc(r.memo_no)}</div>` : ''}
      </div>
      <div>
        <div class="box"><div class="small muted">เหตุผลของนักเรียน</div>${esc(r.reason)}</div>
        ${r.assignment ? `<div class="box" style="margin-top:8px;background:var(--warn-2);border-color:#fde68a"><div class="small muted">งานที่ครูมอบหมาย${r.due_date ? ' · กำหนดส่ง ' + esc(thaiDateFull(r.due_date)) : ''}</div>${esc(r.assignment)}</div>` : ''}
        ${['teacher_comment:ความเห็นครู', 'measure_comment:ความเห็นงานวัดผล', 'academic_comment:ความเห็นวิชาการ', 'director_comment:ความเห็น ผอ.'].map(x => { const [k, l] = x.split(':'); return r[k] ? `<div class="box" style="margin-top:8px"><div class="small muted">${l}</div>${esc(r[k])}</div>` : ''; }).join('')}
      </div>
    </div>
    ${Object.keys(sg).length ? `<h4 style="margin:16px 0 8px">ลงนามอิเล็กทรอนิกส์</h4><div class="signs">${signChip('teacher', 'ครูผู้สอน')}${signChip('measure', 'งานวัดผล')}${signChip('academic', 'วิชาการ')}</div>` : ''}
    <h4 style="margin:16px 0 8px">ไฟล์งาน / หลักฐาน (${st.files.length})</h4>
    <div class="files">${st.files.length ? st.files.map(f => `<div class="file"><span>${f.uploader_role === 'teacher' ? '👩‍🏫' : '🎓'}</span><span class="nm" title="${esc(f.file_name)}">${esc(f.file_name)}<div class="small muted">${esc(fmtTs(f.uploaded_at))} · ${(Number(f.size || 0) / 1024 / 1024).toFixed(2)} MB${f.note ? ' · ' + esc(f.note) : ''}</div></span><button class="btn sm" data-dl="${esc(f.id)}">เปิด</button></div>`).join('') : '<div class="muted small">ยังไม่มีไฟล์</div>'}</div>
    <div id="rq-actions">${actionPanel(r, can, allowed)}</div>
    <h4 style="margin:18px 0 8px">ประวัติการดำเนินการ</h4>
    <ul class="tl">${st.logs.map(l => `<li><div><b>${esc(l.action)}</b> — ${esc(l.actor_name)} <span class="small muted">(${esc(l.role)})</span></div>${l.detail ? `<div class="small">${esc(l.detail)}</div>` : ''}<div class="t">${esc(fmtTs(l.at))}</div></li>`).join('')}</ul>`;
  Object.keys(keep).forEach(id => { const el = $('#' + id, body); if (el && el.type !== 'file') el.value = keep[id]; });
  $$('[data-dl]', body).forEach(b => b.onclick = () => openFile(r.id, st.files.find(f => f.id === b.dataset.dl)));
  bindActions(body, r, can);
}

function actionPanel(r, can, allowed) {
  const out = [];
  if (can.cancel) out.push(`<div class="row"><button class="btn bad" id="a-cancel">ยกเลิกคำร้อง</button></div>`);
  if (can.upload_student || can.upload_teacher) out.push(`
    <div class="card" style="margin-top:12px"><h3>${can.upload_student ? 'ส่งงาน' : 'แนบไฟล์ (ครู)'}</h3>
      <input type="file" id="a-files" multiple class="in">
      <label class="f" style="margin-top:8px"><span>หมายเหตุ</span><input class="in" id="a-fnote" placeholder="${can.upload_student ? 'เช่น ส่งงานครั้งที่ 1' : 'เช่น แบบทดสอบแก้ตัว'}"></label>
      <div class="small muted">ขนาดไม่เกิน ${esc(S.settings.max_upload_mb || 10)} MB ต่อไฟล์ · ไฟล์จะเก็บใน Google Drive ของโรงเรียน</div>
      <button class="btn pri" id="a-upload" style="margin-top:8px">${can.upload_student ? 'ส่งงาน' : 'แนบไฟล์'}</button></div>`);
  if (can.set_teacher) out.push(`
    <div class="card" style="margin-top:12px"><h3>กำหนดครูผู้สอน</h3><div class="row"><select class="in grow" id="a-teacher"><option value="">-- เลือกครู --</option></select><button class="btn" id="a-setT">บันทึก</button></div></div>`);
  if (can.assign) out.push(`
    <div class="card" style="margin-top:12px"><h3>${r.status === 'SUBMITTED' ? 'รับคำร้องและมอบหมายงาน' : 'แก้ไขงานที่มอบหมาย'}</h3>
      <label class="f"><span>งาน / วิธีการแก้ไข</span><textarea class="in" id="a-assign">${esc(r.assignment || '')}</textarea></label>
      <div class="row"><label class="f grow"><span>กำหนดส่ง</span><input type="date" class="in" id="a-due" value="${esc(r.due_date || '')}"></label></div>
      <div class="row"><button class="btn pri" id="a-doassign">${r.status === 'SUBMITTED' ? 'รับเรื่องและมอบหมายงาน' : 'บันทึกการแก้ไข'}</button>
      ${can.reject ? '<button class="btn bad" id="a-reject">ไม่รับคำร้อง</button>' : ''}</div></div>`);
  if (can.review) out.push(`
    <div class="card" style="margin-top:12px;border-color:#c7d2fe"><h3>ตรวจงานและตัดสินผล</h3>
      <div class="row"><label class="f"><span>ผลการเรียนใหม่</span><select class="in" id="a-grade">${allowed.map(g => `<option>${esc(g)}</option>`).join('')}</select></label>
      <div class="small muted grow">ตามเกณฑ์: แก้ ${esc(r.original_grade)} ได้สูงสุด ${esc(allowed[0] || '-')}</div></div>
      <label class="f"><span>ความเห็นครู</span><textarea class="in" id="a-tcomment"></textarea></label>
      <div class="row"><button class="btn ok" id="a-pass">✓ ผ่าน และลงนาม</button><button class="btn warn" id="a-revise">ให้แก้ไขงาน</button><button class="btn bad" id="a-fail">ไม่ผ่าน (ลงนาม)</button></div></div>`);
  if (can.measure) out.push(approveCard('งานวัดผล: ตรวจสอบความถูกต้อง', 'm', false));
  if (can.academic) out.push(approveCard('หัวหน้าวิชาการ: ตรวจสอบ', 'ac', true));
  return out.join('');
}
const approveCard = (title, k, two) => `
  <div class="card" style="margin-top:12px;border-color:#a7f3d0"><h3>${title}</h3>
    <label class="f"><span>ความเห็น (ถ้ามี / จำเป็นเมื่อส่งกลับ)</span><textarea class="in" id="a-${k}comment"></textarea></label>
    <div class="row"><button class="btn ok" id="a-${k}ok">✓ ถูกต้อง และลงนาม</button>
    ${two ? `<button class="btn warn" id="a-${k}ret-m">ส่งกลับงานวัดผล</button>` : ''}<button class="btn warn" id="a-${k}ret">ส่งกลับครูผู้สอน</button></div></div>`;

async function requireSignature(text) {
  if (!S.me.has_signature) {
    toast('กรุณาบันทึกลายเซ็นก่อนลงนาม', 'bad'); closeModal(); go('signature'); return false;
  }
  const s = await F.getDoc(R.sig(S.me.email));
  const png = s.exists() ? s.data().png : '';
  return confirmDlg('ยืนยันการลงนามอิเล็กทรอนิกส์', `<p>${esc(text)}</p><div class="center"><img class="sigprev" src="${png}"><div>(${esc(S.me.name)})</div><div class="small muted">${esc(S.me.position)}</div></div>`, 'ลงนาม', 'ok');
}
const mySign = () => ({ email: S.me.email, name: S.me.name, position: S.me.position || '', at: F.serverTimestamp() });

async function act(r, patch, action, detail, role) {
  const b = F.writeBatch(db);
  b.update(R.req(r.id), { ...patch, updated_at: F.serverTimestamp() });
  b.set(logRef(r.id), logData(action, detail, role));
  await b.commit();
}

function bindActions(body, r, can) {
  const val = id => ($('#' + id, body) || {}).value || '';
  const on = (id, fn) => { const el = $('#' + id, body); if (el) el.onclick = () => quiet(run(fn)); };
  on('a-cancel', async () => {
    if (!await confirmDlg('ยกเลิกคำร้อง', 'ต้องการยกเลิกคำร้องนี้ใช่ไหม', 'ยกเลิกคำร้อง', 'bad')) return;
    await act(r, { status: 'CANCELLED' }, 'ยกเลิกคำร้อง', '', 'นักเรียน');
  });
  on('a-upload', () => uploadFiles(r, can, $('#a-files', body).files, val('a-fnote')));
  if (can.set_teacher) {
    loadStaff().then(list => {
      const sel = $('#a-teacher', body); if (!sel) return;
      sel.innerHTML = '<option value="">-- เลือกครู --</option>' + list.filter(x => x.active !== false).map(x => `<option value="${esc(x.id)}" ${x.id === r.teacher_email ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
    });
    on('a-setT', async () => {
      const em = val('a-teacher'); if (!em) throw new Error('กรุณาเลือกครู');
      const t = (await loadStaff()).find(x => x.id === em);
      await act(r, { teacher_email: em, teacher_name: t.name }, 'กำหนดครูผู้สอน', t.name);
    });
  }
  on('a-doassign', async () => {
    const a = val('a-assign').trim(); if (!a) throw new Error('กรุณาระบุงานที่มอบหมาย');
    const due = val('a-due');
    const first = r.status === 'SUBMITTED';
    await act(r, first ? { status: 'ASSIGNED', assignment: a, due_date: due } : { assignment: a, due_date: due },
      first ? 'รับคำร้องและมอบหมายงาน' : 'แก้ไขงานที่มอบหมาย', a + (due ? ' (กำหนดส่ง ' + thaiDateFull(due) + ')' : ''), 'ครูผู้สอน');
    toast('บันทึกแล้ว', 'ok');
  });
  on('a-reject', async () => {
    const c = val('a-assign').trim() || prompt('ระบุเหตุผลที่ไม่รับคำร้อง');
    if (!c) throw new Error('กรุณาระบุเหตุผล (พิมพ์ในช่องงาน/วิธีการแก้ไข)');
    if (!await confirmDlg('ไม่รับคำร้อง', 'เหตุผล: ' + esc(c), 'ยืนยัน', 'bad')) return;
    await act(r, { status: 'REJECTED', teacher_comment: c }, 'ไม่รับคำร้อง', c, 'ครูผู้สอน');
  });
  on('a-pass', async () => {
    const g = val('a-grade'), c = val('a-tcomment').trim();
    if (!await requireSignature(`ยืนยันผลการเรียนใหม่ ${r.original_grade} → ${g} วิชา ${r.subject_code} ของ ${r.student_name}`)) return;
    await act(r, { status: 'TEACHER_APPROVED', new_grade: g, teacher_comment: c, 'signs.teacher': mySign() }, 'ตรวจผ่านและลงนาม', 'ผลการเรียนใหม่ ' + g + (c ? ' — ' + c : ''), 'ครูผู้สอน');
    toast('ลงนามแล้ว ส่งต่องานวัดผล', 'ok');
  });
  on('a-revise', async () => {
    const c = val('a-tcomment').trim(); if (!c) throw new Error('กรุณาระบุสิ่งที่ต้องแก้ไขในช่องความเห็น');
    await act(r, { status: 'REVISE', teacher_comment: c }, 'ให้นักเรียนแก้ไขงาน', c, 'ครูผู้สอน');
  });
  on('a-fail', async () => {
    const c = val('a-tcomment').trim(); if (!c) throw new Error('กรุณาระบุเหตุผลในช่องความเห็น');
    if (!await requireSignature('ยืนยันผล "ไม่ผ่าน" การแก้ไขครั้งนี้')) return;
    await act(r, { status: 'FAILED', teacher_comment: c, 'signs.teacher': mySign() }, 'ตัดสินไม่ผ่านและลงนาม', c, 'ครูผู้สอน');
  });
  on('a-mok', async () => {
    if (!await requireSignature(`รับรองความถูกต้องคำร้อง ${r.request_no} (${r.original_grade} → ${r.new_grade})`)) return;
    await act(r, { status: 'MEASURE_APPROVED', measure_comment: val('a-mcomment').trim(), 'signs.measure': mySign() }, 'งานวัดผลตรวจสอบและลงนาม', val('a-mcomment').trim(), 'หัวหน้างานวัดผล');
  });
  on('a-mret', async () => {
    const c = val('a-mcomment').trim(); if (!c) throw new Error('กรุณาระบุเหตุผลที่ส่งกลับ');
    await act(r, { status: 'RETURNED', measure_comment: c, 'signs.teacher': F.deleteField() }, 'ส่งกลับให้ครูผู้สอนทบทวน', c, 'หัวหน้างานวัดผล');
  });
  on('a-acok', async () => {
    if (!await requireSignature(`รับรองคำร้อง ${r.request_no} เห็นควรเสนอ ผอ. อนุมัติ`)) return;
    await act(r, { status: 'ACADEMIC_APPROVED', academic_comment: val('a-accomment').trim(), 'signs.academic': mySign() }, 'หัวหน้าวิชาการตรวจสอบและลงนาม', val('a-accomment').trim(), 'หัวหน้าวิชาการ');
  });
  on('a-acret-m', async () => {
    const c = val('a-accomment').trim(); if (!c) throw new Error('กรุณาระบุเหตุผลที่ส่งกลับ');
    await act(r, { status: 'TEACHER_APPROVED', academic_comment: c, 'signs.measure': F.deleteField() }, 'ส่งกลับให้งานวัดผลตรวจสอบใหม่', c, 'หัวหน้าวิชาการ');
  });
  on('a-acret', async () => {
    const c = val('a-accomment').trim(); if (!c) throw new Error('กรุณาระบุเหตุผลที่ส่งกลับ');
    await act(r, { status: 'RETURNED', academic_comment: c, 'signs.teacher': F.deleteField(), 'signs.measure': F.deleteField() }, 'ส่งกลับให้ครูผู้สอนทบทวน', c, 'หัวหน้าวิชาการ');
  });
}

/* ---------------- ไฟล์ (ผ่าน Apps Script → Google Drive) ---------------- */
async function gasCall(payload) {
  if (!GAS_URL) throw new Error('ยังไม่ได้ตั้งค่า GAS_URL ใน config.js (ระบบเก็บไฟล์)');
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify({ ...payload, idToken }) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'อัปโหลดไม่สำเร็จ');
  return j.data;
}
const fileToB64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

async function uploadFiles(r, can, fileList, note) {
  const files = Array.from(fileList || []);
  if (!files.length) throw new Error('กรุณาเลือกไฟล์');
  const max = Number(S.settings.max_upload_mb || 10) * 1024 * 1024;
  const big = files.find(f => f.size > max); if (big) throw new Error('ไฟล์ ' + big.name + ' ใหญ่เกินกำหนด');
  const saved = [];
  for (let i = 0; i < files.length; i++) {
    loading(true, `กำลังอัปโหลด ${i + 1}/${files.length} — ${files[i].name}`);
    const meta = await gasCall({ action: 'upload', request_id: r.id, name: files[i].name, mime: files[i].type || 'application/octet-stream', data: await fileToB64(files[i]) });
    saved.push({ ...meta, file_name: files[i].name, mime: files[i].type || '' });
  }
  const b = F.writeBatch(db);
  saved.forEach(m => b.set(F.doc(F.collection(db, 'requests', r.id, 'files')), {
    file_name: m.file_name, mime: m.mime, size: m.size, drive_id: m.drive_id, note: note || '',
    uploader_role: can.upload_student ? 'student' : 'teacher', uploaded_by: S.me.email, uploaded_at: F.serverTimestamp()
  }));
  const names = saved.map(m => m.file_name).join(', ');
  if (can.upload_student) {
    b.update(R.req(r.id), { status: 'WORK_SUBMITTED', work_note: note || '', files_count: F.increment(saved.length), updated_at: F.serverTimestamp() });
    b.set(logRef(r.id), logData('ส่งงาน', names + (note ? ' — ' + note : ''), 'นักเรียน'));
  } else {
    b.update(R.req(r.id), { files_count: F.increment(saved.length), updated_at: F.serverTimestamp() });
    b.set(logRef(r.id), logData('ครูแนบไฟล์', names + (note ? ' — ' + note : ''), 'ครูผู้สอน'));
  }
  await b.commit();
  toast(can.upload_student ? 'ส่งงานเรียบร้อย' : 'แนบไฟล์แล้ว', 'ok');
}

async function openFile(rid, f) {
  await quiet(run(async () => {
    const d = await gasCall({ action: 'download', request_id: rid, file_id: f.id });
    const bin = atob(d.data); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u8], { type: d.mime || f.mime || 'application/octet-stream' }));
    if (/^image\//.test(d.mime)) {
      const prev = document.createElement('div'); prev.className = 'modal-bg'; prev.style.zIndex = 150;
      prev.innerHTML = `<div class="modal lg"><div class="modal-h"><h3>${esc(f.file_name)}</h3><button class="x">×</button></div><div class="modal-b center"><img src="${url}" style="max-width:100%"></div></div>`;
      prev.onclick = e => { if (e.target === prev || e.target.classList.contains('x')) prev.remove(); };
      document.body.appendChild(prev);
    } else {
      const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.download = f.file_name; document.body.appendChild(a); a.click(); a.remove();
    }
  }, 'กำลังเปิดไฟล์...'));
}

/* =========================== หน้า: บุคลากร =========================== */
async function loadStaff(force) {
  if (!S.staffList || force) S.staffList = snapList(await F.getDocs(R.col('staff'))).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
  return S.staffList;
}

VIEWS.dash = async () => {
  const v = $('#view');
  const y = S.settings.current_year, s = S.settings.current_semester;
  let rows;
  if (oversight()) {
    v.innerHTML = '<div class="empty">กำลังสรุปข้อมูล...</div>';
    rows = snapList(await F.getDocs(F.query(R.col('requests'), F.where('academic_year', '==', y), F.where('semester', '==', s))));
  } else rows = S.live.teacher || [];
  const c = counts();
  const by = k => rows.reduce((a, r) => (a[r[k]] = (a[r[k]] || 0) + 1, a), {});
  const bySt = by('status');
  const active = rows.filter(r => ACTIVE.includes(r.status)).length;
  const done = bySt.COMPLETED || 0;
  const overdue = rows.filter(r => ['ASSIGNED', 'REVISE'].includes(r.status) && r.due_date && r.due_date < isoToday());
  const top = (o, n = 8) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const subj = top(rows.reduce((a, r) => { const k = r.subject_code + ' ' + r.subject_name; a[k] = (a[k] || 0) + 1; return a; }, {}));
  const maxN = Math.max(1, ...subj.map(x => x[1]));
  const todo = [];
  if (c.inbox) todo.push(`<a href="#" data-go="inbox">คำร้องถึงครูที่ต้องดำเนินการ <b>${c.inbox}</b></a>`);
  if (c.measure) todo.push(`<a href="#" data-go="measure">รองานวัดผลตรวจ <b>${c.measure}</b></a>`);
  if (c.academic) todo.push(`<a href="#" data-go="academic">รอวิชาการตรวจ <b>${c.academic}</b></a>`);
  if (c.memos) todo.push(`<a href="#" data-go="memos">รอออกบันทึกข้อความ <b>${c.memos}</b></a>`);
  if (c.director) todo.push(`<a href="#" data-go="director">บันทึกรอ ผอ. อนุมัติ <b>${c.director}</b></a>`);
  if (!S.me.has_signature) todo.unshift(`<a href="#" data-go="signature">⚠️ ยังไม่ได้บันทึกลายเซ็นอิเล็กทรอนิกส์</a>`);
  v.innerHTML = `
    <div class="small muted" style="margin-bottom:10px">${oversight() ? `ภาพรวมทั้งโรงเรียน ภาคเรียนที่ ${esc(s)}/${esc(y)}` : 'คำร้องในรายวิชาที่ครูสอน'}</div>
    ${todo.length ? `<div class="alert info" style="margin-bottom:14px"><b>งานที่รอคุณ</b><div>${todo.join(' · ')}</div></div>` : ''}
    <div class="grid g4">
      <div class="card stat"><div class="n">${rows.length}</div><div class="l">คำร้องทั้งหมด</div></div>
      <div class="card stat"><div class="n" style="color:var(--warn)">${active}</div><div class="l">กำลังดำเนินการ</div></div>
      <div class="card stat"><div class="n" style="color:var(--ok)">${done}</div><div class="l">อนุมัติแล้ว</div></div>
      <div class="card stat"><div class="n" style="color:var(--bad)">${overdue.length}</div><div class="l">เลยกำหนดส่งงาน</div></div>
    </div>
    <div class="grid g2" style="margin-top:14px">
      <div class="card"><h3>ตามสถานะ</h3>${Object.keys(ST_LABEL).filter(k => bySt[k]).map(k => `<div class="row" style="justify-content:space-between;margin:4px 0">${badge(k)}<b>${bySt[k]}</b></div>`).join('') || '<div class="muted">ยังไม่มีคำร้อง</div>'}</div>
      <div class="card"><h3>รายวิชาที่มีคำร้องมากที่สุด</h3>${subj.map(([k, n]) => `<div style="margin:6px 0"><div class="row small" style="justify-content:space-between"><span>${esc(k)}</span><b>${n}</b></div><div class="bar"><i style="width:${n / maxN * 100}%"></i></div></div>`).join('') || '<div class="muted">-</div>'}</div>
    </div>
    ${overdue.length ? `<div class="card"><h3>เลยกำหนดส่งงาน</h3>${reqTable(overdue)}</div>` : ''}
    ${oversight() ? `<div class="card"><h3>นักเรียนที่ติดผลการเรียน (ภาคเรียนปัจจุบัน)</h3><div id="fail-sum" class="muted small">กดปุ่มเพื่อสรุปจากข้อมูลผลการเรียนทั้งภาคเรียน</div><button class="btn sm" id="btn-fail" style="margin-top:8px">สรุปข้อมูล</button></div>` : ''}`;
  $$('[data-go]', v).forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.go); });
  bindReqTable(v);
  const bf = $('#btn-fail', v);
  if (bf) bf.onclick = () => quiet(run(async () => {
    const terms = snapList(await F.getDocs(F.query(R.col('terms'), F.where('academic_year', '==', y), F.where('semester', '==', s))));
    const fs = failSet(); const reqKeys = new Set(rows.map(r => r.grade_key));
    const list = [];
    terms.forEach(t => Object.entries(t.subjects || {}).forEach(([code, sub]) => { if (fs.includes(sub.grade)) list.push({ t, code, sub, req: reqKeys.has(y + '_' + s + '_' + t.student_id + '_' + code) }); }));
    const stu = new Set(list.map(x => x.t.student_id)).size;
    const notReq = list.filter(x => !x.req);
    $('#fail-sum', v).innerHTML = `<div class="grid g3" style="margin:8px 0"><div class="box"><b>${list.length}</b> รายการที่ติด</div><div class="box"><b>${stu}</b> นักเรียน</div><div class="box"><b style="color:var(--bad)">${notReq.length}</b> ยังไม่ยื่นคำร้อง</div></div>
      <button class="btn sm" id="dl-fail">ดาวน์โหลดรายชื่อที่ยังไม่ยื่นคำร้อง (CSV)</button>`;
    $('#dl-fail', v).onclick = () => download(`ติดผลการเรียน_ยังไม่ยื่น_${s}-${y}.csv`, csv([['เลขประจำตัว', 'ชื่อ', 'ชั้น', 'รหัสวิชา', 'รายวิชา', 'ผล', 'ครูผู้สอน'], ...notReq.map(x => [x.t.student_id, x.t.name, x.t.class, x.code, x.sub.name, x.sub.grade, x.sub.teacher_name])]));
  }, 'กำลังสรุป...'));
};

VIEWS.inbox = () => {
  const all = byUpdated(S.live.teacher || []);
  const tab = S._inboxTab || 'todo';
  const groups = {
    todo: all.filter(r => ['SUBMITTED', 'WORK_SUBMITTED', 'RETURNED'].includes(r.status)),
    wait: all.filter(r => ['ASSIGNED', 'REVISE'].includes(r.status)),
    sent: all.filter(r => ['TEACHER_APPROVED', 'MEASURE_APPROVED', 'ACADEMIC_APPROVED', 'IN_MEMO'].includes(r.status)),
    done: all.filter(r => !ACTIVE.includes(r.status))
  };
  const L = { todo: 'ต้องดำเนินการ', wait: 'รอนักเรียนส่งงาน', sent: 'ส่งต่อแล้ว', done: 'เสร็จสิ้น' };
  $('#view').innerHTML = `<div class="tabs">${Object.keys(L).map(k => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${L[k]} (${groups[k].length})</button>`).join('')}</div>
    <div class="card">${reqTable(groups[tab], { noTeacher: true })}</div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { S._inboxTab = b.dataset.tab; VIEWS.inbox(); });
  bindReqTable($('#view'));
};

VIEWS.measure = () => {
  $('#view').innerHTML = `<div class="card"><p class="muted small" style="margin-top:0">คำร้องที่ครูผู้สอนตรวจผ่านและลงนามแล้ว รอหัวหน้างานวัดผลตรวจสอบ</p>${reqTable(byUpdated(S.live.measure || []))}</div>`;
  bindReqTable($('#view'));
};
VIEWS.academic = () => {
  $('#view').innerHTML = `<div class="card"><p class="muted small" style="margin-top:0">คำร้องที่งานวัดผลตรวจแล้ว รอหัวหน้าวิชาการตรวจสอบ</p>${reqTable(byUpdated((S.live.academic || []).filter(r => r.status === 'MEASURE_APPROVED')))}</div>`;
  bindReqTable($('#view'));
};

VIEWS.signature = async () => {
  const v = $('#view');
  const s = await F.getDoc(R.sig(S.me.email));
  const cur = s.exists() ? s.data().png : '';
  v.innerHTML = `<div class="grid g2">
    <div class="card"><h3>วาดลายเซ็น</h3><canvas class="pad" id="pad"></canvas>
      <div class="row" style="margin-top:10px"><button class="btn" id="pad-clear">ล้าง</button><button class="btn pri" id="pad-save">บันทึกลายเซ็น</button>
      <label class="btn" style="margin-left:auto">อัปโหลดรูปลายเซ็น<input type="file" accept="image/*" id="pad-file" hidden></label></div>
      <div class="small muted" style="margin-top:8px">ลายเซ็นนี้จะถูกใช้เมื่อกด "ลงนาม" ในคำร้องและบันทึกข้อความ ทุกครั้งที่ลงนามระบบบันทึกชื่อ ตำแหน่ง และเวลาไว้ตรวจสอบได้</div></div>
    <div class="card"><h3>ลายเซ็นปัจจุบัน</h3>${cur ? `<img class="sigprev" src="${cur}">` : '<div class="muted">ยังไม่มี</div>'}
      <div style="margin-top:12px">(${esc(S.me.name)})<div class="small muted">${esc(S.me.position)}</div></div></div></div>`;
  const pad = setupPad($('#pad', v));
  $('#pad-clear', v).onclick = () => pad.clear();
  $('#pad-save', v).onclick = () => quiet(run(async () => {
    if (pad.isEmpty()) throw new Error('กรุณาวาดลายเซ็นก่อน');
    await saveSig(pad.toPng());
  }));
  $('#pad-file', v).onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => quiet(run(async () => {
      const c = document.createElement('canvas'); const sc = Math.min(1, 600 / img.width, 220 / img.height);
      c.width = img.width * sc; c.height = img.height * sc; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      await saveSig(c.toDataURL('image/png'));
    }));
    img.src = URL.createObjectURL(f);
  };
};
async function saveSig(png) {
  if (png.length > 390000) throw new Error('รูปลายเซ็นใหญ่เกินไป');
  await F.setDoc(R.sig(S.me.email), { png, updated_at: F.serverTimestamp() });
  S.me.has_signature = true; toast('บันทึกลายเซ็นแล้ว', 'ok'); VIEWS.signature();
}
function setupPad(cv) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const fit = () => { const w = cv.clientWidth, h = cv.clientHeight; cv.width = w * ratio; cv.height = h * ratio; const c = cv.getContext('2d'); c.scale(ratio, ratio); c.lineWidth = 2.4; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#1e3a8a'; };
  fit();
  const ctx = cv.getContext('2d'); let drawing = false, empty = true, last = null;
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener('pointerdown', e => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; empty = false; });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => cv.addEventListener(t, () => drawing = false));
  return {
    clear: () => { ctx.clearRect(0, 0, cv.width, cv.height); empty = true; },
    isEmpty: () => empty,
    toPng: () => { // ย่อและครอปให้เล็ก
      const out = document.createElement('canvas'); const sc = Math.min(1, 600 / cv.width);
      out.width = cv.width * sc; out.height = cv.height * sc; out.getContext('2d').drawImage(cv, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }
  };
}

/* ---------------- บันทึกข้อความ ---------------- */
VIEWS.memos = async (live) => {
  const v = $('#view');
  const ready = byUpdated((S.live.academic || []).filter(r => r.status === 'ACADEMIC_APPROVED'));
  if (!live || !S._memos) S._memos = snapList(await F.getDocs(R.col('memos'))).sort((a, b) => (toDate(b.created_at) || 0) - (toDate(a.created_at) || 0));
  const ms = S._memos;
  const stLbl = { PENDING: ['รอ ผอ. อนุมัติ', 'indigo'], APPROVED: ['อนุมัติแล้ว', 'green'], REJECTED: ['ไม่อนุมัติ', 'red'], RETURNED: ['ส่งกลับแก้ไข', 'orange'] };
  v.innerHTML = `
    ${hasRole('academic') ? `<div class="card"><h3>สร้างบันทึกข้อความเสนอ ผอ.</h3>
      <p class="small muted" style="margin-top:0">เลือกคำร้องที่ตรวจครบแล้ว ระบบจะออกเลขที่บันทึก รวมรายชื่อเป็นเอกสารแนบ และลงนามในนามหัวหน้าวิชาการ</p>
      ${reqTable(ready, { check: true, empty: 'ไม่มีคำร้องรอออกบันทึก' })}
      ${ready.length ? `<div class="grid g3" style="margin-top:12px">
        <label class="f"><span>เลขที่บันทึก (เว้นว่าง = ออกเลขอัตโนมัติ)</span><input class="in" id="mm-no" placeholder="เช่น 125/2569"></label>
        <label class="f"><span>วันที่</span><input type="date" class="in" id="mm-date" value="${isoToday()}"></label>
        <label class="f"><span>เรื่อง (เว้นว่างได้)</span><input class="in" id="mm-subj" placeholder="ขออนุมัติแก้ไขผลการเรียน ..."></label></div>
        <button class="btn pri" id="mm-create">สร้างบันทึกข้อความและลงนาม</button>` : ''}</div>` : ''}
    <div class="card"><h3>บันทึกข้อความทั้งหมด</h3>
      ${ms.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ที่</th><th>วันที่</th><th>เรื่อง</th><th>จำนวน</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${ms.map(m => `<tr><td><b>${esc(m.memo_no)}</b></td><td>${esc(thaiDateFull(m.memo_date))}</td><td>${esc(m.subject)}</td><td>${(m.request_ids || []).length}</td>
        <td><span class="badge b-${(stLbl[m.status] || ['', 'gray'])[1]}">${esc((stLbl[m.status] || [m.status])[0])}</span></td><td><button class="btn sm" data-memo="${esc(m.id)}">เปิด</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">ยังไม่มีบันทึกข้อความ</div>'}</div>`;
  bindReqTable(v);
  $$('[data-memo]', v).forEach(b => b.onclick = () => openMemo(b.dataset.memo));
  const btn = $('#mm-create', v);
  if (btn) btn.onclick = () => {
    const ids = $$('.chk-row:checked', v).map(c => c.value);
    if (!ids.length) return toast('กรุณาเลือกคำร้อง', 'bad');
    quiet(run(async () => {
      if (!await requireSignature(`ลงนามเสนอบันทึกข้อความขออนุมัติแก้ไขผลการเรียน ${ids.length} รายการ`)) return;
      const mid = await createMemo(ids, $('#mm-no', v).value.trim(), $('#mm-date', v).value || isoToday(), $('#mm-subj', v).value.trim());
      S._memos = null; toast('สร้างบันทึกข้อความแล้ว', 'ok'); VIEWS.memos(); openMemo(mid);
    }, 'กำลังสร้างบันทึก...'));
  };
};

async function createMemo(ids, manualNo, date, subject) {
  const memoRef = F.doc(R.col('memos'));
  const be = new Date().getFullYear() + 543;
  await F.runTransaction(db, async tx => {
    const cs = await tx.get(R.counters());
    const rs = [];
    for (const id of ids) {
      const s = await tx.get(R.req(id));
      if (!s.exists() || s.data().status !== 'ACADEMIC_APPROVED') throw new Error('คำร้อง ' + id + ' ไม่อยู่ในสถานะพร้อมออกบันทึก');
      rs.push({ id, ...s.data() });
    }
    const mine = await tx.get(R.sig(S.me.email));
    const ms = rs.find(r => r.signs && r.signs.measure);
    const msig = ms ? await tx.get(R.sig(ms.signs.measure.email)) : null;
    let no = manualNo;
    const key = 'memo_' + be;
    const n = ((cs.exists() && cs.data()[key]) || 0) + 1;
    if (!no) { no = (S.settings.memo_prefix ? S.settings.memo_prefix + ' ' : '') + n + '/' + be; tx.set(R.counters(), { [key]: n }, { merge: true }); }
    const terms = [...new Set(rs.map(r => 'ภาคเรียนที่ ' + r.semester + ' ปีการศึกษา ' + r.academic_year))];
    const signs = { academic: { ...mySign(), png: mine.exists() ? mine.data().png : '' } };
    if (ms) signs.measure = { ...ms.signs.measure, png: msig && msig.exists() ? msig.data().png : '' };
    tx.set(memoRef, {
      memo_no: no, memo_date: date, subject: subject || ('ขออนุมัติแก้ไขผลการเรียน ' + terms.join(', ')), to: S.settings.memo_to,
      terms, request_ids: ids, created_by: S.me.email, created_by_name: S.me.name, status: 'PENDING', decision: '',
      director_comment: '', signs, created_at: F.serverTimestamp()
    });
    rs.forEach(r => {
      tx.update(R.req(r.id), { status: 'IN_MEMO', memo_id: memoRef.id, memo_no: no, updated_at: F.serverTimestamp() });
      tx.set(logRef(r.id), logData('ออกบันทึกข้อความเสนอ ผอ.', 'ที่ ' + no, 'หัวหน้าวิชาการ'));
    });
  });
  return memoRef.id;
}

async function loadMemoFull(mid) {
  const ms = await F.getDoc(R.memo(mid));
  if (!ms.exists()) throw new Error('ไม่พบบันทึก');
  const m = { id: ms.id, ...ms.data() };
  const rs = (await Promise.all((m.request_ids || []).map(id => F.getDoc(R.req(id))))).filter(s => s.exists()).map(s => ({ id: s.id, ...s.data() }));
  return { m, rs };
}

async function openMemo(mid) {
  await quiet(run(async () => {
    const { m, rs } = await loadMemoFull(mid);
    const html = memoHtml(m, rs);
    const canDecide = hasRole('director') && m.status === 'PENDING';
    const md = modal(`<div class="modal-h"><h3>บันทึกข้อความที่ ${esc(m.memo_no)}</h3><button class="x" data-close>×</button></div>
      <div class="modal-b"><iframe class="memo" id="memo-frame"></iframe>
      ${canDecide ? `<div class="card" style="margin-top:12px;border-color:#c7d2fe"><h3>คำสั่งผู้อำนวยการ</h3>
        <label class="f"><span>ความเห็น/คำสั่ง (จำเป็นเมื่อไม่อนุมัติหรือส่งกลับ)</span><textarea class="in" id="d-comment"></textarea></label>
        <div class="row"><button class="btn ok" id="d-ok">✓ อนุมัติ และลงนาม</button><button class="btn warn" id="d-ret">ส่งกลับแก้ไข</button><button class="btn bad" id="d-no">ไม่อนุมัติ (ลงนาม)</button></div></div>` : ''}</div>
      <div class="modal-f"><button class="btn" id="memo-print">🖨️ พิมพ์ / บันทึก PDF</button><button class="btn" data-close>ปิด</button></div>`, { lg: true });
    const fr = $('#memo-frame', md); fr.srcdoc = html;
    $('#memo-print', md).onclick = () => fr.contentWindow.print();
    const dec = (d) => quiet(run(async () => {
      const c = $('#d-comment', md).value.trim();
      if (d !== 'approve' && !c) throw new Error('กรุณาระบุความเห็น');
      if (d !== 'return' && !await requireSignature(d === 'approve' ? `อนุมัติแก้ไขผลการเรียนตามบันทึกที่ ${m.memo_no} (${rs.length} รายการ)` : `ไม่อนุมัติบันทึกที่ ${m.memo_no}`)) return;
      await decideMemo(m, rs, d, c);
      toast('บันทึกคำสั่งแล้ว', 'ok'); S._memos = null; openMemo(mid);
    }, 'กำลังบันทึก...'));
    if (canDecide) { $('#d-ok', md).onclick = () => dec('approve'); $('#d-ret', md).onclick = () => dec('return'); $('#d-no', md).onclick = () => dec('reject'); }
  }, 'กำลังเปิดบันทึก...'));
}

async function decideMemo(m, rs, d, c) {
  const st = { approve: 'APPROVED', reject: 'REJECTED', return: 'RETURNED' }[d];
  const reqSt = { approve: 'COMPLETED', reject: 'REJECTED', return: 'ACADEMIC_APPROVED' }[d];
  const label = { approve: 'อนุมัติ', reject: 'ไม่อนุมัติ', return: 'ส่งกลับแก้ไข' }[d];
  let png = '';
  if (d !== 'return') { const s = await F.getDoc(R.sig(S.me.email)); png = s.exists() ? s.data().png : ''; }
  const b = F.writeBatch(db);
  const mp = { status: st, decision: label, director_comment: c, decided_at: F.serverTimestamp() };
  if (d !== 'return') mp['signs.director'] = { ...mySign(), png };
  b.update(R.memo(m.id), mp);
  rs.forEach(r => {
    const p = { status: reqSt, director_comment: c, updated_at: F.serverTimestamp() };
    if (d === 'return') { p.memo_id = ''; p.memo_no = ''; }
    b.update(R.req(r.id), p);
    b.set(logRef(r.id), logData(d === 'approve' ? 'ผอ. อนุมัติและลงนาม' : (d === 'reject' ? 'ผอ. ไม่อนุมัติ' : 'ผอ. ส่งบันทึกกลับแก้ไข'),
      (d === 'approve' ? 'ปรับผลการเรียน ' + r.original_grade + ' → ' + r.new_grade + ' (บันทึกที่ ' + m.memo_no + ')' : c), 'ผู้อำนวยการ'));
  });
  await b.commit();
}

VIEWS.director = () => {
  const ms = (S.live.memosPending || []).slice().sort((a, b) => (toDate(a.created_at) || 0) - (toDate(b.created_at) || 0));
  $('#view').innerHTML = `<div class="card">${ms.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ที่</th><th>วันที่</th><th>เรื่อง</th><th>จำนวน</th><th>เสนอโดย</th><th></th></tr></thead><tbody>
    ${ms.map(m => `<tr><td><b>${esc(m.memo_no)}</b></td><td>${esc(thaiDateFull(m.memo_date))}</td><td>${esc(m.subject)}</td><td>${(m.request_ids || []).length}</td><td>${esc(m.created_by_name)}</td><td><button class="btn sm pri" data-memo="${esc(m.id)}">พิจารณา</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">ไม่มีบันทึกรออนุมัติ</div>'}</div>`;
  $$('[data-memo]').forEach(b => b.onclick = () => openMemo(b.dataset.memo));
};

function memoHtml(m, rs) {
  const s = S.settings;
  rs = rs.slice().sort((a, b) => (a.class + a.student_id + a.subject_code).localeCompare(b.class + b.student_id + b.subject_code));
  const sg = m.signs || {};
  const block = (x, fbName, fbPos) => `<div class="sign">${x && x.png ? `<img class="sig" src="${x.png}">` : '<div class="sig-blank"></div>'}
    <div>(${esc(x ? x.name : (fbName || '.................................................'))})</div><div>${esc(x ? (x.position || fbPos) : fbPos)}</div>
    ${x && x.at ? `<div class="sdate">ลงนามเมื่อ ${esc(thaiDateFull(x.at))} ${esc(fmtTs(x.at).split(' ').slice(-2).join(' '))}</div>` : ''}</div>`;
  const box = on => `<span class="box">${on ? '✓' : ''}</span>`;
  const dName = s.director_name || (sg.director ? sg.director.name : '');
  const dPos = s.director_position || 'ผู้อำนวยการโรงเรียน';
  const dirBlock = sg.director ? { ...sg.director, name: s.director_name || sg.director.name, position: dPos } : null;
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>บันทึกข้อความ ${esc(m.memo_no)}</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:A4;margin:2.5cm 2cm 2cm 3cm}body{font-family:"TH Sarabun New","Sarabun",sans-serif;font-size:16pt;line-height:1.35;color:#000;margin:0;padding:12px}
@media print{body{padding:0}}.page{max-width:16cm;margin:0 auto}.head{position:relative;height:1.6cm;margin-bottom:.2cm}.garuda{position:absolute;left:0;top:0;height:1.5cm}
.title{text-align:center;font-size:29pt;font-weight:700;line-height:1.5cm}.line{display:flex;gap:.3cm;align-items:baseline}.line b{white-space:nowrap;font-size:20pt}
.fill{flex:1;border-bottom:1px dotted #000;padding-left:.2cm}p{margin:0;text-indent:2.5cm;text-align:justify}.sp{height:.4cm}
.sign{width:8cm;margin-left:auto;text-align:center;margin-top:.5cm}.sig{height:1.4cm;max-width:5cm;object-fit:contain;display:block;margin:0 auto}.sig-blank{height:1.4cm}.sdate{font-size:12pt;color:#444}
.box{display:inline-block;width:.45cm;height:.45cm;border:1px solid #000;text-align:center;line-height:.45cm;font-size:12pt;margin-right:.15cm}
.dir{margin-top:.6cm;border-top:1px solid #000;padding-top:.3cm}.break{page-break-before:always;margin-top:1cm}
table{width:100%;border-collapse:collapse;font-size:13pt}th,td{border:1px solid #000;padding:2px 4px;vertical-align:top}th{background:#f2f2f2}.c{text-align:center}.small{font-size:11pt}.note{font-size:12pt;margin-top:.3cm}</style></head>
<body><div class="page">
<div class="head">${s.garuda_url ? `<img class="garuda" src="${esc(s.garuda_url)}">` : ''}<div class="title">บันทึกข้อความ</div></div>
<div class="line"><b>ส่วนราชการ</b><span class="fill">${esc(s.memo_department)}</span></div>
<div class="line"><b>ที่</b><span class="fill">${esc(m.memo_no)}</span><b>วันที่</b><span class="fill">${esc(thaiDateFull(m.memo_date))}</span></div>
<div class="line"><b>เรื่อง</b><span class="fill">${esc(m.subject)}</span></div>
<div class="sp"></div><div>เรียน&nbsp;&nbsp;${esc(m.to)}</div><div class="sp"></div>
<p>ตามที่ ${esc(s.school_name)} ได้ดำเนินการวัดและประเมินผลการเรียน ${esc((m.terms || []).join(', '))} ปรากฏว่ามีนักเรียนได้ผลการเรียน 0 ร มส หรือ มผ ซึ่งต้องดำเนินการแก้ไขตามระเบียบว่าด้วยการวัดและประเมินผลการเรียนของสถานศึกษา นั้น</p>
<p>บัดนี้ นักเรียนได้ยื่นคำร้องขอแก้ไขผลการเรียนผ่านระบบออนไลน์ ครูผู้สอนได้ดำเนินการมอบหมายงาน ตรวจผลงาน และตัดสินผลการเรียน งานวัดผลและประเมินผลและกลุ่มบริหารวิชาการได้ตรวจสอบความถูกต้องแล้ว จำนวน ${rs.length} รายการ รายละเอียดดังเอกสารแนบ</p>
<p>จึงเรียนมาเพื่อโปรดพิจารณาอนุมัติ</p>
${block(sg.measure, '', 'หัวหน้างานวัดผลและประเมินผล')}
<div style="margin-top:.4cm">ความเห็นหัวหน้ากลุ่มบริหารวิชาการ: เห็นควรอนุมัติ</div>
${block(sg.academic, m.created_by_name, 'หัวหน้ากลุ่มบริหารวิชาการ')}
<div class="dir"><b>คำสั่ง/ความเห็นผู้อำนวยการ</b><div style="margin-top:.2cm">${box(m.decision === 'อนุมัติ')}อนุมัติ&nbsp;&nbsp;&nbsp;&nbsp;${box(m.decision === 'ไม่อนุมัติ')}ไม่อนุมัติ</div>
${m.director_comment ? `<div>${esc(m.director_comment)}</div>` : ''}${block(dirBlock, dName, dPos)}</div>
<div class="break"></div><div style="text-align:center;font-weight:700">เอกสารแนบบันทึกข้อความที่ ${esc(m.memo_no)}<br>รายชื่อนักเรียนที่ขออนุมัติแก้ไขผลการเรียน</div><div class="sp"></div>
<table><thead><tr><th>ที่</th><th>เลขประจำตัว</th><th>ชื่อ–สกุล</th><th>ชั้น</th><th>รหัสวิชา</th><th>รายวิชา</th><th>ผลเดิม</th><th>ผลใหม่</th><th>ครูผู้สอน</th><th class="small">ลงนาม<br>ครู/วัดผล/วิชาการ</th></tr></thead><tbody>
${rs.map((r, i) => { const x = r.signs || {}; return `<tr><td class="c">${i + 1}</td><td class="c">${esc(r.student_id)}</td><td>${esc(r.student_name)}</td><td class="c">${esc(r.class)}</td><td class="c">${esc(r.subject_code)}</td><td>${esc(r.subject_name)}</td><td class="c">${esc(r.original_grade)}</td><td class="c"><b>${esc(r.new_grade)}</b></td><td>${esc(r.teacher_name)}</td><td class="c small">${['teacher', 'measure', 'academic'].map(k => x[k] ? '✓' : '–').join(' ')}</td></tr>`; }).join('')}
</tbody></table>
<div class="note">หมายเหตุ: ทุกขั้นตอนลงนามด้วยลายมือชื่ออิเล็กทรอนิกส์ผ่านระบบ และตรวจสอบประวัติการดำเนินการย้อนหลังได้ตามเลขคำร้อง</div>
<div class="small" style="margin-top:.3cm;color:#555">เลขคำร้อง: ${esc(rs.map(r => r.request_no).join(', '))}</div>
</div></body></html>`;
}

/* ---------------- ติดตามทั้งหมด ---------------- */
VIEWS.all = async () => {
  const v = $('#view');
  const y = S._allY || S.settings.current_year, s = S._allS || S.settings.current_semester;
  v.innerHTML = `<div class="card"><div class="row">
      <label class="f"><span>ปีการศึกษา</span><input class="in" id="al-y" value="${esc(y)}" style="width:110px"></label>
      <label class="f"><span>ภาคเรียน</span><select class="in" id="al-s">${['1', '2', '3'].map(x => `<option ${x === s ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="f grow"><span>ค้นหา (ชื่อ เลขประจำตัว วิชา ครู ชั้น)</span><input class="in" id="al-q" value="${esc(S._allQ || '')}"></label>
      <label class="f"><span>สถานะ</span><select class="in" id="al-st"><option value="">ทั้งหมด</option><option value="ACTIVE">กำลังดำเนินการ</option>${Object.keys(ST_LABEL).map(k => `<option value="${k}">${ST_LABEL[k]}</option>`).join('')}</select></label>
      <button class="btn" id="al-load" style="margin-top:12px">โหลด</button><button class="btn" id="al-csv" style="margin-top:12px">CSV</button>
    </div><div id="al-list"><div class="empty">กำลังโหลด...</div></div></div>`;
  let rows = [];
  const draw = () => {
    const q = $('#al-q').value.trim().toLowerCase(), stv = $('#al-st').value;
    S._allQ = q;
    const list = byUpdated(rows).filter(r => (!q || [r.request_no, r.student_id, r.student_name, r.subject_code, r.subject_name, r.class, r.teacher_name].join(' ').toLowerCase().includes(q))
      && (!stv || (stv === 'ACTIVE' ? ACTIVE.includes(r.status) : r.status === stv)));
    $('#al-list').innerHTML = `<div class="small muted" style="margin:6px 0">${list.length} รายการ</div>` + reqTable(list);
    bindReqTable($('#al-list'));
    return list;
  };
  const load = async () => {
    S._allY = $('#al-y').value.trim(); S._allS = $('#al-s').value;
    rows = snapList(await F.getDocs(F.query(R.col('requests'), F.where('academic_year', '==', S._allY), F.where('semester', '==', S._allS))));
    draw();
  };
  $('#al-load').onclick = () => quiet(run(load));
  $('#al-q').oninput = draw; $('#al-st').onchange = draw;
  $('#al-csv').onclick = () => { const l = draw(); download(`คำร้องแก้ไขผลการเรียน_${S._allS}-${S._allY}.csv`, csv([['เลขคำร้อง', 'เลขประจำตัว', 'ชื่อ', 'ชั้น', 'รหัสวิชา', 'รายวิชา', 'ผลเดิม', 'ผลใหม่', 'ครูผู้สอน', 'สถานะ', 'บันทึกที่', 'อัปเดต'], ...l.map(r => [r.request_no, r.student_id, r.student_name, r.class, r.subject_code, r.subject_name, r.original_grade, r.new_grade, r.teacher_name, ST_LABEL[r.status], r.memo_no, fmtTs(r.updated_at)])])); };
  await load();
};

/* =========================== นำเข้าข้อมูลจาก SchoolMIS =========================== */
const FIELDS = [
  ['student_id', 'เลขประจำตัวนักเรียน *', /เลขประจำตัว|รหัสนักเรียน|รหัสประจำตัว|student.?id/i],
  ['subject_name', 'ชื่อรายวิชา', /ชื่อวิชา|รายวิชา|ชื่อรายวิชา|subject.?name/i],
  ['name', 'ชื่อ–สกุล', /ชื่อ|name/i],
  ['class', 'ชั้น/ห้อง', /ชั้น|ห้อง|class/i],
  ['number', 'เลขที่', /^เลขที่$|^ที่$|^no\.?$/i],
  ['subject_code', 'รหัสวิชา *', /รหัสวิชา|subject.?code|^รหัส$/i],
  ['credit', 'หน่วยกิต', /หน่วยกิต|น้ำหนัก|credit/i],
  ['grade', 'ผลการเรียน *', /ผลการเรียน|เกรด|ระดับผล|grade|ผลการประเมิน/i],
  ['teacher', 'ครูผู้สอน (ชื่อหรืออีเมล)', /ครู|ผู้สอน|teacher/i],
  ['year', 'ปีการศึกษา (ถ้ามีในไฟล์)', /ปีการศึกษา|^ปี$/i],
  ['semester', 'ภาคเรียน (ถ้ามีในไฟล์)', /ภาคเรียน|^ภาค$|semester|term/i],
  ['birthdate', 'วันเกิด (ถ้าจะใช้เป็นรหัสเริ่มต้น)', /วันเกิด|birth/i]
];
const WIDE_FIXED = ['student_id', 'name', 'class', 'number', 'birthdate'];
function loadXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('โหลดตัวอ่านไฟล์ Excel ไม่ได้')); document.head.appendChild(s); });
}
let _pdfjs = null;
async function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  const base = new URL('./vendor/', import.meta.url).href;
  _pdfjs = await import(base + 'pdf.min.js');
  _pdfjs.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
  return _pdfjs;
}
function guessMap(headers, fields) {
  const map = {}, used = new Set();
  fields.forEach(([k, , re]) => { const i = headers.findIndex((h, j) => !used.has(j) && h && re.test(h)); if (i >= 0) { map[k] = i; used.add(i); } });
  return map;
}

VIEWS.import = () => {
  const v = $('#view');
  const st = { aoa: null, sheetNames: [], wb: null, headerRow: 0, mode: 'long', map: {}, subjectCols: [] };
  v.innerHTML = `
    <div class="card" style="border-color:#c7d2fe"><h3>นำเข้าจาก PDF ปพ.6 ของ SchoolMIS (แนะนำ)</h3>
      <p class="small muted" style="margin-top:0">ใน SchoolMIS เมนู <b>รายงานเอกสารการศึกษา → ปพ.6 แบบมีคะแนน</b> กดปุ่มแดง <b>"พิมพ์ทั้งห้อง"</b> → ดาวน์โหลด PDF ทุกห้อง แล้วเลือกไฟล์ทั้งหมดพร้อมกันที่นี่ ระบบอ่านปีการศึกษา ภาคเรียน ชั้น/ห้อง และผลการเรียนจากไฟล์ให้เอง (อ่านในเครื่อง ไม่ส่งไฟล์ไปที่อื่น)</p>
      <input type="file" class="in" id="im-pdf" accept=".pdf" multiple>
      <div id="im-pdf-res"></div></div>
    <div class="card"><h3>หรือ นำเข้าจากไฟล์ Excel / CSV</h3>
      <p class="small muted" style="margin-top:0">รองรับ .xlsx .xls .csv — แบบ <b>แถวละ 1 รายวิชา</b> (เลขประจำตัว, รหัสวิชา, ผลการเรียน ...) หรือ <b>แถวละ 1 นักเรียน</b> (แต่ละคอลัมน์คือรายวิชา)</p>
      <div class="grid g3">
        <label class="f"><span>ปีการศึกษา</span><input class="in" id="im-y" value="${esc(S.settings.current_year)}"></label>
        <label class="f"><span>ภาคเรียน</span><select class="in" id="im-s">${['1', '2', '3'].map(x => `<option ${x === String(S.settings.current_semester) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f"><span>ไฟล์</span><input type="file" class="in" id="im-file" accept=".xlsx,.xls,.csv"></label>
      </div></div>
    <div id="im-step2"></div>`;
  $('#im-pdf', v).onchange = e => quiet(run(async () => {
    const files = Array.from(e.target.files || []); if (!files.length) return;
    const pdfjs = await loadPdfJs();
    let rows = [], issues = [];
    for (let i = 0; i < files.length; i++) {
      loading(true, `กำลังอ่าน PDF ${i + 1}/${files.length} — ${files[i].name}`);
      const r = pp6ToImportRows(await readPdfPages(pdfjs, await files[i].arrayBuffer()));
      rows = rows.concat(r.rows); issues = issues.concat(r.issues.map(x => files[i].name + ': ' + x));
    }
    drawPdfPreview(rows, issues);
  }, 'กำลังอ่าน PDF...'));
  function drawPdfPreview(rows, issues) {
    const fs_ = failSet(); const fails = rows.filter(r => fs_.includes(r.grade));
    const terms = [...new Set(rows.map(r => r.semester + '/' + r.year))];
    const classes = [...new Set(rows.map(r => r.class))].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
    $('#im-pdf-res').innerHTML = `
      <div class="grid g4" style="margin-top:12px"><div class="box"><b>${new Set(rows.map(r => r.student_id)).size}</b> นักเรียน</div><div class="box"><b>${rows.length}</b> ผลการเรียน</div>
        <div class="box"><b>${esc(classes.join(', ') || '-')}</b></div><div class="box"><b style="color:var(--bad)">${fails.length}</b> ติด 0/ร/มส/มผ</div></div>
      <div class="small muted" style="margin-top:6px">ภาคเรียน/ปีการศึกษาในไฟล์: ${esc(terms.join(', ') || '-')} · รายวิชาที่ยังไม่มีผลจะไม่ถูกนำเข้า</div>
      ${issues.length ? `<div class="alert warn small" style="margin-top:8px">${issues.slice(0, 10).map(esc).join('<br>')}${issues.length > 10 ? '<br>…' : ''}</div>` : ''}
      <div class="tbl-wrap" style="margin-top:10px;max-height:260px"><table class="tbl"><thead><tr><th>เลขประจำตัว</th><th>ชั้น</th><th>รหัสวิชา</th><th>รายวิชา</th><th>หน่วยกิต</th><th>ผล</th></tr></thead><tbody>
      ${fails.concat(rows.filter(r => !fs_.includes(r.grade))).slice(0, 40).map(r => `<tr class="${fs_.includes(r.grade) ? 'fail' : ''}"><td>${esc(r.student_id)}</td><td>${esc(r.class)}</td><td>${esc(r.subject_code)}</td><td>${esc(r.subject_name)}</td><td>${esc(r.credit)}</td><td>${gradeChip(r.grade, fs_.includes(r.grade) ? 'fail' : '')}</td></tr>`).join('')}</tbody></table></div>
      <button class="btn pri" id="im-pdf-go" style="margin-top:12px" ${rows.length ? '' : 'disabled'}>นำเข้า ${rows.length} รายการ</button><div id="im-result"></div>`;
    $('#im-pdf-go').onclick = () => quiet(run(() => doImport(rows, $('#im-y').value.trim(), $('#im-s').value, false), 'กำลังนำเข้า...'));
  }
  $('#im-file', v).onchange = e => quiet(run(async () => {
    const f = e.target.files[0]; if (!f) return;
    await loadXLSX();
    st.wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    st.sheetNames = st.wb.SheetNames;
    pickSheet(st.sheetNames[0]);
  }, 'กำลังอ่านไฟล์...'));
  function pickSheet(name) {
    st.sheet = name;
    st.aoa = XLSX.utils.sheet_to_json(st.wb.Sheets[name], { header: 1, defval: '', raw: false }).map(r => r.map(c => String(c).trim()));
    st.headerRow = Math.max(0, st.aoa.slice(0, 20).findIndex(r => r.some(c => /เลขประจำตัว|รหัสนักเรียน|รหัสประจำตัว/.test(c))));
    autoMap(); drawStep2();
  }
  function headers() { return (st.aoa[st.headerRow] || []).map((h, i) => h || ('คอลัมน์ ' + (i + 1))); }
  function autoMap() {
    const h = st.aoa[st.headerRow] || [];
    st.map = guessMap(h, FIELDS);
    st.mode = (st.map.subject_code !== undefined && st.map.grade !== undefined) ? 'long' : 'wide';
    if (st.mode === 'wide') {
      st.map = guessMap(h, FIELDS.filter(f => WIDE_FIXED.includes(f[0])));
      const fixed = new Set(Object.values(st.map));
      st.subjectCols = h.map((x, i) => i).filter(i => !fixed.has(i) && h[i] && !/^(ที่|ลำดับ|รวม|เฉลี่ย|gpa|gpax|หมายเหตุ|อันดับ)/i.test(h[i]));
    }
  }
  function buildRows() {
    const out = [];
    const body = st.aoa.slice(st.headerRow + 1);
    const g = (r, k) => st.map[k] !== undefined ? r[st.map[k]] : '';
    const h = headers();
    const fixedCls = ($('#im-cls') || {}).value || '';
    body.forEach(r => {
      const sid = lowerSid(g(r, 'student_id'));
      if (!sid || !/^[0-9a-z]+$/.test(sid)) return;
      const base = { student_id: sid, name: g(r, 'name'), class: g(r, 'class') || fixedCls, number: g(r, 'number'), birthdate: g(r, 'birthdate'), year: g(r, 'year'), semester: g(r, 'semester') };
      if (st.mode === 'long') {
        out.push({ ...base, subject_code: g(r, 'subject_code'), subject_name: g(r, 'subject_name'), credit: g(r, 'credit'), grade: normGrade(g(r, 'grade')), teacher: g(r, 'teacher') });
      } else {
        st.subjectCols.forEach(i => {
          const grade = normGrade(r[i]); if (!grade) return;
          const m = h[i].match(/([ก-ฮA-Za-z]{1,3}\s?\d{5})/);
          const code = m ? m[1].replace(/\s/g, '') : h[i];
          out.push({ ...base, subject_code: code, subject_name: m ? h[i].replace(m[1], '').trim() : '', credit: '', grade, teacher: '' });
        });
      }
    });
    return out;
  }
  function drawStep2() {
    const h = headers();
    const fields = st.mode === 'long' ? FIELDS : FIELDS.filter(f => WIDE_FIXED.includes(f[0]));
    const rows = buildRows();
    const fails = rows.filter(r => failSet().includes(r.grade));
    $('#im-step2').innerHTML = `
      <div class="card"><h3>2. จับคู่คอลัมน์</h3>
        <div class="grid g3">
          <label class="f"><span>ชีต</span><select class="in" id="im-sheet">${st.sheetNames.map(n => `<option ${n === st.sheet ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label class="f"><span>แถวหัวตาราง</span><select class="in" id="im-hr">${st.aoa.slice(0, 20).map((r, i) => `<option value="${i}" ${i === st.headerRow ? 'selected' : ''}>แถว ${i + 1}: ${esc(r.filter(Boolean).slice(0, 4).join(' | ').slice(0, 60))}</option>`).join('')}</select></label>
          <label class="f"><span>รูปแบบไฟล์</span><select class="in" id="im-mode"><option value="long" ${st.mode === 'long' ? 'selected' : ''}>แถวละ 1 รายวิชา</option><option value="wide" ${st.mode === 'wide' ? 'selected' : ''}>แถวละ 1 นักเรียน (คอลัมน์=รายวิชา)</option></select></label>
        </div>
        <div class="grid g3">${fields.map(([k, l]) => `<label class="f"><span>${l}</span><select class="in" data-map="${k}"><option value="">— ไม่มี —</option>${h.map((x, i) => `<option value="${i}" ${st.map[k] === i ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`).join('')}
          <label class="f"><span>ชั้น/ห้อง (ใช้เมื่อไฟล์ไม่มีคอลัมน์ชั้น)</span><input class="in" id="im-cls" placeholder="เช่น ม.4/1"></label></div>
        ${st.mode === 'wide' ? `<div><div class="small muted">คอลัมน์ที่เป็นรายวิชา</div>${h.map((x, i) => Object.values(st.map).includes(i) ? '' : `<label class="chk"><input type="checkbox" data-sc="${i}" ${st.subjectCols.includes(i) ? 'checked' : ''}>${esc(x)}</label>`).join('')}</div>` : ''}
        <label class="chk" style="margin-top:8px"><input type="checkbox" id="im-bd">ใช้วันเกิดเป็นรหัสเริ่มต้นของนักเรียนใหม่ (ไม่แนะนำ — ค่าเริ่มต้นคือรหัสสุ่ม 6 ตัว)</label>
      </div>
      <div class="card"><h3>3. ตรวจสอบก่อนนำเข้า</h3>
        <div class="grid g4"><div class="box"><b>${rows.length}</b> รายการผลการเรียน</div><div class="box"><b>${new Set(rows.map(r => r.student_id)).size}</b> นักเรียน</div>
        <div class="box"><b>${new Set(rows.map(r => r.subject_code)).size}</b> รายวิชา</div><div class="box"><b style="color:var(--bad)">${fails.length}</b> ติด 0/ร/มส/มผ</div></div>
        <div class="tbl-wrap" style="margin-top:10px;max-height:300px"><table class="tbl"><thead><tr><th>เลขประจำตัว</th><th>ชื่อ</th><th>ชั้น</th><th>รหัสวิชา</th><th>รายวิชา</th><th>หน่วยกิต</th><th>ผล</th><th>ครู</th></tr></thead><tbody>
        ${rows.slice(0, 30).map(r => `<tr class="${failSet().includes(r.grade) ? 'fail' : ''}"><td>${esc(r.student_id)}</td><td>${esc(r.name)}</td><td>${esc(r.class)}</td><td>${esc(r.subject_code)}</td><td>${esc(r.subject_name)}</td><td>${esc(r.credit)}</td><td>${gradeChip(r.grade, failSet().includes(r.grade) ? 'fail' : '')}</td><td>${esc(r.teacher)}</td></tr>`).join('')}</tbody></table></div>
        <button class="btn pri" id="im-go" style="margin-top:12px" ${rows.length ? '' : 'disabled'}>นำเข้า ${rows.length} รายการ</button>
        <div id="im-result"></div></div>`;
    $('#im-sheet').onchange = e => pickSheet(e.target.value);
    $('#im-hr').onchange = e => { st.headerRow = Number(e.target.value); autoMap(); drawStep2(); };
    $('#im-mode').onchange = e => { st.mode = e.target.value; const keep = st.headerRow; autoMap(); st.mode = e.target.value; st.headerRow = keep; drawStep2(); };
    $$('[data-map]').forEach(s => s.onchange = () => { s.value === '' ? delete st.map[s.dataset.map] : st.map[s.dataset.map] = Number(s.value); drawStep2(); });
    $$('[data-sc]').forEach(c => c.onchange = () => { st.subjectCols = $$('[data-sc]:checked').map(x => Number(x.dataset.sc)); drawStep2(); });
    $('#im-go').onclick = () => quiet(run(() => doImport(buildRows(), $('#im-y').value.trim(), $('#im-s').value, $('#im-bd').checked), 'กำลังนำเข้า...'));
  }
};

async function doImport(rows, year, sem, useBirth) {
  if (!year || !sem) throw new Error('กรุณาระบุปีการศึกษาและภาคเรียน');
  const staff = await loadStaff(true);
  const byName = {}; staff.forEach(x => byName[normName(x.name)] = x);
  const resolveT = raw => {
    raw = String(raw || '').trim(); if (!raw) return { email: '', name: '' };
    if (raw.includes('@')) { const e = raw.toLowerCase(); const f = staff.find(x => x.id === e); return { email: e, name: f ? f.name : raw }; }
    const f = byName[normName(raw)]; return { email: f ? f.id : '', name: raw };
  };
  loading(true, 'กำลังตรวจสอบนักเรียนเดิม...');
  const existing = new Set((await F.getDocs(R.col('student_ver'))).docs.map(d => d.id));
  const terms = {}, students = {}, courses = {}, unresolved = new Set();
  rows.forEach(x => {
    const y = String(x.year || year).trim(), s = String(x.semester || sem).trim();
    const tid = x.student_id + '_' + y + '_' + s;
    const t = terms[tid] || (terms[tid] = { student_id: x.student_id, academic_year: y, semester: s, class: x.class, number: x.number, subjects: {} });
    if (x.name) t.name = x.name;
    if (x.class) t.class = x.class;
    students[x.student_id] = { name: x.name || (students[x.student_id] || {}).name || '', class: x.class || (students[x.student_id] || {}).class || '', number: x.number || '', birthdate: x.birthdate || '' };
    if (!x.subject_code) return;
    const te = resolveT(x.teacher);
    if (te.name && !te.email) unresolved.add(te.name);
    const sub = { name: x.subject_name || '', credit: String(x.credit || ''), grade: x.grade };
    if (te.name) sub.teacher_name = te.name;
    if (te.email) sub.teacher_email = te.email;
    t.subjects[x.subject_code] = sub;
    const cid = y + '_' + s + '_' + x.subject_code + '_' + classKey(t.class);
    const c = courses[cid] || (courses[cid] = { academic_year: y, semester: s, subject_code: x.subject_code, subject_name: x.subject_name || '', class: t.class || '' });
    if (te.name) c.teacher_name = te.name;
    if (te.email) c.teacher_email = te.email;
  });
  const ops = [];
  const newCodes = [];
  for (const sid of Object.keys(students)) {
    const s = students[sid];
    const sd = { updated_at: F.serverTimestamp() };
    if (s.name) sd.name = s.name;
    if (s.class) sd.class = s.class; if (s.number) sd.number = s.number;
    if (!existing.has(sid)) sd.active = true;
    ops.push(['set', R.student(sid), sd]);
    if (!existing.has(sid)) {
      const code = useBirth && s.birthdate.replace(/\D/g, '') ? s.birthdate.replace(/\D/g, '') : genCode();
      ops.push(['set', R.secret(sid), { h: await codeHash(sid, code), code, v: 0 }]);
      ops.push(['set', R.ver(sid), { v: 0 }]);
      newCodes.push([sid, s.name, s.class, code]);
    }
  }
  Object.entries(terms).forEach(([tid, t]) => ops.push(['set', R.term(tid), { ...t, imported_at: F.serverTimestamp() }]));
  Object.entries(courses).forEach(([cid, c]) => ops.push(['set', R.course(cid), c]));
  const classes = [...new Set(Object.values(students).map(s => s.class).filter(Boolean))];
  if (classes.length) ops.push(['set', R.meta(), { classes: F.arrayUnion(...classes) }]);
  for (let i = 0; i < ops.length; i += 450) {
    loading(true, `กำลังบันทึก ${Math.min(i + 450, ops.length)}/${ops.length}`);
    const b = F.writeBatch(db);
    ops.slice(i, i + 450).forEach(([, ref, data]) => b.set(ref, data, { merge: true }));
    await b.commit();
  }
  S._lastCodes = newCodes;
  $('#im-result').innerHTML = `<div class="alert ok" style="margin-top:12px"><b>นำเข้าเรียบร้อย</b><br>
    ผลการเรียน ${Object.keys(terms).length} เอกสาร (นักเรียน×ภาคเรียน) · นักเรียนใหม่ ${newCodes.length} คน · รายวิชา–ห้อง ${Object.keys(courses).length}
    ${unresolved.size ? `<br>⚠️ ชื่อครูที่ยังไม่ตรงกับบัญชีบุคลากร ${unresolved.size} คน: ${esc([...unresolved].slice(0, 15).join(', '))} — เพิ่มบุคลากรด้วยชื่อเดียวกัน หรือกำหนดในเมนู "รายวิชา–ครูผู้สอน"` : ''}</div>
    ${newCodes.length ? `<button class="btn" id="im-codes" style="margin-top:8px">พิมพ์ใบรหัสเริ่มต้นนักเรียนใหม่ (${newCodes.length})</button>` : ''}`;
  const bc = $('#im-codes'); if (bc) bc.onclick = () => printCodes(newCodes);
}

function printCodes(list) {
  const url = location.origin + location.pathname;
  const html = `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>รหัสเริ่มต้นนักเรียน</title>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">
  <style>body{font-family:Sarabun,sans-serif;margin:10mm}.g{display:grid;grid-template-columns:1fr 1fr;gap:6mm}.c{border:1px dashed #999;border-radius:6px;padding:4mm;font-size:12pt;break-inside:avoid}
  .code{font-size:20pt;font-weight:700;letter-spacing:.2em}@media print{button{display:none}}</style></head><body>
  <button onclick="print()">พิมพ์</button><div class="g">${list.map(([sid, name, cls, code]) => `<div class="c"><b>${esc(S.settings.school_name)}</b><br>ระบบยื่นคำร้องแก้ไขผลการเรียน<br>
  ${esc(name)} ชั้น ${esc(cls)}<br>เลขประจำตัว <b>${esc(sid)}</b><br>รหัสเริ่มต้น <span class="code">${esc(code)}</span><br>
  <small>เข้า ${esc(url)} → "เข้าใช้ครั้งแรก" แล้วตั้งรหัสผ่านของตัวเอง</small></div>`).join('')}</div></body></html>`;
  const m = modal(`<div class="modal-h"><h3>ใบรหัสเริ่มต้น (${list.length})</h3><button class="x" data-close>×</button></div><div class="modal-b"><iframe class="memo" id="cd-fr"></iframe></div>
    <div class="modal-f"><button class="btn" id="cd-csv">CSV</button><button class="btn pri" id="cd-print">พิมพ์</button></div>`, { lg: true });
  $('#cd-fr', m).srcdoc = html;
  $('#cd-print', m).onclick = () => $('#cd-fr', m).contentWindow.print();
  $('#cd-csv', m).onclick = () => download('รหัสเริ่มต้นนักเรียน.csv', csv([['เลขประจำตัว', 'ชื่อ', 'ชั้น', 'รหัสเริ่มต้น'], ...list]));
}

/* ---------------- นักเรียน ---------------- */
VIEWS.students = async () => {
  const v = $('#view');
  const meta = await F.getDoc(R.meta());
  const classes = (meta.exists() ? meta.data().classes || [] : []).slice().sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
  v.innerHTML = `<div class="card"><div class="row">
    <label class="f"><span>ชั้น/ห้อง</span><select class="in" id="sv-cls"><option value="">-- เลือก --</option>${classes.map(c => `<option ${c === S._svCls ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label class="f"><span>หรือค้นหาเลขประจำตัว</span><input class="in" id="sv-sid" placeholder="เลขประจำตัว"></label>
    <button class="btn" id="sv-find" style="margin-top:12px">ค้นหา</button></div><div id="sv-list" class="muted small">เลือกชั้นเพื่อแสดงรายชื่อ</div></div>`;
  const show = async (list) => {
    const info = await Promise.all(list.map(async s => {
      const [sec, ln] = await Promise.all([F.getDoc(R.secret(s.id)), F.getDoc(R.link(s.id))]);
      return { ...s, code: sec.exists() ? sec.data().code : '', v: sec.exists() ? sec.data().v || 0 : 0, active_acc: ln.exists() };
    }));
    info.sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0) || a.id.localeCompare(b.id));
    $('#sv-list').innerHTML = `<div class="row" style="margin:8px 0"><span class="small muted grow">${info.length} คน · เปิดใช้งานแล้ว ${info.filter(x => x.active_acc).length}</span>
      <button class="btn sm" id="sv-print">พิมพ์ใบรหัส (ที่ยังไม่เปิดใช้งาน)</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>เลขที่</th><th>เลขประจำตัว</th><th>ชื่อ–สกุล</th><th>ชั้น</th><th>บัญชี</th><th>รหัสเริ่มต้น</th><th></th></tr></thead><tbody>
      ${info.map(s => `<tr><td>${esc(s.number)}</td><td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.class)}</td>
        <td>${s.active_acc ? '<span class="badge b-green">เปิดใช้งานแล้ว</span>' : '<span class="badge b-gray">ยังไม่เปิด</span>'}</td>
        <td><code>${s.active_acc ? '—' : esc(s.code)}</code></td><td class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" data-ename="${esc(s.id)}">แก้ชื่อ</button><button class="btn sm warn" data-reset="${esc(s.id)}">รีเซ็ตรหัส</button></td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-ename]').forEach(b => b.onclick = () => {
      const s = info.find(x => x.id === b.dataset.ename);
      const m = modal(`<div class="modal-h"><h3>แก้ไขชื่อนักเรียน ${esc(s.id)}</h3><button class="x" data-close>×</button></div>
        <div class="modal-b"><label class="f"><span>ชื่อ–สกุล</span><input class="in" id="en-name" value="${esc(s.name)}"></label>
        <label class="f"><span>เลขที่</span><input class="in" id="en-no" value="${esc(s.number || '')}"></label></div>
        <div class="modal-f"><button class="btn" data-close>ยกเลิก</button><button class="btn pri" id="en-ok">บันทึก</button></div>`);
      $('#en-ok', m).onclick = () => quiet(run(async () => {
        const nm = $('#en-name', m).value.trim(); if (!nm) throw new Error('กรุณาระบุชื่อ');
        await F.updateDoc(R.student(s.id), { name: nm, number: $('#en-no', m).value.trim() });
        closeModal(); toast('บันทึกแล้ว', 'ok'); const cls = $('#sv-cls').value; if (cls) loadCls(cls); else show([{ ...s, name: nm }]);
      }));
    });
    $('#sv-print').onclick = () => printCodes(info.filter(x => !x.active_acc && x.code).map(x => [x.id, x.name, x.class, x.code]));
    $$('[data-reset]').forEach(b => b.onclick = async () => {
      const s = info.find(x => x.id === b.dataset.reset);
      if (!await confirmDlg('รีเซ็ตรหัสผ่านนักเรียน', `ออกรหัสเริ่มต้นใหม่ให้ <b>${esc(s.name)}</b> (${esc(s.id)})<br><span class="small muted">รหัสผ่านเดิมจะใช้ไม่ได้ นักเรียนต้อง "เข้าใช้ครั้งแรก" ใหม่ด้วยรหัสเริ่มต้นนี้</span>`, 'รีเซ็ต', 'bad')) return;
      quiet(run(async () => {
        const code = genCode(); const nv = s.v + 1;
        const bt = F.writeBatch(db);
        bt.set(R.secret(s.id), { h: await codeHash(s.id, code), code, v: nv });
        bt.set(R.ver(s.id), { v: nv });
        bt.delete(R.link(s.id));
        await bt.commit();
        await confirmDlg('รหัสเริ่มต้นใหม่', `<div class="center">${esc(s.name)}<br>เลขประจำตัว <b>${esc(s.id)}</b><div style="font-size:2rem;letter-spacing:.2em;font-weight:700;margin:10px">${code}</div></div>`, 'ตกลง');
        const cls = $('#sv-cls').value; if (cls) loadCls(cls);
      }));
    });
  };
  const loadCls = cls => quiet(run(async () => { S._svCls = cls; await show(snapList(await F.getDocs(F.query(R.col('students'), F.where('class', '==', cls))))); }));
  $('#sv-cls').onchange = e => e.target.value && loadCls(e.target.value);
  $('#sv-find').onclick = () => quiet(run(async () => { const sid = lowerSid($('#sv-sid').value); if (!sid) return; const s = await F.getDoc(R.student(sid)); if (!s.exists()) throw new Error('ไม่พบนักเรียน'); await show([{ id: s.id, ...s.data() }]); }));
  if (S._svCls) loadCls(S._svCls);
};

/* ---------------- รายวิชา–ครู ---------------- */
VIEWS.courses = async () => {
  const v = $('#view');
  const y = S._cY || S.settings.current_year, s = S._cS || S.settings.current_semester;
  v.innerHTML = `<div class="card"><div class="row">
    <label class="f"><span>ปีการศึกษา</span><input class="in" id="c-y" value="${esc(y)}" style="width:110px"></label>
    <label class="f"><span>ภาคเรียน</span><select class="in" id="c-s">${['1', '2', '3'].map(x => `<option ${x === String(s) ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label class="f grow"><span>ค้นหา</span><input class="in" id="c-q"></label>
    <label class="chk" style="margin-top:12px"><input type="checkbox" id="c-no">เฉพาะที่ยังไม่มีครู</label>
    <button class="btn" id="c-load" style="margin-top:12px">โหลด</button></div><div id="c-list"></div></div>`;
  let rows = [], staff = [];
  const draw = () => {
    const q = $('#c-q').value.toLowerCase(), no = $('#c-no').checked;
    const list = rows.filter(c => (!no || !c.teacher_email) && (!q || [c.subject_code, c.subject_name, c.class, c.teacher_name].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => (a.subject_code + a.class).localeCompare(b.subject_code + b.class, 'th', { numeric: true }));
    $('#c-list').innerHTML = `<div class="small muted" style="margin:6px 0">${list.length} รายการ · ยังไม่มีครู ${rows.filter(c => !c.teacher_email).length}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>รหัสวิชา</th><th>รายวิชา</th><th>ชั้น</th><th>ชื่อครูจากไฟล์</th><th>บัญชีครูผู้สอน</th></tr></thead><tbody>
      ${list.map(c => `<tr><td><b>${esc(c.subject_code)}</b></td><td>${esc(c.subject_name)}</td><td>${esc(c.class)}</td><td class="small">${esc(c.teacher_name || '')}</td>
      <td><select class="in" data-cid="${esc(c.id)}" style="min-width:200px"><option value="">— ยังไม่กำหนด —</option>${staff.map(t => `<option value="${esc(t.id)}" ${t.id === c.teacher_email ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-cid]').forEach(sel => sel.onchange = () => quiet(run(async () => {
      const c = rows.find(x => x.id === sel.dataset.cid); const t = staff.find(x => x.id === sel.value);
      const patch = { teacher_email: t ? t.id : '', teacher_name: t ? t.name : (c.teacher_name || '') };
      await F.updateDoc(R.course(c.id), patch);
      Object.assign(c, patch);
      // คำร้องที่ยังไม่มีครูของรายวิชานี้ → กำหนดครูให้
      if (t) {
        const rq = snapList(await F.getDocs(F.query(R.col('requests'), F.where('course_id', '==', c.id))))
          .filter(r => !r.teacher_email && ['SUBMITTED', ...WORKING].includes(r.status));
        for (const r of rq) await act(r, { teacher_email: t.id, teacher_name: t.name }, 'กำหนดครูผู้สอน', t.name);
        toast('บันทึกแล้ว' + (rq.length ? ` และส่งคำร้องค้าง ${rq.length} รายการถึงครู` : ''), 'ok');
      } else toast('บันทึกแล้ว', 'ok');
    })));
  };
  const load = async () => {
    S._cY = $('#c-y').value.trim(); S._cS = $('#c-s').value;
    staff = (await loadStaff()).filter(x => x.active !== false);
    rows = snapList(await F.getDocs(F.query(R.col('courses'), F.where('academic_year', '==', S._cY), F.where('semester', '==', S._cS))));
    draw();
  };
  $('#c-load').onclick = () => quiet(run(load));
  $('#c-q').oninput = draw; $('#c-no').onchange = draw;
  await quiet(run(load));
};

/* ---------------- บุคลากร ---------------- */
VIEWS.users = async () => {
  const v = $('#view');
  const list = await loadStaff(true);
  v.innerHTML = `<div class="card"><div class="row" style="margin-bottom:10px"><span class="grow small muted">${list.length} คน — บุคลากรเข้าสู่ระบบด้วยบัญชี Google ตามอีเมลที่ลงทะเบียน</span><button class="btn pri" id="u-add">+ เพิ่มบุคลากร</button></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>ตำแหน่ง</th><th>บทบาท</th><th>สถานะ</th><th></th></tr></thead><tbody>
    ${list.map(u => `<tr><td><b>${esc(u.name)}</b><div class="small muted">${esc(u.department || '')}</div></td><td class="small">${esc(u.id)}</td><td class="small">${esc(u.position || '')}</td>
      <td>${(u.roles || []).map(r => `<span class="badge b-indigo">${esc(ROLE_LABEL[r] || r)}</span>`).join(' ')}</td>
      <td>${u.active === false ? '<span class="badge b-gray">ระงับ</span>' : '<span class="badge b-green">ใช้งาน</span>'}</td><td><button class="btn sm" data-ed="${esc(u.id)}">แก้ไข</button></td></tr>`).join('')}</tbody></table></div>
    <div class="card" style="margin-top:14px"><h3>เพิ่มหลายคนพร้อมกัน</h3><p class="small muted" style="margin-top:0">วางข้อมูลจาก Excel: <code>อีเมล [Tab] ชื่อ-สกุล [Tab] ตำแหน่ง [Tab] กลุ่มสาระ</code> บรรทัดละ 1 คน (บทบาท = ครูผู้สอน)</p>
      <textarea class="in" id="u-bulk" style="min-height:100px"></textarea><button class="btn" id="u-bulk-go" style="margin-top:8px">เพิ่มทั้งหมด</button></div></div>`;
  $('#u-add', v).onclick = () => userDlg(null);
  $$('[data-ed]', v).forEach(b => b.onclick = () => userDlg(list.find(x => x.id === b.dataset.ed)));
  $('#u-bulk-go', v).onclick = () => quiet(run(async () => {
    const lines = $('#u-bulk', v).value.split(/\r?\n/).map(l => l.split('\t').map(x => x.trim())).filter(l => /@/.test(l[0] || ''));
    if (!lines.length) throw new Error('ไม่พบข้อมูลที่มีอีเมล');
    const b = F.writeBatch(db);
    lines.forEach(([em, name, pos, dept]) => b.set(R.staff(em.toLowerCase()), { name: name || em, position: pos || 'ครู', department: dept || '', roles: ['teacher'], active: true }, { merge: true }));
    await b.commit();
    await linkTeachers(lines.map(([em, name]) => ({ id: em.toLowerCase(), name })));
    toast('เพิ่ม ' + lines.length + ' คนแล้ว', 'ok'); VIEWS.users();
  }));
};
function userDlg(u) {
  const roles = ['teacher', 'measure', 'academic', 'director', 'admin'];
  const m = modal(`<div class="modal-h"><h3>${u ? 'แก้ไขบุคลากร' : 'เพิ่มบุคลากร'}</h3><button class="x" data-close>×</button></div><div class="modal-b">
    <label class="f"><span>อีเมล (บัญชี Google)</span><input class="in" id="ud-em" value="${esc(u ? u.id : '')}" ${u ? 'disabled' : ''}></label>
    <label class="f"><span>ชื่อ–สกุล (ใช้ในการลงนาม)</span><input class="in" id="ud-name" value="${esc(u ? u.name : '')}"></label>
    <div class="grid g2"><label class="f"><span>ตำแหน่ง</span><input class="in" id="ud-pos" value="${esc(u ? u.position || '' : 'ครู')}"></label>
    <label class="f"><span>กลุ่มสาระ/ฝ่าย</span><input class="in" id="ud-dept" value="${esc(u ? u.department || '' : '')}"></label></div>
    <div class="f"><span class="small muted">บทบาท</span><div>${roles.map(r => `<label class="chk"><input type="checkbox" value="${r}" class="ud-role" ${(u ? u.roles || [] : ['teacher']).includes(r) ? 'checked' : ''}>${ROLE_LABEL[r]}</label>`).join('')}</div></div>
    <label class="chk"><input type="checkbox" id="ud-act" ${!u || u.active !== false ? 'checked' : ''}>ใช้งาน</label></div>
    <div class="modal-f"><button class="btn" data-close>ยกเลิก</button><button class="btn pri" id="ud-save">บันทึก</button></div>`);
  $('#ud-save', m).onclick = () => quiet(run(async () => {
    const em = $('#ud-em', m).value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new Error('อีเมลไม่ถูกต้อง');
    const name = $('#ud-name', m).value.trim(); if (!name) throw new Error('กรุณาระบุชื่อ');
    const rs = $$('.ud-role:checked', m).map(c => c.value);
    if (em === S.me.email && !rs.includes('admin') && em !== BOOTSTRAP_ADMIN) throw new Error('ไม่สามารถถอดสิทธิ์ผู้ดูแลของตนเองได้');
    await F.setDoc(R.staff(em), { name, position: $('#ud-pos', m).value.trim(), department: $('#ud-dept', m).value.trim(), roles: rs, active: $('#ud-act', m).checked }, { merge: true });
    if (!u) await linkTeachers([{ id: em, name }]);
    closeModal(); toast('บันทึกแล้ว', 'ok'); VIEWS.users();
  }));
}
async function linkTeachers(list) {
  // ผูกอีเมลครูกับรายวิชาในภาคเรียนปัจจุบันที่นำเข้ามาด้วย "ชื่อ"
  const cs = snapList(await F.getDocs(F.query(R.col('courses'), F.where('academic_year', '==', S.settings.current_year), F.where('semester', '==', S.settings.current_semester))));
  const by = {}; list.forEach(x => by[normName(x.name)] = x);
  const hit = cs.filter(c => !c.teacher_email && c.teacher_name && by[normName(c.teacher_name)]);
  for (let i = 0; i < hit.length; i += 450) {
    const b = F.writeBatch(db);
    hit.slice(i, i + 450).forEach(c => b.update(R.course(c.id), { teacher_email: by[normName(c.teacher_name)].id }));
    await b.commit();
  }
  if (hit.length) toast(`ผูกครูกับรายวิชา ${hit.length} รายการ`, 'ok');
  S.staffList = null;
}

/* ---------------- ตั้งค่า ---------------- */
VIEWS.settings = async () => {
  await loadSettings();
  const s = S.settings;
  const F2 = [['school_name', 'ชื่อโรงเรียน'], ['current_year', 'ปีการศึกษาปัจจุบัน'], ['current_semester', 'ภาคเรียนปัจจุบัน'],
    ['max_attempts', 'ยื่นแก้ไขได้สูงสุด (ครั้ง/วิชา)'], ['max_grade_0', 'ผลสูงสุดเมื่อแก้ 0'], ['max_grade_ms', 'ผลสูงสุดเมื่อแก้ มส'],
    ['max_upload_mb', 'ขนาดไฟล์สูงสุด (MB)'], ['memo_department', 'ส่วนราชการ (บันทึกข้อความ)'], ['memo_prefix', 'คำนำหน้าเลขที่บันทึก'],
    ['memo_to', 'เรียน (บันทึกข้อความ)'], ['director_name', 'ชื่อ ผอ. (ในบันทึก)'], ['director_position', 'ตำแหน่ง ผอ. (ในบันทึก)'], ['garuda_url', 'URL รูปครุฑ']];
  $('#view').innerHTML = `<div class="card"><div class="grid g2">${F2.map(([k, l]) => `<label class="f"><span>${l}</span><input class="in" data-k="${k}" value="${esc(s[k] == null ? '' : s[k])}"></label>`).join('')}
    <label class="f"><span>ผลการเรียนที่ต้องแก้ไข (คั่นด้วย ,)</span><input class="in" data-k="fail_grades" value="${esc((s.fail_grades || []).join(','))}"></label></div>
    <button class="btn pri" id="st-save">บันทึกการตั้งค่า</button></div>`;
  $('#st-save').onclick = () => quiet(run(async () => {
    const o = {};
    $$('[data-k]').forEach(i => o[i.dataset.k] = i.value.trim());
    o.fail_grades = o.fail_grades.split(',').map(x => x.trim()).filter(Boolean);
    ['max_attempts', 'max_grade_0', 'max_grade_ms', 'max_upload_mb'].forEach(k => o[k] = Number(o[k]) || DEFAULT_SETTINGS[k]);
    o.allowed = computeAllowed(o.max_grade_0, o.max_grade_ms);
    await F.setDoc(R.settings(), o, { merge: true });
    await loadSettings(); toast('บันทึกแล้ว', 'ok');
  }));
};

/* =========================== start =========================== */
loadSettings().finally(() => {
  F.onAuthStateChanged(auth, user => { if (!S.activating) handleUser(user); });
});
