import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc, updateDoc, serverTimestamp, Timestamp, writeBatch, collection } from 'firebase/firestore';
const env = await initializeTestEnvironment({ projectId: 'demo-gf', firestore: { rules: readFileSync('../../firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 } });
const ME = 'kitsanawat33@gmail.com', RID = '2569_1_4562_ง31223_1';
await env.withSecurityRulesDisabled(async c => {
  const db = c.firestore();
  await setDoc(doc(db, 'staff', ME), { active: true, roles: ['teacher', 'measure', 'academic', 'admin'], name: 'Admin' });
  await setDoc(doc(db, 'config', 'settings'), { fail_grades: ['0', 'ร', 'มส', 'มผ'], allowed: { 'ร': ['0','1','2','3','4'] } });
  const ts = Timestamp.now();
  await setDoc(doc(db, 'requests', RID), { subject_name: 'x', teacher_name: '', due_date: '', new_grade: '', updated_at: ts, academic_year: '2569', memo_no: '', grade_key: '2569_1_4562_ง31223', status: 'SUBMITTED', seq: 1, semester: '1', reason: 'r', student_id: '4562', student_name: 's', class: 'ม.4/2', request_no: 'RQ', director_comment: '', credit: '0.5', academic_comment: '', created_at: ts, measure_comment: '', subject_code: 'ง31223', original_grade: 'ร', teacher_comment: '', signs: {}, memo_id: '', request_type: 't', course_id: 'c', work_note: '', term_id: '4562_2569_1', teacher_email: '', assignment: '', files_count: 0 });
});
const db = env.authenticatedContext('u1', { email: ME, email_verified: true }).firestore();
try { await updateDoc(doc(db, 'requests', RID), { teacher_email: ME, teacher_name: 'Admin', updated_at: serverTimestamp() }); console.log('UPDATE OK'); }
catch (e) { console.log('UPDATE DENIED\n' + e.message); }
try { const b = writeBatch(db); b.update(doc(db, 'requests', RID), { teacher_email: ME, teacher_name: 'Admin2', updated_at: serverTimestamp() }); b.set(doc(collection(db, 'requests', RID, 'logs')), { at: serverTimestamp(), actor: ME, actor_name: 'A', role: 'x', action: 'a', detail: '' }); await b.commit(); console.log('BATCH OK'); }
catch (e) { console.log('BATCH DENIED\n' + e.message); }
await env.cleanup();
