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

await no('student sets teacher', act(stu, SID + '@stu.ppj.ac.th', { teacher_email: T, teacher_name: 'x' }));
await ok('admin sets teacher', act(staff(ADMIN), ADMIN, { teacher_email: T, teacher_name: 'Teacher' }));
await no('other teacher assigns', act(staff(M), M, { status: 'ASSIGNED', assignment: 'a', due_date: '' }));
await ok('teacher assigns', act(staff(T), T, { status: 'ASSIGNED', assignment: 'ทำงาน', due_date: '2026-11-10' }));
await ok('student email', updateDoc(doc(stu, 'students', SID), { email: 'a@b.co', email_updated_at: serverTimestamp() }));
await no('student bad field', updateDoc(doc(stu, 'students', SID), { name: 'hack' }));
{ const b = writeBatch(stu); b.set(doc(collection(stu, 'requests', RID, 'files')), { file_name: 'f', mime: '', size: 1, drive_id: 'd', note: '', uploader_role: 'student', uploaded_by: SID + '@stu.ppj.ac.th', uploaded_at: serverTimestamp() });
  b.update(doc(stu, 'requests', RID), { status: 'WORK_SUBMITTED', work_note: 'n', files_count: increment(1), updated_at: serverTimestamp() }); b.set(...log(stu, RID, SID + '@stu.ppj.ac.th'));
  await ok('student submits work', b.commit()); }
await no('teacher grade not allowed', act(staff(T), T, { status: 'TEACHER_APPROVED', new_grade: 'ผ', teacher_comment: '', 'signs.teacher': sign(T) }));
await ok('teacher approves', act(staff(T), T, { status: 'TEACHER_APPROVED', new_grade: '2', teacher_comment: 'ok', 'signs.teacher': sign(T) }));
await no('teacher measure-approves', act(staff(T), T, { status: 'MEASURE_APPROVED', measure_comment: '', 'signs.measure': sign(T) }));
await ok('measure returns', act(staff(M), M, { status: 'RETURNED', measure_comment: 'x', 'signs.teacher': deleteField() }));
await ok('teacher re-approves', act(staff(T), T, { status: 'TEACHER_APPROVED', new_grade: '2', teacher_comment: 'ok', 'signs.teacher': sign(T) }));
await ok('measure approves', act(staff(M), M, { status: 'MEASURE_APPROVED', measure_comment: '', 'signs.measure': sign(M) }));
await ok('academic approves', act(staff(A), A, { status: 'ACADEMIC_APPROVED', academic_comment: '', 'signs.academic': sign(A) }));
const db = staff(A); const mref = doc(collection(db, 'memos'));
const item = { grade_key: GK, new_grade: '2', original_grade: 'ร', student_id: SID, class: 'ม.4/2', subject_code: 'ง31223', academic_year: '2569', semester: '1' };
{ const b = writeBatch(db); b.set(doc(db, 'config', 'counters'), { memo_2569: 1 }, { merge: true });
  b.set(mref, { memo_no: '1/2569', memo_date: '', subject: 's', to: 'ผอ', terms: [], request_ids: [RID], created_by: A, created_by_name: 'n', status: 'PENDING', decision: '', director_comment: '', signs: { academic: { ...sign(A), png: '' } }, created_at: serverTimestamp(), items: { [RID]: item } });
  b.update(doc(db, 'requests', RID), { status: 'IN_MEMO', memo_id: mref.id, memo_no: '1/2569', updated_at: serverTimestamp() }); b.set(...log(db, RID, A));
  await ok('academic issues memo', b.commit()); }
{ const dd = staff(D); const b = writeBatch(dd);
  b.update(doc(dd, 'memos', mref.id), { status: 'APPROVED', decision: 'อนุมัติ', director_comment: '', decided_at: serverTimestamp(), 'signs.director': { ...sign(D), png: '' } });
  b.update(doc(dd, 'requests', RID), { status: 'COMPLETED', director_comment: '', updated_at: serverTimestamp() });
  b.set(doc(dd, 'fixes', GK), { grade_key: GK, request_id: RID, memo_id: mref.id, memo_no: '1/2569', student_id: SID, class: 'ม.4/2', academic_year: '2569', semester: '1', subject_code: 'ง31223', subject_name: 'x', original_grade: 'ร', new_grade: '2', approved_at: serverTimestamp() });
  b.set(...log(dd, RID, D));
  await ok('director approves', b.commit()); }
await ok('student reads own request', getDoc(doc(stu, 'requests', RID)));
await ok('student reads fix', getDoc(doc(stu, 'fixes', GK)));
// นักเรียนยื่นคำร้องใหม่
{ const gk2 = '2569_1_' + SID + '_ค31101', r2 = gk2 + '_1';
  await ok('student creates request', setDoc(doc(stu, 'requests', r2), { request_no: 'RQ2', grade_key: gk2, term_id: SID + '_2569_1', course_id: '', seq: 1, academic_year: '2569', semester: '1', student_id: SID, student_name: 's', class: 'ม.4/2', subject_code: 'ค31101', subject_name: 'คณิต', credit: '1', original_grade: '0', request_type: 't', reason: 'r', teacher_email: '', teacher_name: '', status: 'SUBMITTED', assignment: '', due_date: '', new_grade: '', teacher_comment: '', measure_comment: '', academic_comment: '', director_comment: '', memo_id: '', memo_no: '', work_note: '', files_count: 0, signs: {}, created_at: serverTimestamp(), updated_at: serverTimestamp() }));
  { const b = writeBatch(stu); b.update(doc(stu, 'requests', r2), { status: 'CANCELLED', updated_at: serverTimestamp() }); b.set(...log(stu, r2, SID + '@stu.ppj.ac.th')); await ok('student cancels', b.commit()); } }
console.log(`\nRESULT ${pass} passed, ${fail} failed`);
await env.cleanup();
