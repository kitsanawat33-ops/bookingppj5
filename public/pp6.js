// ตัวอ่าน PDF ปพ.6 (แบบรายงานผลพัฒนาคุณภาพผู้เรียนรายบุคคล) จาก SchoolMIS (obec.expert)
// รับ text items ของแต่ละหน้า [{x, y, str}] → คืนแถวผลการเรียน
// หมายเหตุ: PDF จาก SchoolMIS (mPDF + TH Sarabun New) เก็บวรรณยุกต์บางตัวเป็นรหัส PUA — fixThai() แปลงกลับให้

// ฟอนต์ไทยแบบเก่าใช้รหัส Private Use Area (U+F700–U+F71A) แทนสระ/วรรณยุกต์ที่เลื่อนตำแหน่ง → แปลงกลับเป็นอักษรไทยปกติ
const THAI_PUA = {
  0xF700: 'ฐ', 0xF701: 'ิ', 0xF702: 'ี', 0xF703: 'ึ', 0xF704: 'ื', 0xF705: '่', 0xF706: '้', 0xF707: '๊', 0xF708: '๋', 0xF709: '์',
  0xF70A: '่', 0xF70B: '้', 0xF70C: '๊', 0xF70D: '๋', 0xF70E: '์', 0xF70F: 'ญ', 0xF710: 'ั', 0xF711: '็', 0xF712: '่', 0xF713: '้',
  0xF714: '๊', 0xF715: '๋', 0xF716: '์', 0xF717: 'ํ', 0xF718: 'ุ', 0xF719: 'ู', 0xF71A: 'ฺ'
};
export const fixThai = s => String(s).replace(/[\uF700-\uF71A]/g, c => THAI_PUA[c.charCodeAt(0)] || '');

const CODE_RE = /^[A-Za-zก-ฮ]{1,2}\d{5}$/;
const GRADE_RE = /^(4|3\.5|3|2\.5|2|1\.5|1|0|ร|มส|มผ|ผ)$/;

function toLines(items) {
  const its = items.filter(i => String(i.str).trim() !== '').map(i => ({ x: i.x, y: i.y, s: fixThai(i.str).trim() }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  its.forEach(it => {
    const ln = lines.find(l => Math.abs(l.y - it.y) <= 3);
    if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
  });
  lines.forEach(l => { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map(i => i.s).join(' '); });
  return lines.sort((a, b) => b.y - a.y);
}

export function parsePP6Page(items) {
  const lines = toLines(items);
  const meta = {};
  const col = { type: null, credit: null, score: null, grade: null };
  const rows = [];
  let firstRowY = null;
  lines.forEach(l => {
    const t = l.text;
    let m;
    if ((m = t.match(/ปีการศึกษา\s*(\d{4})\s*ภาคเรียนที่\s*(\d)/))) { meta.year = m[1]; meta.semester = m[2]; }
    if ((m = t.match(/รหัสประจำตัวนักเรียน\s*:\s*([0-9A-Za-z]+)/))) meta.student_id = m[1];
    if ((m = t.match(/ชื่อ\s*-\s*นามสกุล\s*:\s*(.+?)\s+ชั้น(\s|$)/)) || (m = t.match(/ชื่อ\s*-\s*นามสกุล\s*:\s*(.+)$/))) meta.name = m[1].trim();
    if ((m = t.match(/ชั้น\s+(\S+)\s+ห้?อง\s+(\S+)/))) { meta.level = m[1]; meta.room = m[2]; }
    // ตำแหน่งคอลัมน์จากหัวตาราง (ก่อนแถวรายวิชาแรก)
    if (firstRowY === null) l.items.forEach(i => {
      if (/^ประเภท/.test(i.s)) col.type = i.x;
      if (/^(จำนวน|หน่?วยกิต)/.test(i.s)) col.credit = col.credit === null ? i.x : Math.min(col.credit, i.x);
      if (/^คะแนน/.test(i.s)) col.score = i.x;
      if (/^(ระดับ|ผลการเรียน)/.test(i.s)) col.grade = col.grade === null ? i.x : Math.min(col.grade, i.x);
    });
    const it = l.items;
    if (it.length >= 2 && /^\d+$/.test(it[0].s) && CODE_RE.test(it[1].s)) {
      if (firstRowY === null) firstRowY = l.y;
      const typeX = col.type ?? 335, credX = col.credit ?? 391, scoreX = col.score ?? 444, gradeX = col.grade ?? 507;
      const row = { code: it[1].s, name: [], type: '', credit: '', score: '', grade: '' };
      it.slice(2).forEach(i => {
        if (i.x < typeX - 5) row.name.push(i.s);
        else if (i.x < credX - 10) row.type = i.s;
        else if (i.x < scoreX) row.credit = i.s;
        else if (i.x < gradeX) row.score = i.s;
        else row.grade = i.s;
      });
      row.name = row.name.join(' ');
      rows.push(row);
    }
  });
  if (!meta.student_id) return { meta, rows: [] };
  return { meta, rows };
}

/** แปลงผลการอ่านทุกหน้าเป็นแถวสำหรับนำเข้า */
export function pp6ToImportRows(pages) {
  const out = [], issues = [];
  pages.forEach((pg, i) => {
    const { meta, rows } = parsePP6Page(pg);
    if (!meta.student_id) { issues.push(`หน้า ${i + 1}: ไม่พบรหัสประจำตัวนักเรียน`); return; }
    const cls = meta.level ? meta.level + (meta.room ? '/' + meta.room : '') : '';
    let graded = 0;
    rows.forEach(r => {
      const g = String(r.grade).trim();
      if (!g) return; // ยังไม่มีผล
      if (!GRADE_RE.test(g)) { issues.push(`หน้า ${i + 1} ${r.code}: อ่านผลการเรียน "${g}" ไม่ได้`); return; }
      graded++;
      out.push({
        student_id: String(meta.student_id).toLowerCase(), name: meta.name || '', class: cls, number: '',
        year: meta.year || '', semester: meta.semester || '', subject_code: r.code, subject_name: r.name,
        credit: r.credit, grade: g, teacher: '', from_pdf: true
      });
    });
    if (!rows.length) issues.push(`หน้า ${i + 1} (${meta.student_id}): ไม่พบตารางรายวิชา`);
  });
  return { rows: out, issues };
}

/** อ่านไฟล์ PDF ด้วย pdf.js (ส่ง pdfjsLib เข้ามา) → [{x,y,str}] ต่อหน้า */
export async function readPdfPages(pdfjsLib, arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push(tc.items.map(i => ({ x: i.transform[4], y: i.transform[5], str: i.str })));
  }
  return pages;
}
