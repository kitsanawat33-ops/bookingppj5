/**
 * ตัวเชื่อมเก็บไฟล์งานใน Google Drive สำหรับระบบยื่นคำร้องแก้ไขผลการเรียน (Firebase)
 *
 * หลักการ: หน้าเว็บส่ง Firebase ID Token มาด้วยทุกครั้ง สคริปต์นี้นำ token ไปอ่านคำร้องจาก Firestore
 * "ในนามผู้ใช้คนนั้น" — ถ้า Security Rules ไม่ให้อ่าน แปลว่าไม่ใช่ผู้เกี่ยวข้อง จึงปฏิเสธทันที
 * (ไม่ต้องเก็บกุญแจ service account ใดๆ)
 *
 * ติดตั้ง: script.google.com → โปรเจกต์ใหม่ → วางไฟล์นี้ → แก้ FIREBASE_PROJECT_ID
 *          → Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone
 *          → นำ URL ไปใส่ GAS_URL ใน public/config.js
 */

const FIREBASE_PROJECT_ID = 'ppj-grade-fix';
const STUDENT_EMAIL_DOMAIN = 'stu.ppj.ac.th';
const ROOT_FOLDER_NAME = 'ระบบแก้ไขผลการเรียน - ไฟล์งาน';
const MAX_MB = 10;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = String(body.idToken || '');
    const claims = jwtPayload_(token);
    if (claims.aud !== FIREBASE_PROJECT_ID) throw new Error('token ไม่ใช่ของโปรเจกต์นี้');
    const email = String(claims.email || '').toLowerCase();
    if (body.action === 'upload') return out_(upload_(body, token, email));
    if (body.action === 'download') return out_(download_(body, token));
    if (body.action === 'notify') return out_(notify_(body, token));
    throw new Error('ไม่รู้จักคำสั่ง');
  } catch (err) {
    return out_(null, err);
  }
}

function doGet() {
  return ContentService.createTextOutput('OK — ตัวเชื่อม Google Drive พร้อมใช้งาน');
}

// นักเรียนอัปโหลดหลักฐาน (ใบแก้ 0/ร) ครั้งเดียว ใช้ร่วมกันได้หลายคำร้อง (request_ids)
function upload_(b, token, email) {
  const ids = (Array.isArray(b.request_ids) && b.request_ids.length ? b.request_ids : [b.request_id]).map(String).slice(0, 30);
  if (!ids[0]) throw new Error('ไม่พบเลขคำร้อง');
  if (!email.endsWith('@' + STUDENT_EMAIL_DOMAIN)) throw new Error('เฉพาะนักเรียนเจ้าของคำร้องแนบหลักฐานได้');
  const sid = email.split('@')[0].split('.')[0];
  let first = null;
  ids.forEach(rid => {
    const f = fields_(fsGet_('requests/' + encodeURIComponent(rid), token)); // ตรวจสิทธิ์ผ่าน Security Rules
    if (f.student_id !== sid) throw new Error('ไม่ใช่คำร้องของคุณ');
    if (['SUBMITTED', 'REVISE'].indexOf(f.status) < 0) throw new Error('แนบหลักฐานไม่ได้ในขั้นตอนนี้');
    if (!first) first = f;
  });
  const bytes = Utilities.base64Decode(String(b.data || ''));
  if (bytes.length > MAX_MB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + MAX_MB + ' MB');
  const name = String(b.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  const folder = sub_(sub_(root_(), first.academic_year + '-' + first.semester), ids[0]);
  const file = folder.createFile(Utilities.newBlob(bytes, b.mime || 'application/octet-stream', name));
  // บรรทัดแรกของคำอธิบาย = รายการคำร้องที่ใช้ไฟล์นี้ร่วมกัน (ใช้ตรวจตอนเปิดไฟล์)
  file.setDescription('rids:' + ids.join(',') + '\nอัปโหลดโดย ' + email);
  return { drive_id: file.getId(), size: bytes.length };
}

function download_(b, token) {
  const rid = String(b.request_id || ''), fid = String(b.file_id || '');
  const meta = fsGet_('requests/' + encodeURIComponent(rid) + '/files/' + encodeURIComponent(fid), token);
  const id = fields_(meta).drive_id;
  const file = DriveApp.getFileById(id);
  // กันการอ้างไฟล์ของคำร้องอื่น: ไฟล์ต้องอยู่ในโฟลเดอร์ของคำร้องนี้ หรือระบุคำร้องนี้ไว้ในคำอธิบาย
  let ok = false;
  const parents = file.getParents();
  while (parents.hasNext()) if (parents.next().getName() === rid) ok = true;
  const line = String(file.getDescription() || '').split('\n')[0];
  if (!ok && line.indexOf('rids:') === 0 && line.slice(5).split(',').indexOf(rid) >= 0) ok = true;
  if (!ok) throw new Error('ไฟล์ไม่ตรงกับคำร้อง');
  const blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

/* ---------- แจ้งเตือนทางอีเมล ----------
 * ส่งได้เฉพาะเมื่อสถานะคำร้องตรงกับเหตุการณ์จริง (อ่านจาก Firestore ในนามผู้เรียก) และส่งซ้ำไม่ได้ */
const APP_URL = 'https://ppj-grade-fix.web.app';
const SCHOOL_NAME = 'โรงเรียนบ้านโพนแพง เจียรวนนท์อุทิศ 5';
// 1 เลขคำร้องอาจมีหลายรายวิชา → รวมเป็นอีเมลฉบับเดียวต่อเลขคำร้อง
function notify_(b, token) {
  const ev = String(b.event || '');
  const need = { submitted: 'SUBMITTED', approved: 'COMPLETED', returned: 'REVISE', rejected: 'REJECTED' }[ev];
  if (!need) throw new Error('ไม่รู้จักเหตุการณ์');
  const props = PropertiesService.getScriptProperties();
  const groups = {};
  (b.request_ids || []).slice(0, 60).forEach(rid => {
    rid = String(rid);
    const f = fields_(fsGet_('requests/' + encodeURIComponent(rid), token));
    if (f.status !== need) return;
    const key = 'mail_' + ev + '_' + rid + (ev === 'returned' ? '_' + String(f.updated_at || '') : '');  // ส่งกลับได้หลายรอบ
    if (props.getProperty(key)) return;
    const g = f.request_no || rid;
    (groups[g] = groups[g] || []).push({ f: f, key: key });
  });
  let sent = 0;
  Object.keys(groups).forEach(no => {
    const list = groups[no], f = list[0].f;
    let to = '';
    try { to = fields_(fsGet_('students/' + encodeURIComponent(f.student_id), token)).email || ''; } catch (e) { return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('โควตาส่งอีเมลวันนี้หมดแล้ว');
    const codes = list.map(x => x.f.subject_code).join(', ');
    const reason = list.map(x => x.f.academic_comment || x.f.measure_comment).filter(String)[0] || '-';
    const T = {
      submitted: ['ได้รับคำร้องแก้ไขผลการเรียนแล้ว (' + no + ')',
        ['ระบบได้รับคำร้องและหลักฐานของคุณแล้ว', 'งานวัดผลจะตรวจหลักฐาน แล้วเสนอฝ่ายวิชาการอนุมัติ']],
      returned: ['กรุณาแนบหลักฐานใหม่ — คำร้อง ' + no,
        ['คำร้องของคุณถูกส่งกลับให้แนบหลักฐานใหม่ (วิชา ' + esc_(codes) + ')', 'เหตุผล: ' + esc_(reason),
         'เข้าสู่ระบบ → คำร้อง → แนบหลักฐานใหม่และส่งตรวจอีกครั้ง']],
      rejected: ['คำร้อง ' + no + ' ไม่ได้รับการอนุมัติ (' + codes + ')',
        ['คำร้องของคุณไม่ได้รับการอนุมัติ (วิชา ' + esc_(codes) + ')', 'เหตุผล: ' + esc_(reason), 'สอบถามเพิ่มเติมได้ที่งานวัดผล']],
      approved: ['คำร้อง ' + no + ' ได้รับการอนุมัติแล้ว (' + codes + ')',
        ['ฝ่ายวิชาการอนุมัติการแก้ไขผลการเรียนของคุณแล้ว']]
    }[ev];
    const rows = list.map(x => '<tr><td>' + esc_(x.f.subject_code + ' ' + x.f.subject_name) + '</td><td>' + esc_(x.f.semester + '/' + x.f.academic_year) + '</td><td>' +
      esc_(x.f.original_grade) + (ev === 'approved' ? ' → <b>' + esc_(x.f.new_grade) + '</b>' : '') + '</td></tr>').join('');
    const html = '<div style="font-family:Tahoma,sans-serif;font-size:14px;line-height:1.6">' +
      '<p>เรียน ' + esc_(f.student_name) + ' (' + esc_(f.student_id) + ')</p>' +
      T[1].map(l => '<p>' + l + '</p>').join('') +
      '<p>เลขคำร้อง <b>' + esc_(no) + '</b></p>' +
      '<table style="border-collapse:collapse" border="1" cellpadding="6"><tr style="background:#f3f4f6"><th>รายวิชา</th><th>ภาคเรียน</th><th>ผลการเรียน</th></tr>' + rows + '</table>' +
      '<p><a href="' + APP_URL + '">เข้าสู่ระบบเพื่อดูรายละเอียด</a></p>' +
      '<p style="color:#777;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบยื่นคำร้องแก้ไขผลการเรียน ' + SCHOOL_NAME + ' — ไม่ต้องตอบกลับ</p></div>';
    MailApp.sendEmail({ to: to, subject: T[0], htmlBody: html, name: 'ระบบแก้ไขผลการเรียน ' + SCHOOL_NAME });
    const now = new Date().toISOString();
    list.forEach(x => props.setProperty(x.key, now));
    sent++;
  });
  return { sent: sent };
}
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---------- helpers ---------- */
function fsGet_(path, token) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE_PROJECT_ID + '/databases/(default)/documents/' + path;
  const res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 200) return JSON.parse(res.getContentText());
  if (code === 401) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (code === 403) throw new Error('ไม่มีสิทธิ์เข้าถึงคำร้องนี้');
  if (code === 404) throw new Error('ไม่พบข้อมูล');
  throw new Error('Firestore ตอบกลับ ' + code);
}
function fields_(doc) {
  const o = {};
  const f = doc.fields || {};
  Object.keys(f).forEach(k => { const v = f[k]; o[k] = v.stringValue !== undefined ? v.stringValue : (v.integerValue !== undefined ? v.integerValue : (v.timestampValue !== undefined ? v.timestampValue : '')); });
  return o;
}
function jwtPayload_(t) {
  const p = t.split('.')[1];
  if (!p) throw new Error('ไม่พบ token');
  const s = p.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Utilities.newBlob(Utilities.base64Decode(s + '==='.slice((s.length + 3) % 4))).getDataAsString());
}
function root_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* สร้างใหม่ */ } }
  const f = DriveApp.createFolder(ROOT_FOLDER_NAME);
  props.setProperty('ROOT_ID', f.getId());
  return f;
}
function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function out_(data, err) {
  const o = err ? { ok: false, error: String(err.message || err) } : { ok: true, data: data };
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** รันครั้งแรกจาก editor เพื่ออนุญาตสิทธิ์ Drive / UrlFetch */
function authorize() { root_(); UrlFetchApp.fetch('https://www.google.com'); Logger.log('พร้อมใช้งาน: ' + root_().getUrl() + ' · โควตาอีเมลวันนี้: ' + MailApp.getRemainingDailyQuota()); }
