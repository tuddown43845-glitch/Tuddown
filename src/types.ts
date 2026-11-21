export const DEFAULT_COURSE_ID = 'default_social';
export const SUPER_ADMIN_USERNAME = 'TD43845';

export type UserRole = 'super_admin' | 'teacher' | 'student';

export type Teacher = {
  id: string;
  username: string;
  name: string;
  department?: string;
  passwordHash: string;
  isActive: boolean;
  createdAt: number;
};

export type Course = {
  id: string;
  code: string; // e.g., SOC-M6, MATH-M6 (used for URL ?course=CODE and display)
  name: string; // e.g., วิชาสังคมศึกษา
  description?: string;
  teacherId: string; // Teacher.id or SUPER_ADMIN_USERNAME
  teacherName?: string;
  targetClasses?: string[]; // ห้องเรียนที่สอน/อนุญาตให้เข้าสอบ เช่น ['6/1', '6/2', '6/3'] (ว่าง = ทุกห้องเรียน)
  createdAt: number;
};

export type Settings = {
  id: string;
  courseId?: string;
  isOpen: boolean;
  currentExamType: 'midterm' | 'final' | 'general';
  examFormat?: 'both' | 'mcq_only' | 'subj_only';
  maxMcqCount?: number; // 0 หรือ undefined = ทั้งหมดในคลัง
  maxSubjCount?: number; // 0 หรือ undefined = ทั้งหมดในคลัง
  questionSelectionMode?: 'random' | 'order'; // 'random' (สุ่มข้อสอบ) หรือ 'order' (เรียงตามลำดับคลัง)
  useSelectedMcqs?: boolean; // true = ให้นักเรียนทำเฉพาะข้อสอบปรนัยที่ครูเลือกไว้ โดยไม่ต้องลบข้ออื่น
  selectedMcqIds?: string[]; // รายการ ID ข้อสอบปรนัยที่ครูเลือกให้ออกสอบ
  useSelectedSubjs?: boolean; // true = ให้นักเรียนทำเฉพาะข้อสอบอัตนัยที่ครูเลือกไว้ โดยไม่ต้องลบข้ออื่น
  selectedSubjIds?: string[]; // รายการ ID ข้อสอบอัตนัยที่ครูเลือกให้ออกสอบ
};

export type Student = {
  id: string;
  name: string;
  class: string;
  number: number;
};

export type MCQ = {
  id: string;
  courseId?: string;
  text: string;
  options: string[]; // Usually 4-5 options
  correctIndex: number;
  image?: string;
  classGroup: string;
  examType?: 'midterm' | 'final' | 'general';
};

export type Subjective = {
  id: string;
  courseId?: string;
  text: string;
  image?: string;
  classGroup: string;
  examType?: 'midterm' | 'final' | 'general';
};

export type Submission = {
  id: string;
  courseId?: string;
  courseName?: string;
  confirmationCode?: string;
  studentId: string;
  studentName?: string;
  studentClass?: string;
  studentNumber?: number;
  classGroup: string;
  mcqAnswers: Record<string, string>; // questionId -> selectedOptionText
  subjAnswers: Record<string, string>; // questionId -> text
  mcqScore: number;
  timeTakenMs: number;
  cheatCount: number;
  submittedAt: number;
  subjScores: Record<string, number>; // Admin grading
  isArchived?: boolean;
  archivedAt?: number;
  totalMcqCount?: number;
  totalSubjCount?: number;
  assignedMcqIds?: string[];
  assignedSubjIds?: string[];
};

export const DEFAULT_COURSE: Course = {
  id: DEFAULT_COURSE_ID,
  code: 'SOC-MAIN',
  name: 'วิชาสังคมศึกษา',
  description: 'รายวิชาหลักเริ่มต้นของระบบ',
  teacherId: SUPER_ADMIN_USERNAME,
  teacherName: 'ผู้ดูแลระบบหลัก (Admin)',
  targetClasses: [],
  createdAt: 1700000000000,
};

export const createDefaultSettings = (courseId: string = DEFAULT_COURSE_ID): Settings => ({
  id: courseId === DEFAULT_COURSE_ID ? 'system_settings' : `settings_${courseId}`,
  courseId,
  isOpen: true,
  currentExamType: 'general',
  examFormat: 'both',
  maxMcqCount: 0,
  maxSubjCount: 0,
  questionSelectionMode: 'random',
  useSelectedMcqs: false,
  selectedMcqIds: [],
  useSelectedSubjs: false,
  selectedSubjIds: [],
});

export const getItemCourseId = (item: { courseId?: string }): string =>
  item.courseId && item.courseId.trim() ? item.courseId.trim() : DEFAULT_COURSE_ID;

export const getSettingsDocId = (courseId: string): string =>
  courseId === DEFAULT_COURSE_ID ? 'system_settings' : `settings_${courseId}`;

// --- CLASSROOM HELPERS ---
export const normalizeClassName = (cls?: string): string =>
  (cls || '').trim().replace(/^ม\.?\s*/i, '').replace(/\s+/g, '');

export const sortClassNames = (classes: string[]): string[] => {
  return Array.from(new Set(classes.map((c) => normalizeClassName(c)).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'th', { numeric: true, sensitivity: 'base' }),
  );
};

export const courseMatchesStudentClass = (course?: Course, studentClass?: string): boolean => {
  if (!course || !course.targetClasses || course.targetClasses.length === 0) {
    return true; // ไม่จำกัดห้อง (ทุกห้องเรียนเข้าสอบได้)
  }
  const normalizedStudent = normalizeClassName(studentClass);
  if (!normalizedStudent) return false;
  return course.targetClasses.some((c) => normalizeClassName(c) === normalizedStudent);
};

export const formatCourseClasses = (targetClasses?: string[]): string => {
  if (!targetClasses || targetClasses.length === 0) return 'ทุกห้องเรียน';
  return `ห้อง ${sortClassNames(targetClasses).join(', ')}`;
};

export const formatCourseDropdownLabel = (course: Course, isOpen: boolean): string => {
  const statusIcon = isOpen ? '🟢' : '🔴';
  const classPart =
    course.targetClasses && course.targetClasses.length > 0
      ? ` • ${formatCourseClasses(course.targetClasses)}`
      : '';
  const teacherPart = course.teacherName ? ` • ${course.teacherName}` : '';
  return `${statusIcon} ${course.name}${classPart}${teacherPart} (${course.code})`;
};

// --- CRYPTO PASSWORD HASHING ---
export async function hashPassword(plainText: string): Promise<string> {
  const salted = `tuddown_exam_v2::${plainText}`;
  if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(salted);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Deterministic fallback for non-secure contexts
  let hash = 5381;
  for (let i = 0; i < salted.length; i++) {
    hash = ((hash << 5) + hash) ^ salted.charCodeAt(i);
  }
  return `fb_${(hash >>> 0).toString(16)}`;
}

// --- EXAM UTILS ---
export const shuffleArray = <T,>(array: T[]): T[] => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

export const selectExamQuestions = <T,>(
  items: T[],
  limitCount?: number,
  selectionMode: 'random' | 'order' = 'random',
): T[] => {
  if (!items || items.length === 0) return [];
  if (!limitCount || limitCount <= 0 || limitCount >= items.length) {
    return items;
  }
  if (selectionMode === 'order') {
    return items.slice(0, limitCount);
  }
  return shuffleArray(items).slice(0, limitCount);
};

export const matchesClassGroup = (itemClassGroup?: string, targetClass?: string) => {
  if (!itemClassGroup) return true;
  const normalized = itemClassGroup.trim();
  if (
    normalized === 'ทั้งหมด' ||
    normalized.toLowerCase() === 'all' ||
    normalized.includes('ทั้งหมด') ||
    normalized.includes('all')
  ) {
    return true;
  }
  if (!targetClass) return false;
  return normalized.includes(targetClass);
};

export const matchesExamType = (itemExamType?: string, currentExamType?: string) => {
  if (!itemExamType || itemExamType === 'general' || !currentExamType || currentExamType === 'general') {
    return true;
  }
  return itemExamType === currentExamType;
};

export const getEligibleMcqs = (allMcqs: MCQ[], settings: Settings, targetClass?: string): MCQ[] => {
  if (settings.examFormat === 'subj_only') return [];
  const selectedSet = settings.useSelectedMcqs ? new Set(settings.selectedMcqIds || []) : null;
  return allMcqs.filter((m) => {
    if (selectedSet && !selectedSet.has(m.id)) return false;
    return matchesExamType(m.examType, settings.currentExamType) && matchesClassGroup(m.classGroup, targetClass);
  });
};

export const getEligibleSubjs = (allSubjs: Subjective[], settings: Settings, targetClass?: string): Subjective[] => {
  if (settings.examFormat === 'mcq_only') return [];
  const selectedSet = settings.useSelectedSubjs ? new Set(settings.selectedSubjIds || []) : null;
  return allSubjs.filter((s) => {
    if (selectedSet && !selectedSet.has(s.id)) return false;
    return matchesExamType(s.examType, settings.currentExamType) && matchesClassGroup(s.classGroup, targetClass);
  });
};
