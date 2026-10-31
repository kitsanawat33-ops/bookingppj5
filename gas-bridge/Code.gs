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
    throw new Error('ไม่รู้จักคำสั่ง');
  } catch (err) {
    return out_(null, err);
  }
}

function doGet() {
  return ContentService.createTextOutput('OK — ตัวเชื่อม Google Drive พร้อมใช้งาน');
}

function upload_(b, token, email) {
  const rid = String(b.request_id || '');
  const req = fsGet_('requests/' + encodeURIComponent(rid), token); // ตรวจสิทธิ์ผ่าน Security Rules
  const f = fields_(req);
  const isStudent = email.endsWith('@' + STUDENT_EMAIL_DOMAIN);
  if (isStudent) {
    const sid = email.split('@')[0].split('.')[0];
    if (f.student_id !== sid) throw new Error('ไม่ใช่คำร้องของคุณ');
    if (['ASSIGNED', 'REVISE', 'WORK_SUBMITTED'].indexOf(f.status) < 0) throw new Error('ยังส่งงานไม่ได้ในขั้นตอนนี้');
  } else {
    if (f.teacher_email !== email) throw new Error('เฉพาะครูผู้สอนของคำร้องนี้');
    if (['ASSIGNED', 'REVISE', 'WORK_SUBMITTED', 'RETURNED'].indexOf(f.status) < 0) throw new Error('แนบไฟล์ไม่ได้ในขั้นตอนนี้');
  }
  const bytes = Utilities.base64Decode(String(b.data || ''));
  if (bytes.length > MAX_MB * 1024 * 1024) throw new Error('ไฟล์ใหญ่เกิน ' + MAX_MB + ' MB');
  const name = String(b.name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150);
  const folder = sub_(sub_(root_(), f.academic_year + '-' + f.semester), rid);
  const file = folder.createFile(Utilities.newBlob(bytes, b.mime || 'application/octet-stream', name));
  file.setDescription('คำร้อง ' + rid + ' อัปโหลดโดย ' + email);
  return { drive_id: file.getId(), size: bytes.length };
}

function download_(b, token) {
  const rid = String(b.request_id || ''), fid = String(b.file_id || '');
  const meta = fsGet_('requests/' + encodeURIComponent(rid) + '/files/' + encodeURIComponent(fid), token);
  const id = fields_(meta).drive_id;
  const file = DriveApp.getFileById(id);
  // กันการอ้างไฟล์ของคำร้องอื่น: ไฟล์ต้องอยู่ในโฟลเดอร์ชื่อเลขคำร้องนี้
  const parents = file.getParents();
  let okFolder = false;
  while (parents.hasNext()) if (parents.next().getName() === rid) okFolder = true;
  if (!okFolder) throw new Error('ไฟล์ไม่ตรงกับคำร้อง');
  const blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

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
  Object.keys(f).forEach(k => { const v = f[k]; o[k] = v.stringValue !== undefined ? v.stringValue : (v.integerValue !== undefined ? v.integerValue : ''); });
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
function authorize() { root_(); UrlFetchApp.fetch('https://www.google.com'); Logger.log('พร้อมใช้งาน: ' + root_().getUrl()); }
