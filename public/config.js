// =====================================================================
// ตั้งค่าการเชื่อมต่อ — แก้ไฟล์นี้ไฟล์เดียวตอนติดตั้ง
// =====================================================================

// 1) คัดลอกจาก Firebase Console → Project settings → Your apps → Web app → SDK setup (Config)
export const firebaseConfig = {
  apiKey: "AIzaSyCGWAajhgnBNOCDSrMLaheLup5EowbCo7E",
  authDomain: "ppj-grade-fix.firebaseapp.com",
  projectId: "ppj-grade-fix",
  storageBucket: "ppj-grade-fix.firebasestorage.app",
  messagingSenderId: "115306021480",
  appId: "1:115306021480:web:67de2c1a9a6a3a56be31dd"
};

// 2) URL ของ Apps Script (gas-bridge) ที่ Deploy เป็น Web app — ใช้เก็บไฟล์งานใน Google Drive
export const GAS_URL = "https://script.google.com/macros/s/AKfycbwyXbLEWpHWQYcyrv6oPjk7fnr6xEkt70I7UibjnUGIwMo84eW129xomkffK9bpcEkEzA/exec";

// 3) อีเมลผู้ดูแลระบบคนแรก (ต้องตรงกับ bootstrapEmail() ใน firestore.rules)
export const BOOTSTRAP_ADMIN = "kitsanawat33@gmail.com";

// 4) โดเมนอีเมลจำลองของนักเรียน (ต้องตรงกับ studentEmailRegex() ใน firestore.rules)
//    ไม่ต้องมีอีเมลจริง ระบบใช้แทนชื่อผู้ใช้เท่านั้น
export const STUDENT_EMAIL_DOMAIN = "stu.ppj.ac.th";
