// ทดสอบ Security Rules ทั้งเส้นทางด้วย Firestore Emulator
// รัน: cp ../../firestore.rules r.rules && firebase emulators:exec --only firestore --project demo-gf "node test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc, getDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, collection, deleteField, increment } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-gf', firestore: { rules: readFileSync('r.rules', 'utf8'), host: '127.0.0.1', port: 8085 } });
const ADMIN = 'kitsanawat33@gmail.com', T = 't@x.com', M = 'm@x.com', A = 'a@x.com', D = 'd@x.com';
const SID = '4562', RID = '2569_1_4562_ง31223_1', GK = '2569_1_4562_ง31223';
let pass = 0, fail = 0;
const ok = async (name, p) => { try { await assertSucceeds(p); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + (e.message || '').slice(0, 400)); } };
const no = async (name, p) => { try { await assertFails(p); pass++; console.log('PASS (denied) ' + name); } catch (e) { fail++; console.log('FAIL (should deny) ' + name); } };
await env.withSecurityRulesDisabled(async c => {
  const db = c.firestore();
  const st = (roles, name) => ({ active: true, roles, name, position: 'ครู' });
  await setDoc(doc(db, 'staff', ADMIN), st(['teacher', 'measure', 'academic', 'admin'], 'Admin'));
  await setDoc(doc(db, 'staff', T), st(['teacher'], 'Teacher'));
  await setDoc(doc(db, 'staff', M), st(['teacher', 'measure'], 'Measure'));
  await setDoc(doc(db, 'staff', A), st(['teacher', 'academic'], 'Academic'));
  await setDoc(doc(db, 'staff', D), st(['director'], 'Director'));
  await setDoc(doc(db, 'config', 'settings'), { fail_grades: ['0', 'ร', 'มส', 'มผ'], allowed: { '0': ['1'], 'ร': ['0', '1', '2', '3', '4'], 'มส': ['1'], 'มผ': ['ผ'] } });
  await setDoc(doc(db, 'student_links', SID), { uid: 'stu1', h: 'x', at: Timestamp.now(), dflt: false });
  await setDoc(doc(db, 'students', SID), { student_id: SID, name: 's', class: 'ม.4/2', email: '' });
  await setDoc(doc(db, 'terms', SID + '_2569_1'), { student_id: SID, academic_year: '2569', semester: '1', class: 'ม.4/2',
    subjects: { 'ง31223': { grade: 'ร', teacher_email: '' }, 'ค31101': { grade: '0', teacher_email: '' } } });
  const ts = Timestamp.now();
  await setDoc(doc(db, 'requests', RID), { subject_name: 'x', teacher_name: '', due_date: '', new_grade: '', updated_at: ts, academic_year: '2569', memo_no: '', grade_key: GK, status: 'SUBMITTED', seq: 1, semester: '1', reason: 'r', student_id: SID, student_name: 's', class: 'ม.4/2', request_no: 'RQ', director_comment: '', credit: '0.5', academic_comment: '', created_at: ts, measure_comment: '', subject_code: 'ง31223', original_grade: 'ร', teacher_comment: '', signs: {}, memo_id: '', request_type: 't', course_id: 'c', work_note: '', term_id: SID + '_2569_1', teacher_email: '', assignment: '', files_count: 0 });
});
const staff = em => env.authenticatedContext('u_' + em, { email: em, email_verified: true }).firestore();
const stu = env.authenticatedContext('stu1', { email: SID + '@stu.ppj.ac.th' }).firestore();
const log = (db, rid, actor) => [doc(collection(db, 'requests', rid, 'logs')), { at: serverTimestamp(), actor, actor_name: 'n', role: 'r', action: 'a', detail: '' }];
const sign = em => ({ email: em, name: 'n', position: 'p', at: serverTimestamp() });
const act = (db, em, patch) => { const b = writeBatch(db); b.update(doc(db, 'requests', RID), { ...patch, updated_at: serverTimestamp() }); b.set(...log(db, RID, em)); return b.commit(); };

const SE = SID + '@stu.ppj.ac.th';
const addFiles = (db, n) => { const b = writeBatch(db); b.set(doc(collection(db, 'requests', RID, 'files')), { file_name: 'f', mime: 'image/jpeg', size: 1, drive_id: 'd', note: '', uploader_role: 'student', uploaded_by: SE, uploaded_at: serverTimestamp() });
  b.update(doc(db, 'requests', RID), { work_note: 'n', files_count: increment(n), updated_at: serverTimestamp() }); b.set(...log(db, RID, SE)); return b; };
await ok('admin sets teacher (info)', act(staff(ADMIN), ADMIN, { teacher_email: T, teacher_name: 'Teacher' }));
await ok('student attaches evidence', addFiles(stu, 1).commit());
await ok('student email', updateDoc(doc(stu, 'students', SID), { email: 'a@b.co', email_updated_at: serverTimestamp() }));
await no('student bad field', updateDoc(doc(stu, 'students', SID), { name: 'hack' }));
await no('student self-approves', act(stu, SE, { status: 'MEASURE_APPROVED', new_grade: '4', measure_comment: '', 'signs.measure': sign(SE) }));
await no('teacher measure-approves', act(staff(T), T, { status: 'MEASURE_APPROVED', new_grade: '2', measure_comment: '', 'signs.measure': sign(T) }));
await no('academic skips measure', act(staff(A), A, { status: 'COMPLETED', academic_comment: '', 'signs.academic': sign(A) }));
await no('measure grade not allowed', act(staff(M), M, { status: 'MEASURE_APPROVED', new_grade: 'ผ', measure_comment: '', 'signs.measure': sign(M) }));
await ok('measure returns to student', act(staff(M), M, { status: 'REVISE', measure_comment: 'ไม่ชัด' }));
{ const b = addFiles(stu, 1); b.update(doc(stu, 'requests', RID), { status: 'SUBMITTED', work_note: 'ใหม่', files_count: increment(1), updated_at: serverTimestamp() });
  await ok('student resubmits', b.commit()); }
await ok('measure approves', act(staff(M), M, { status: 'MEASURE_APPROVED', new_grade: '2', measure_comment: '', 'signs.measure': sign(M) }));
await no('measure edits after approve', act(staff(M), M, { new_grade: '4' }));
await ok('academic returns to measure', act(staff(A), A, { status: 'SUBMITTED', academic_comment: 'ตรวจใหม่', 'signs.measure': deleteField() }));
await ok('measure re-approves', act(staff(M), M, { status: 'MEASURE_APPROVED', new_grade: '2', measure_comment: '', 'signs.measure': sign(M) }));
{ const dd = staff(A); const b = writeBatch(dd);
  b.set(doc(dd, 'fixes', GK), { grade_key: GK, request_id: RID, memo_id: '', memo_no: '', student_id: SID, class: 'ม.4/2', academic_year: '2569', semester: '1', subject_code: 'ง31223', subject_name: 'x', original_grade: 'ร', new_grade: '4', approved_by: 'a', approved_at: serverTimestamp() });
  b.update(doc(dd, 'requests', RID), { status: 'COMPLETED', academic_comment: '', 'signs.academic': sign(A), updated_at: serverTimestamp() }); b.set(...log(dd, RID, A));
  await no('academic fix with wrong grade', b.commit()); }
{ const dd = staff(A); const b = writeBatch(dd);
  b.update(doc(dd, 'requests', RID), { status: 'COMPLETED', academic_comment: '', 'signs.academic': sign(A), updated_at: serverTimestamp() });
  b.set(doc(dd, 'fixes', GK), { grade_key: GK, request_id: RID, memo_id: '', memo_no: '', student_id: SID, class: 'ม.4/2', academic_year: '2569', semester: '1', subject_code: 'ง31223', subject_name: 'x', original_grade: 'ร', new_grade: '2', approved_by: 'a', approved_at: serverTimestamp() });
  b.set(...log(dd, RID, A));
  await ok('academic approves + writes fix', b.commit()); }
await no('measure writes fix', setDoc(doc(staff(M), 'fixes', GK + 'x'), { grade_key: GK + 'x', request_id: RID, new_grade: '2', original_grade: 'ร', student_id: SID, class: 'ม.4/2' }));
await ok('student reads own request', getDoc(doc(stu, 'requests', RID)));
await ok('student reads fix', getDoc(doc(stu, 'fixes', GK)));
// นักเรียนยื่นคำร้องใหม่
{ const gk2 = '2569_1_' + SID + '_ค31101', r2 = gk2 + '_1';
  await ok('student creates request', setDoc(doc(stu, 'requests', r2), { request_no: 'RQ2', grade_key: gk2, term_id: SID + '_2569_1', course_id: '', seq: 1, academic_year: '2569', semester: '1', student_id: SID, student_name: 's', class: 'ม.4/2', subject_code: 'ค31101', subject_name: 'คณิต', credit: '1', original_grade: '0', request_type: 't', reason: 'r', teacher_email: '', teacher_name: '', status: 'SUBMITTED', assignment: '', due_date: '', new_grade: '', teacher_comment: '', measure_comment: '', academic_comment: '', director_comment: '', memo_id: '', memo_no: '', work_note: '', files_count: 0, signs: {}, created_at: serverTimestamp(), updated_at: serverTimestamp() }));
  { const b = writeBatch(stu); b.update(doc(stu, 'requests', r2), { status: 'CANCELLED', updated_at: serverTimestamp() }); b.set(...log(stu, r2, SID + '@stu.ppj.ac.th')); await ok('student cancels', b.commit()); } }
// อนุมัติพร้อมกัน 6 รายการใน batch เดียว (ตรวจเพดานการอ่านเอกสารของ Rules)
{ const subs = ['ส1', 'ส2', 'ส3', 'ส4', 'ส5', 'ส6'];
  await env.withSecurityRulesDisabled(async c => { const d0 = c.firestore(); const ts = Timestamp.now();
    for (const code of subs) { const gk = '2569_1_' + SID + '_' + code;
      await setDoc(doc(d0, 'requests', gk + '_1'), { grade_key: gk, status: 'MEASURE_APPROVED', student_id: SID, class: 'ม.4/2', original_grade: '0', new_grade: '1', signs: { measure: { email: M } }, academic_comment: '', updated_at: ts, teacher_email: '' }); } });
  const dd = staff(A); const b = writeBatch(dd);
  for (const code of subs) { const gk = '2569_1_' + SID + '_' + code, rid = gk + '_1';
    b.update(doc(dd, 'requests', rid), { status: 'COMPLETED', academic_comment: '', 'signs.academic': sign(A), updated_at: serverTimestamp() });
    b.set(doc(dd, 'fixes', gk), { grade_key: gk, request_id: rid, student_id: SID, class: 'ม.4/2', original_grade: '0', new_grade: '1', approved_at: serverTimestamp() });
    b.set(...log(dd, rid, A)); }
  await ok('academic bulk approves 6 in one batch', b.commit()); }
console.log(`\nRESULT ${pass} passed, ${fail} failed`);
await env.cleanup();
