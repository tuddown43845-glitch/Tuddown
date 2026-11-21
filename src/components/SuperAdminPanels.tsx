import React, { useState } from 'react';
import {
  Users,
  BookOpen,
  Plus,
  Edit2,
  Trash2,
  KeyRound,
  Copy,
  Check,
  Link2,
  Lock,
  Unlock,
  CheckCircle2,
  ShieldCheck,
  ArrowRight,
  AlertCircle,
  X,
  RefreshCw,
} from 'lucide-react';
import {
  DEFAULT_COURSE_ID,
  SUPER_ADMIN_USERNAME,
  formatCourseClasses,
  hashPassword,
  normalizeClassName,
  sortClassNames,
  type Course,
  type Settings,
  type Teacher,
} from '../types';

const generateRandomPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// --- REUSABLE CLASSROOM MULTI-PICKER (FOR SUPER ADMIN & TEACHERS) ---
export function ClassPickerField({
  value,
  availableClasses,
  onChange,
  compact = false,
}: {
  value: string[];
  availableClasses: string[];
  onChange: (nextClasses: string[]) => void;
  compact?: boolean;
}) {
  const [customInput, setCustomInput] = useState('');
  const normalizedSelected = sortClassNames(value || []);
  const selectedSet = new Set(normalizedSelected);
  const allOptions = sortClassNames([...availableClasses, ...normalizedSelected]);
  const isAllClasses = normalizedSelected.length === 0;

  const toggleClass = (cls: string) => {
    const clean = normalizeClassName(cls);
    if (!clean) return;
    if (selectedSet.has(clean)) {
      onChange(normalizedSelected.filter((c) => c !== clean));
    } else {
      onChange(sortClassNames([...normalizedSelected, clean]));
    }
  };

  const handleAddCustom = () => {
    const parts = customInput
      .split(/[,\s]+/)
      .map((s) => normalizeClassName(s))
      .filter(Boolean);
    if (parts.length === 0) return;
    onChange(sortClassNames([...normalizedSelected, ...parts]));
    setCustomInput('');
  };

  return (
    <div className={`rounded-xl border border-blue-200 bg-blue-50/40 ${compact ? 'p-3' : 'p-4'} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-bold text-blue-900">
          สถานะปัจจุบัน:{' '}
          <span
            className={`px-2 py-0.5 rounded-md ${
              isAllClasses
                ? 'bg-slate-200 text-slate-700'
                : 'bg-blue-600 text-white'
            }`}
          >
            {isAllClasses ? 'เปิดรับทุกห้องเรียน' : `เลือกไว้ ${normalizedSelected.length} ห้อง (${normalizedSelected.join(', ')})`}
          </span>
        </div>
        {!isAllClasses && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs font-bold text-slate-500 hover:text-red-600 underline cursor-pointer"
          >
            ล้างเป็นทุกห้องเรียน
          </button>
        )}
      </div>

      {/* Clickable Roster Class Chips */}
      {allOptions.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-slate-500 mb-1.5">
            คลิกเลือกห้องเรียนที่สอน (ดึงอัตโนมัติจากรายชื่อนักเรียนในระบบ):
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
            {allOptions.map((cls) => {
              const active = selectedSet.has(cls);
              return (
                <button
                  key={cls}
                  type="button"
                  onClick={() => toggleClass(cls)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all cursor-pointer flex items-center gap-1 ${
                    active
                      ? 'bg-blue-600 text-white border-blue-700 shadow-2xs'
                      : 'bg-white text-slate-700 border-slate-300 hover:border-blue-400 hover:bg-blue-50'
                  }`}
                >
                  {active && <Check size={12} />}
                  <span>ม.{cls}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Manual Add Custom Classrooms */}
      <div className="flex gap-2">
        <input
          type="text"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAddCustom();
            }
          }}
          placeholder="เพิ่มห้องเอง เช่น 6/1, 6/2, 6/3"
          className="flex-1 bg-white border border-blue-200 px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <button
          type="button"
          onClick={handleAddCustom}
          className="px-3 py-1.5 bg-white hover:bg-blue-100 text-blue-800 border border-blue-300 rounded-lg text-xs font-bold cursor-pointer shrink-0"
        >
          + เพิ่มห้อง
        </button>
      </div>
    </div>
  );
}

// --- TEACHER MANAGEMENT PANEL (SUPER ADMIN ONLY) ---
export function TeacherManagementPanel({
  teachers,
  courses,
  onSaveTeacher,
  onDeleteTeacher,
}: {
  teachers: Teacher[];
  courses: Course[];
  onSaveTeacher: (teacher: Teacher) => Promise<void>;
  onDeleteTeacher: (teacherId: string) => Promise<void>;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDept, setNewDept] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const [resettingTeacher, setResettingTeacher] = useState<Teacher | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');
  const [deletingTeacher, setDeletingTeacher] = useState<Teacher | null>(null);

  const [createdNotice, setCreatedNotice] = useState<{
    name: string;
    username: string;
    password: string;
  } | null>(null);
  const [copiedCreds, setCopiedCreds] = useState(false);

  const handleCopyCredentials = (username: string, password: string, name: string) => {
    const text = `บัญชีเข้าใช้งานระบบสอบออนไลน์ (${name})\nชื่อผู้ใช้: ${username}\nรหัสผ่าน: ${password}\nลิงก์เข้าสู่ระบบ: ${window.location.origin}${window.location.pathname}`;
    try {
      navigator.clipboard.writeText(text);
      setCopiedCreds(true);
      setTimeout(() => setCopiedCreds(false), 2500);
    } catch {
      alert(text);
    }
  };

  const handleCreateTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanUsername = newUsername.trim();
    const cleanName = newName.trim();
    const cleanPassword = newPassword.trim();

    if (!cleanName || !cleanUsername || !cleanPassword) {
      setFormError('กรุณากรอกชื่อครู ชื่อผู้ใช้ และรหัสผ่านให้ครบถ้วน');
      return;
    }
    if (cleanPassword.length < 4) {
      setFormError('รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร');
      return;
    }
    if (
      cleanUsername.toLowerCase() === SUPER_ADMIN_USERNAME.toLowerCase() ||
      teachers.some((t) => t.username.toLowerCase() === cleanUsername.toLowerCase())
    ) {
      setFormError('ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว กรุณาใช้ชื่อผู้ใช้อื่น');
      return;
    }

    setSaving(true);
    try {
      const passwordHash = await hashPassword(cleanPassword);
      const teacher: Teacher = {
        id: `teacher_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        username: cleanUsername,
        name: cleanName,
        department: newDept.trim() || undefined,
        passwordHash,
        isActive: true,
        createdAt: Date.now(),
      };
      await onSaveTeacher(teacher);
      setCreatedNotice({ name: cleanName, username: cleanUsername, password: cleanPassword });
      setIsAdding(false);
      setNewName('');
      setNewDept('');
      setNewUsername('');
      setNewPassword('');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTeacher) return;
    setSaving(true);
    try {
      await onSaveTeacher(editingTeacher);
      setEditingTeacher(null);
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resettingTeacher || resetPasswordVal.trim().length < 4) return;
    setSaving(true);
    try {
      const cleanPass = resetPasswordVal.trim();
      const passwordHash = await hashPassword(cleanPass);
      await onSaveTeacher({ ...resettingTeacher, passwordHash });
      setCreatedNotice({
        name: resettingTeacher.name,
        username: resettingTeacher.username,
        password: cleanPass,
      });
      setResettingTeacher(null);
      setResetPasswordVal('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-2xl font-bold text-slate-800 flex items-center gap-2.5">
            <Users className="text-blue-600" size={26} /> จัดการบัญชีครูผู้สอน
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            สร้างและจัดการรหัสเข้าใช้งานสำหรับครูแต่ละท่าน เพื่อให้ครูจัดการคลังข้อสอบและตรวจคะแนนรายวิชาของตนเองได้อิสระ
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError('');
            setNewPassword(generateRandomPassword());
            setIsAdding(true);
          }}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm text-sm cursor-pointer shrink-0"
        >
          <Plus size={18} /> สร้างบัญชีครูใหม่
        </button>
      </div>

      {/* Newly Created / Reset Password Credentials Banner */}
      {createdNotice && (
        <div className="mb-6 p-5 rounded-2xl bg-emerald-50 border-2 border-emerald-300 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-emerald-900 font-bold text-base mb-1">
                <CheckCircle2 size={20} className="text-emerald-600" />
                บันทึกบัญชีครูเรียบร้อยแล้ว — คัดลอกข้อมูลด้านล่างส่งให้ครูได้เลย
              </div>
              <div className="text-sm text-emerald-900 space-y-0.5 mt-2 bg-white/80 p-3 rounded-xl border border-emerald-200 font-mono">
                <div>
                  <span className="text-slate-500 font-sans">ชื่อครู:</span>{' '}
                  <strong className="font-sans">{createdNotice.name}</strong>
                </div>
                <div>
                  <span className="text-slate-500 font-sans">ชื่อผู้ใช้ (Username):</span>{' '}
                  <strong className="text-blue-700">{createdNotice.username}</strong>
                </div>
                <div>
                  <span className="text-slate-500 font-sans">รหัสผ่าน (Password):</span>{' '}
                  <strong className="text-red-600">{createdNotice.password}</strong>
                </div>
              </div>
              <p className="text-xs text-emerald-700 mt-1.5">
                * ระบบเก็บรหัสผ่านแบบเข้ารหัส (SHA-256) เพื่อความปลอดภัย หากครูลืมรหัสผ่าน แอดมินสามารถกดปุ่ม "รีเซ็ตรหัสผ่าน" ได้ตลอดเวลา
              </p>
            </div>
            <div className="flex sm:flex-col gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  handleCopyCredentials(
                    createdNotice.username,
                    createdNotice.password,
                    createdNotice.name,
                  )
                }
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs shadow-xs cursor-pointer"
              >
                {copiedCreds ? <Check size={15} /> : <Copy size={15} />}
                {copiedCreds ? 'คัดลอกแล้ว!' : 'คัดลอกรหัสส่งให้ครู'}
              </button>
              <button
                type="button"
                onClick={() => setCreatedNotice(null)}
                className="px-4 py-2 bg-white hover:bg-slate-50 text-slate-600 border border-slate-300 font-bold rounded-xl text-xs cursor-pointer"
              >
                ปิดกล่องนี้
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Super Admin Info Card */}
      <div className="mb-5 p-4 rounded-2xl bg-blue-50/70 border border-blue-200 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0">
            <ShieldCheck size={24} />
          </div>
          <div>
            <div className="font-bold text-blue-950 text-sm sm:text-base">
              ผู้ดูแลระบบหลัก (Super Admin) — รหัส: <span className="font-mono">{SUPER_ADMIN_USERNAME}</span>
            </div>
            <div className="text-xs text-blue-800/80">
              มีสิทธิ์สร้างบัญชีครู สร้างรายวิชา จัดการรายชื่อนักเรียนกลาง และเข้าดูแลได้ทุกรายวิชาในระบบ
            </div>
          </div>
        </div>
        <span className="hidden sm:inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-blue-600 text-white shrink-0">
          สิทธิ์สูงสุด
        </span>
      </div>

      {/* Teachers Table */}
      <div className="bg-white rounded-2xl border border-blue-200 overflow-hidden shadow-xs">
        <table className="w-full text-left">
          <thead className="bg-blue-50">
            <tr>
              <th className="p-4 font-bold text-blue-900 text-sm">ชื่อ-นามสกุลครู</th>
              <th className="p-4 font-bold text-blue-900 text-sm">ชื่อผู้ใช้ (Login)</th>
              <th className="p-4 font-bold text-blue-900 text-sm">กลุ่มสาระ / แผนก</th>
              <th className="p-4 font-bold text-blue-900 text-sm">รายวิชาที่รับผิดชอบ</th>
              <th className="p-4 font-bold text-blue-900 text-sm">สถานะ</th>
              <th className="p-4 font-bold text-blue-900 text-sm">จัดการ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm">
            {teachers.map((t) => {
              const assignedCourses = courses.filter((c) => c.teacherId === t.id);
              return (
                <tr key={t.id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4 font-bold text-slate-800">{t.name}</td>
                  <td className="p-4 font-mono text-blue-800 font-semibold">{t.username}</td>
                  <td className="p-4 text-slate-600">{t.department || '-'}</td>
                  <td className="p-4">
                    {assignedCourses.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {assignedCourses.map((c) => (
                          <span
                            key={c.id}
                            className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-bold bg-blue-50 text-blue-800 border border-blue-200"
                          >
                            {c.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400 italic">ยังไม่ได้ผูกกับรายวิชา</span>
                    )}
                  </td>
                  <td className="p-4">
                    <button
                      type="button"
                      onClick={() => onSaveTeacher({ ...t, isActive: !t.isActive })}
                      className={`px-3 py-1 rounded-full text-xs font-bold cursor-pointer transition-colors ${
                        t.isActive
                          ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                          : 'bg-red-100 text-red-700 hover:bg-red-200'
                      }`}
                    >
                      {t.isActive ? '🟢 เปิดใช้งาน' : '🔴 ระงับชั่วคราว'}
                    </button>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setResettingTeacher(t);
                          setResetPasswordVal(generateRandomPassword());
                        }}
                        className="px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold flex items-center gap-1 cursor-pointer"
                        title="ตั้งรหัสผ่านใหม่"
                      >
                        <KeyRound size={14} /> รีเซ็ตรหัส
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingTeacher(t)}
                        className="p-1.5 text-slate-500 hover:text-blue-600 cursor-pointer"
                        title="แก้ไขข้อมูล"
                      >
                        <Edit2 size={17} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingTeacher(t)}
                        className="p-1.5 text-slate-500 hover:text-red-600 cursor-pointer"
                        title="ลบบัญชีครู"
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {teachers.length === 0 && (
              <tr>
                <td colSpan={6} className="p-10 text-center text-slate-500">
                  <Users size={32} className="mx-auto mb-2 text-slate-300" />
                  <div className="font-bold text-base">ยังไม่มีบัญชีครูผู้สอนอื่นในระบบ</div>
                  <div className="text-xs text-slate-400 mt-1">
                    กดปุ่ม "สร้างบัญชีครูใหม่" ด้านบนเพื่อสร้างรหัสให้คุณครูท่านอื่นเข้าใช้งานระบบร่วมกัน
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add Teacher Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-blue-900">สร้างบัญชีครูผู้สอนใหม่</h3>
              <button type="button" onClick={() => setIsAdding(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreateTeacher} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อ-นามสกุลครู *</label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="เช่น ครูสมศรี ใจดี"
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">กลุ่มสาระ / วิชาที่สอน</label>
                <input
                  value={newDept}
                  onChange={(e) => setNewDept(e.target.value)}
                  placeholder="เช่น กลุ่มสาระคณิตศาสตร์"
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อผู้ใช้สำหรับล็อกอิน (Username) *</label>
                <input
                  required
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value.replace(/\s+/g, ''))}
                  placeholder="เช่น T001 หรือ kru_somsri"
                  className="w-full border border-blue-200 p-2.5 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">รหัสผ่านเริ่มต้น *</label>
                <div className="flex gap-2">
                  <input
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="อย่างน้อย 4 ตัวอักษร"
                    className="flex-1 border border-blue-200 p-2.5 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                  <button
                    type="button"
                    onClick={() => setNewPassword(generateRandomPassword())}
                    className="px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 flex items-center gap-1 cursor-pointer shrink-0"
                    title="สุ่มรหัสผ่านใหม่"
                  >
                    <RefreshCw size={14} /> สุ่มรหัส
                  </button>
                </div>
              </div>

              {formError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-center gap-2">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm shadow-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'กำลังบันทึก...' : 'สร้างบัญชีครู'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Teacher Modal */}
      {editingTeacher && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-xl font-bold text-blue-900 mb-4">แก้ไขข้อมูลครูผู้สอน</h3>
            <form onSubmit={handleSaveEdit} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อผู้ใช้ (Username)</label>
                <input
                  disabled
                  value={editingTeacher.username}
                  className="w-full border border-slate-200 bg-slate-100 p-2.5 rounded-xl font-mono text-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อ-นามสกุลครู</label>
                <input
                  required
                  value={editingTeacher.name}
                  onChange={(e) => setEditingTeacher({ ...editingTeacher, name: e.target.value })}
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">กลุ่มสาระ / แผนก</label>
                <input
                  value={editingTeacher.department || ''}
                  onChange={(e) => setEditingTeacher({ ...editingTeacher, department: e.target.value })}
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTeacher(null)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
                >
                  บันทึกการแก้ไข
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resettingTeacher && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-xl font-bold text-blue-900 mb-2">ตั้งรหัสผ่านใหม่</h3>
            <p className="text-sm text-slate-500 mb-4">
              สำหรับ: <strong className="text-slate-800">{resettingTeacher.name}</strong> ({resettingTeacher.username})
            </p>
            <form onSubmit={handleConfirmResetPassword} className="space-y-4">
              <div className="flex gap-2">
                <input
                  required
                  minLength={4}
                  value={resetPasswordVal}
                  onChange={(e) => setResetPasswordVal(e.target.value)}
                  className="flex-1 border border-blue-200 p-2.5 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                  placeholder="กรอกรหัสผ่านใหม่"
                />
                <button
                  type="button"
                  onClick={() => setResetPasswordVal(generateRandomPassword())}
                  className="px-3 py-2 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-xl text-xs font-bold text-slate-700 cursor-pointer"
                >
                  สุ่มใหม่
                </button>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResettingTeacher(null)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
                >
                  ยืนยันเปลี่ยนรหัสผ่าน
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Teacher Modal */}
      {deletingTeacher && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-xl font-bold text-red-600 mb-3">ยืนยันลบบัญชีครูผู้สอน</h3>
            <p className="text-sm text-slate-600 mb-5">
              ต้องการลบบัญชี <strong>{deletingTeacher.name}</strong> ({deletingTeacher.username}) ออกจากระบบใช่หรือไม่?
              <br />
              <span className="text-xs text-slate-500 mt-1 block">
                * ข้อสอบและรายวิชาเดิมจะไม่ถูกลบ แอดมินสามารถโอนรายวิชาไปให้ครูท่านอื่นดูแลต่อได้
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingTeacher(null)}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onDeleteTeacher(deletingTeacher.id);
                  setDeletingTeacher(null);
                }}
                className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold text-sm cursor-pointer"
              >
                ลบบัญชีครู
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- COURSE / SUBJECT MANAGEMENT PANEL (SUPER ADMIN ONLY) ---
export function CourseManagementPanel({
  courses,
  teachers,
  availableClasses,
  allSettingsMap,
  activeCourseId,
  onSaveCourse,
  onDeleteCourse,
  onToggleCourseOpen,
  onEnterCourse,
}: {
  courses: Course[];
  teachers: Teacher[];
  availableClasses: string[];
  allSettingsMap: Record<string, Settings>;
  activeCourseId: string;
  onSaveCourse: (course: Course) => Promise<void>;
  onDeleteCourse: (courseId: string) => Promise<void>;
  onToggleCourseOpen: (courseId: string, nextOpen: boolean) => Promise<void>;
  onEnterCourse: (courseId: string) => void;
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newTeacherId, setNewTeacherId] = useState(SUPER_ADMIN_USERNAME);
  const [newTargetClasses, setNewTargetClasses] = useState<string[]>([]);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [deletingCourse, setDeletingCourse] = useState<Course | null>(null);
  const [copiedCourseId, setCopiedCourseId] = useState<string | null>(null);

  const getTeacherNameById = (tid: string) => {
    if (tid === SUPER_ADMIN_USERNAME) return 'ผู้ดูแลระบบหลัก (Admin)';
    return teachers.find((t) => t.id === tid)?.name || 'ยังไม่ระบุครูผู้สอน';
  };

  const getCourseDirectLink = (code: string) =>
    `${window.location.origin}${window.location.pathname}?course=${encodeURIComponent(code)}`;

  const handleCopyLink = (course: Course) => {
    const url = getCourseDirectLink(course.code);
    try {
      navigator.clipboard.writeText(url);
      setCopiedCourseId(course.id);
      setTimeout(() => setCopiedCourseId(null), 2200);
    } catch {
      alert(`ลิงก์เข้าสอบวิชา ${course.name}:\n${url}`);
    }
  };

  const handleCreateCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanCode = newCode.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    const cleanName = newName.trim();

    if (!cleanCode || !cleanName) {
      setFormError('กรุณากรอกรหัสวิชา (ภาษาอังกฤษ/ตัวเลข) และชื่อรายวิชา');
      return;
    }
    if (courses.some((c) => c.code.toUpperCase() === cleanCode)) {
      setFormError('รหัสวิชานี้มีอยู่แล้ว กรุณาใช้รหัสอื่น');
      return;
    }

    setSaving(true);
    try {
      const course: Course = {
        id: `course_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        code: cleanCode,
        name: cleanName,
        description: newDesc.trim() || undefined,
        teacherId: newTeacherId,
        teacherName: getTeacherNameById(newTeacherId),
        targetClasses: sortClassNames(newTargetClasses),
        createdAt: Date.now(),
      };
      await onSaveCourse(course);
      setIsAdding(false);
      setNewCode('');
      setNewName('');
      setNewDesc('');
      setNewTeacherId(SUPER_ADMIN_USERNAME);
      setNewTargetClasses([]);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEditCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCourse) return;
    setSaving(true);
    try {
      await onSaveCourse({
        ...editingCourse,
        teacherName: getTeacherNameById(editingCourse.teacherId),
        targetClasses: sortClassNames(editingCourse.targetClasses || []),
      });
      setEditingCourse(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-2xl font-bold text-slate-800 flex items-center gap-2.5">
            <BookOpen className="text-blue-600" size={26} /> จัดการรายวิชา / ห้องสอบทั้งหมด
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            สร้างรายวิชาแยกอิสระสำหรับครูแต่ละท่าน คลังข้อสอบ การเปิด-ปิดสอบ และผลสอบของแต่ละวิชาจะแยกขาดจากกันไม่ปะปนกัน
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError('');
            setIsAdding(true);
          }}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm text-sm cursor-pointer shrink-0"
        >
          <Plus size={18} /> สร้างรายวิชาใหม่
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {courses.map((course) => {
          const courseSettings = allSettingsMap[course.id];
          const isOpen = courseSettings ? courseSettings.isOpen : true;
          const isCurrent = course.id === activeCourseId;
          const isDefault = course.id === DEFAULT_COURSE_ID;

          return (
            <div
              key={course.id}
              className={`bg-white p-5 rounded-2xl border-2 shadow-xs transition-all flex flex-col justify-between gap-4 ${
                isCurrent ? 'border-blue-500 ring-2 ring-blue-100' : 'border-slate-200 hover:border-blue-300'
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-bold px-2.5 py-1 rounded-lg bg-blue-100 text-blue-900 border border-blue-200">
                      {course.code}
                    </span>
                    {isDefault && (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        วิชาหลักเดิม
                      </span>
                    )}
                    {isCurrent && (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-600 text-white">
                        กำลังเปิดดูอยู่
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onToggleCourseOpen(course.id, !isOpen)}
                    className={`px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1 cursor-pointer transition-colors shrink-0 ${
                      isOpen
                        ? 'bg-emerald-100 text-emerald-800 hover:bg-emerald-200'
                        : 'bg-red-100 text-red-700 hover:bg-red-200'
                    }`}
                  >
                    {isOpen ? <Unlock size={13} /> : <Lock size={13} />}
                    {isOpen ? 'เปิดสอบอยู่' : 'ปิดสอบอยู่'}
                  </button>
                </div>

                <h4 className="text-lg font-bold text-slate-900">{course.name}</h4>
                {course.description && (
                  <p className="text-xs text-slate-500 mt-0.5">{course.description}</p>
                )}

                <div className="mt-3 pt-3 border-t border-slate-100 space-y-2 text-xs text-slate-600">
                  <div>
                    ครูผู้รับผิดชอบ:{' '}
                    <strong className="text-slate-800">{getTeacherNameById(course.teacherId)}</strong>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span>ห้องเรียนที่สอน:</span>
                    {course.targetClasses && course.targetClasses.length > 0 ? (
                      sortClassNames(course.targetClasses).map((cls) => (
                        <span
                          key={cls}
                          className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-800 border border-indigo-200 font-bold"
                        >
                          ม.{cls}
                        </span>
                      ))
                    ) : (
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 font-semibold">
                        {formatCourseClasses(course.targetClasses)}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(course)}
                    className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-200 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    title="คัดลอกลิงก์เข้าสอบเฉพาะวิชานี้ส่งให้นักเรียน"
                  >
                    {copiedCourseId === course.id ? (
                      <>
                        <Check size={14} className="text-emerald-600" /> คัดลอกลิงก์แล้ว
                      </>
                    ) : (
                      <>
                        <Link2 size={14} /> คัดลอกลิงก์สอบ
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCourse(course)}
                    className="p-1.5 text-slate-500 hover:text-blue-600 cursor-pointer"
                    title="แก้ไขรายวิชา / เปลี่ยนครูผู้ดูแล"
                  >
                    <Edit2 size={16} />
                  </button>
                  {!isDefault && (
                    <button
                      type="button"
                      onClick={() => setDeletingCourse(course)}
                      className="p-1.5 text-slate-500 hover:text-red-600 cursor-pointer"
                      title="ลบรายวิชา"
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onEnterCourse(course.id)}
                  className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-2xs"
                >
                  จัดการข้อสอบและผลสอบ <ArrowRight size={14} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Course Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xl font-bold text-blue-900">สร้างรายวิชา / ห้องสอบใหม่</h3>
              <button type="button" onClick={() => setIsAdding(false)} className="text-slate-400 hover:text-slate-700 cursor-pointer">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreateCourse} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">
                  รหัสวิชา / รหัสห้องสอบ (ภาษาอังกฤษหรือตัวเลข) *
                </label>
                <input
                  required
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
                  placeholder="เช่น SOC-T1 หรือ MATH-M6A"
                  className="w-full border border-blue-200 p-2.5 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อรายวิชา *</label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="เช่น วิชาสังคมศึกษา ม.6"
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">รายละเอียดเพิ่มเติม (ไม่บังคับ)</label>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="เช่น ภาคเรียนที่ 2/2569 ระดับชั้น ม.6"
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">มอบหมายให้ครูผู้สอนดูแล *</label>
                <select
                  value={newTeacherId}
                  onChange={(e) => setNewTeacherId(e.target.value)}
                  className="w-full border border-blue-200 p-2.5 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value={SUPER_ADMIN_USERNAME}>ผู้ดูแลระบบหลัก (Admin — {SUPER_ADMIN_USERNAME})</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.username}){t.department ? ` - ${t.department}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">
                  ห้องเรียนที่สอน / อนุญาตให้เข้าสอบ
                </label>
                <p className="text-xs text-slate-500 mb-2">
                  ระบุห้องเรียนที่ครูท่านนี้สอน เพื่อแยกให้ชัดเจนกรณีมีครูหลายคนสอนวิชาเดียวกัน (หากไม่เลือก = เปิดรับทุกห้อง)
                </p>
                <ClassPickerField
                  value={newTargetClasses}
                  availableClasses={availableClasses}
                  onChange={setNewTargetClasses}
                  compact
                />
              </div>

              {formError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs font-medium flex items-center gap-2">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm shadow-sm cursor-pointer disabled:opacity-50"
                >
                  {saving ? 'กำลังสร้าง...' : 'สร้างรายวิชา'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Course Modal */}
      {editingCourse && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold text-blue-900 mb-4">แก้ไขรายวิชา</h3>
            <form onSubmit={handleSaveEditCourse} className="space-y-4">
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">รหัสวิชา</label>
                <input
                  required
                  value={editingCourse.code}
                  onChange={(e) =>
                    setEditingCourse({
                      ...editingCourse,
                      code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
                    })
                  }
                  className="w-full border border-blue-200 p-2.5 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ชื่อรายวิชา</label>
                <input
                  required
                  value={editingCourse.name}
                  onChange={(e) => setEditingCourse({ ...editingCourse, name: e.target.value })}
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">รายละเอียด</label>
                <input
                  value={editingCourse.description || ''}
                  onChange={(e) => setEditingCourse({ ...editingCourse, description: e.target.value })}
                  className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">ครูผู้รับผิดชอบ</label>
                <select
                  value={editingCourse.teacherId}
                  onChange={(e) => setEditingCourse({ ...editingCourse, teacherId: e.target.value })}
                  className="w-full border border-blue-200 p-2.5 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value={SUPER_ADMIN_USERNAME}>ผู้ดูแลระบบหลัก (Admin — {SUPER_ADMIN_USERNAME})</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.username})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-700 mb-1">
                  ห้องเรียนที่สอน / อนุญาตให้เข้าสอบ
                </label>
                <ClassPickerField
                  value={editingCourse.targetClasses || []}
                  availableClasses={availableClasses}
                  onChange={(nextClasses) =>
                    setEditingCourse({ ...editingCourse, targetClasses: nextClasses })
                  }
                  compact
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingCourse(null)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-sm cursor-pointer disabled:opacity-50"
                >
                  บันทึกการแก้ไข
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Course Modal */}
      {deletingCourse && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-xl font-bold text-red-600 mb-3">ยืนยันลบรายวิชา</h3>
            <p className="text-sm text-slate-600 mb-5">
              ต้องการลบรายวิชา <strong>{deletingCourse.name}</strong> ({deletingCourse.code}) ใช่หรือไม่?
              <br />
              <span className="text-xs text-red-600 mt-1 block font-semibold">
                ⚠️ ข้อสอบและการตั้งค่าทั้งหมดในรายวิชานี้จะถูกลบออกด้วย (ไม่กระทบรายวิชาอื่น)
              </span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingCourse(null)}
                className="px-4 py-2 border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 font-bold text-sm cursor-pointer"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onDeleteCourse(deletingCourse.id);
                  setDeletingCourse(null);
                }}
                className="px-5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl font-bold text-sm cursor-pointer"
              >
                ยืนยันลบรายวิชา
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
