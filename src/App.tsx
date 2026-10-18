import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, Clock, CheckCircle2, ChevronRight, User, LogOut, Download, Plus, Trash2, Edit2, ShieldAlert, Loader2, X, CheckSquare, Upload, Lock, RefreshCw } from 'lucide-react';
import { replaceSharedCollection, subscribeSharedCollection, upsertSharedItems, type SharedCollectionName } from './firebase';
import mammoth from 'mammoth';

// --- TYPES ---
type Settings = {
  id: string;
  isOpen: boolean;
  currentExamType: 'midterm' | 'final' | 'general';
};

type Student = {
  id: string;
  name: string;
  class: string;
  number: number;
};

type MCQ = {
  id: string;
  text: string;
  options: string[]; // Always 5 options
  correctIndex: number;
  image?: string;
  classGroup: string;
  examType?: 'midterm' | 'final' | 'general';
};

type Subjective = {
  id: string;
  text: string;
  image?: string;
  classGroup: string;
  examType?: 'midterm' | 'final' | 'general';
};

type Submission = {
  id: string;
  studentId: string;
  classGroup: string;
  mcqAnswers: Record<string, string>; // questionId -> selectedOptionText
  subjAnswers: Record<string, string>; // questionId -> text
  mcqScore: number;
  timeTakenMs: number;
  cheatCount: number;
  submittedAt: number;
  subjScores: Record<string, number>; // Admin grading
};

// --- MOCK INITIAL DATA ---
const INITIAL_STUDENTS: Student[] = [
  { id: '1001', name: 'นาย สมชาย ใจดี', class: '6/3', number: 1 },
  { id: '1002', name: 'นางสาว สมหญิง รักเรียน', class: '6/8', number: 1 },
];

const generateMCQs = (cls: string): MCQ[] => {
  return Array.from({ length: 45 }).map((_, i) => ({
    id: `mcq_${cls}_${i}`,
    text: `คำถามปรนัยข้อที่ ${i + 1} (วิชาสังคมศึกษา ม.${cls}) - ตัวอย่างคำถามทดสอบระบบ?`,
    options: ['คำตอบที่ 1', 'คำตอบที่ 2', 'คำตอบที่ 3', 'คำตอบที่ 4', 'คำตอบที่ 5'],
    correctIndex: 0,
    classGroup: cls
  }));
};

const generateSubjs = (cls: string): Subjective[] => {
  return Array.from({ length: 10 }).map((_, i) => ({
    id: `subj_${cls}_${i}`,
    text: `คำถามอัตนัยข้อที่ ${i + 1} (วิชาสังคมศึกษา ม.${cls}) - อธิบายเพิ่มเติม?`,
    classGroup: cls
  }));
};

const INITIAL_MCQS = [...generateMCQs('6/3'), ...generateMCQs('6/8')];
const INITIAL_SUBJS = [...generateSubjs('6/3'), ...generateSubjs('6/8')];

// --- UTILS ---
const shuffleArray = <T,>(array: T[]): T[] => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

const matchesClassGroup = (itemClassGroup?: string, targetClass?: string) => {
  if (!itemClassGroup) return true;
  const normalized = itemClassGroup.trim();
  if (normalized === 'ทั้งหมด' || normalized.toLowerCase() === 'all' || normalized.includes('ทั้งหมด') || normalized.includes('all')) return true;
  if (!targetClass) return false;
  return normalized.includes(targetClass);
};

const matchesExamType = (itemExamType?: string, currentExamType?: string) => {
  if (!itemExamType || itemExamType === 'general' || !currentExamType || currentExamType === 'general') return true;
  return itemExamType === currentExamType;
};

// อ่าน Google Sheet สาธารณะโดยไม่ต้องเข้าสู่ระบบ Google/Firebase
// ใช้ JSONP เพื่อหลีกเลี่ยงปัญหา CORS ในเบราว์เซอร์
const loadPublicGoogleSheet = (spreadsheetId: string, gid = '0'): Promise<any> => {
  return new Promise((resolve, reject) => {
    const callbackName = `googleSheetCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete (window as any)[callbackName];
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('หมดเวลารอข้อมูลจาก Google Sheet'));
    }, 15000);

    (window as any)[callbackName] = (response: any) => {
      window.clearTimeout(timeoutId);
      cleanup();

      if (!response || response.status === 'error' || !response.table) {
        const message = response?.errors?.[0]?.detailed_message
          || response?.errors?.[0]?.message
          || 'ไม่สามารถอ่านข้อมูลจาก Google Sheet ได้';
        reject(new Error(message));
        return;
      }

      resolve(response);
    };

    script.onerror = () => {
      window.clearTimeout(timeoutId);
      cleanup();
      reject(new Error('เชื่อมต่อ Google Sheet ไม่สำเร็จ'));
    };

    // ตารางนี้เก็บข้อมูลไว้ที่คอลัมน์ B-E:
    // B = เลขที่, C = ระดับชั้น, D = ชื่อ-นามสกุล, E = รหัสนักเรียน
    const query = encodeURIComponent('select B,C,D,E');
    const tqx = encodeURIComponent(`responseHandler:${callbackName}`);
    script.src = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?gid=${gid}&headers=1&tq=${query}&tqx=${tqx}`;
    document.head.appendChild(script);
  });
};

// อ่านข้อมูลสำรองจากเครื่องนี้ เฉพาะช่วงที่ฐานข้อมูลกลางยังว่าง
function readLocalArray<T>(key: string, fallback: T[]): T[] {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return fallback;
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

type RemoteStatus = 'loading' | 'ready' | 'empty' | 'error';

// --- APP COMPONENT ---
export default function App() {
  // เริ่มจากข้อมูลในเครื่องนี้ก่อน แล้ว Firestore จะส่งข้อมูลกลางมาแทนที่ทันที
  const [students, setStudents] = useState<Student[]>(() =>
    readLocalArray('social_students', INITIAL_STUDENTS),
  );
  const [mcqs, setMcqs] = useState<MCQ[]>(() =>
    readLocalArray('social_mcqs', INITIAL_MCQS),
  );
  const [subjs, setSubjs] = useState<Subjective[]>(() =>
    readLocalArray('social_subjs', INITIAL_SUBJS),
  );
  const [submissions, setSubmissions] = useState<Submission[]>(() =>
    readLocalArray('social_submissions', []),
  );
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem('social_settings');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { id: 'system_settings', isOpen: true, currentExamType: 'general' };
  });

  // Auth State
  const [currentUser, setCurrentUser] = useState<Student | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentView, setCurrentView] = useState<'instructions' | 'login' | 'student-info' | 'exam' | 'result' | 'admin'>('instructions');
  // เก็บผลการสอบครั้งที่เพิ่งส่งโดยตรง ป้องกันหน้าสรุปหยิบผลเก่าของนักเรียนคนเดิม
  const [currentSubmission, setCurrentSubmission] = useState<Submission | null>(null);

  const [remoteStatus, setRemoteStatus] = useState<Record<SharedCollectionName, RemoteStatus>>({
    students: 'loading',
    mcqs: 'loading',
    subjs: 'loading',
    submissions: 'loading',
    settings: 'loading',
  });

  const hadLocalData = useRef<Record<SharedCollectionName, boolean>>({
    students: Boolean(localStorage.getItem('social_students')),
    mcqs: Boolean(localStorage.getItem('social_mcqs')),
    subjs: Boolean(localStorage.getItem('social_subjs')),
    submissions: Boolean(localStorage.getItem('social_submissions')),
    settings: Boolean(localStorage.getItem('social_settings')),
  });
  const migrationStarted = useRef<Record<SharedCollectionName, boolean>>({
    students: false,
    mcqs: false,
    subjs: false,
    submissions: false,
    settings: false,
  });

  const updateRemoteStatus = (name: SharedCollectionName, status: RemoteStatus) => {
    setRemoteStatus((previous) => ({ ...previous, [name]: status }));
  };

  // รับข้อมูลกลางแบบเรียลไทม์ ทุกเครื่องจึงเห็นข้อสอบชุดเดียวกัน
  useEffect(() => {
    const subscriptions = [
      subscribeSharedCollection<Student>(
        'students',
        (data) => {
          updateRemoteStatus('students', data.length > 0 ? 'ready' : 'empty');
          if (data.length > 0) {
            setStudents(data);
            localStorage.setItem('social_students', JSON.stringify(data));
          }
        },
        (error) => {
          console.error('Firestore students error:', error);
          updateRemoteStatus('students', 'error');
        },
      ),
      subscribeSharedCollection<MCQ>(
        'mcqs',
        (data) => {
          updateRemoteStatus('mcqs', data.length > 0 ? 'ready' : 'empty');
          if (data.length > 0) {
            setMcqs(data);
            localStorage.setItem('social_mcqs', JSON.stringify(data));
          }
        },
        (error) => {
          console.error('Firestore mcqs error:', error);
          updateRemoteStatus('mcqs', 'error');
        },
      ),
      subscribeSharedCollection<Subjective>(
        'subjs',
        (data) => {
          updateRemoteStatus('subjs', data.length > 0 ? 'ready' : 'empty');
          if (data.length > 0) {
            setSubjs(data);
            localStorage.setItem('social_subjs', JSON.stringify(data));
          }
        },
        (error) => {
          console.error('Firestore subjs error:', error);
          updateRemoteStatus('subjs', 'error');
        },
      ),
      subscribeSharedCollection<Submission>(
        'submissions',
        (data) => {
          updateRemoteStatus('submissions', data.length > 0 ? 'ready' : 'empty');
          setSubmissions(data);
          localStorage.setItem('social_submissions', JSON.stringify(data));
        },
        (error) => {
          console.error('Firestore submissions error:', error);
          updateRemoteStatus('submissions', 'error');
        },
      ),
      subscribeSharedCollection<Settings>(
        'settings',
        (data) => {
          updateRemoteStatus('settings', data.length > 0 ? 'ready' : 'empty');
          if (data.length > 0) {
            setSettings(data[0]);
            localStorage.setItem('social_settings', JSON.stringify(data[0]));
          }
        },
        (error) => {
          console.error('Firestore settings error:', error);
          updateRemoteStatus('settings', 'error');
        },
      ),
    ];

    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, []);

  const showSyncError = (label: string, error: unknown) => {
    console.error(`Firestore ${label} sync error:`, error);
    const message = error instanceof Error ? error.message : String(error);
    alert(`บันทึก ${label} ลงฐานข้อมูลกลางไม่สำเร็จ\n\n${message}`);
  };

  // Save Data Helpers: บันทึกทั้งในเครื่องและฐานข้อมูลกลาง
  const addSubmission = (sub: Submission) => {
    // ใช้ callback form ของ setState เพื่อป้องกันปัญหา stale state closure
    setSubmissions(prev => {
      const newData = [...prev, sub];
      localStorage.setItem('social_submissions', JSON.stringify(newData));
      return newData;
    });
    // ส่งเฉพาะผลสอบใหม่ไปที่ฐานข้อมูลเพื่อไม่ให้รบกวนข้อมูลของคนอื่น
    void upsertSharedItems('submissions', [sub]).catch((error) =>
      showSyncError('ผลสอบ', error),
    );
  };
  const saveSubmissions = (data: Submission[]) => {
    setSubmissions(data);
    localStorage.setItem('social_submissions', JSON.stringify(data));
    void upsertSharedItems('submissions', data).catch((error) =>
      showSyncError('ผลสอบ', error),
    );
  };
  const saveSettings = (newSettings: Settings) => {
    setSettings(newSettings);
    localStorage.setItem('social_settings', JSON.stringify(newSettings));
    void replaceSharedCollection('settings', [newSettings]).catch((error) =>
      showSyncError('ตั้งค่าระบบ', error),
    );
  };
  const saveStudents = (data: Student[]) => {
    setStudents(data);
    localStorage.setItem('social_students', JSON.stringify(data));
    void replaceSharedCollection('students', data).catch((error) =>
      showSyncError('รายชื่อนักเรียน', error),
    );
  };
  const saveMcqs = (data: MCQ[]) => {
    setMcqs(data);
    localStorage.setItem('social_mcqs', JSON.stringify(data));
    void replaceSharedCollection('mcqs', data).catch((error) =>
      showSyncError('ข้อสอบปรนัย', error),
    );
  };
  const saveSubjs = (data: Subjective[]) => {
    setSubjs(data);
    localStorage.setItem('social_subjs', JSON.stringify(data));
    void replaceSharedCollection('subjs', data).catch((error) =>
      showSyncError('ข้อสอบอัตนัย', error),
    );
  };

  const [isSyncingAll, setIsSyncingAll] = useState(false);

  const handleSyncAllToCloud = async () => {
    setIsSyncingAll(true);
    try {
      await replaceSharedCollection('students', students);
      await replaceSharedCollection('mcqs', mcqs);
      await replaceSharedCollection('subjs', subjs);
      await replaceSharedCollection('settings', [settings]);
      if (submissions.length > 0) {
        await upsertSharedItems('submissions', submissions);
      }
      alert('ซิงค์ข้อมูลและข้อสอบทั้งหมดขึ้นฐานข้อมูลกลาง (Cloud) เรียบร้อยแล้ว!\nทุกเครื่องที่เปิดแอปจะได้รับข้อสอบและข้อมูลชุดนี้ทันที');
    } catch (error) {
      showSyncError('ข้อมูลทั้งหมดขึ้นคลาวด์', error);
    } finally {
      setIsSyncingAll(false);
    }
  };

  // ครั้งแรกที่ผู้ดูแลเปิดระบบ จะย้ายข้อสอบชุดใหม่ขึ้นฐานข้อมูลกลางหากบนคลาวด์ยังว่างอยู่
  useEffect(() => {
    if (!isAdmin) return;

    const migrate = async <T extends { id: string }>(
      name: SharedCollectionName,
      data: T[],
      mode: 'replace' | 'upsert',
    ) => {
      if (
        remoteStatus[name] !== 'empty' ||
        migrationStarted.current[name] ||
        data.length === 0
      ) {
        return;
      }

      migrationStarted.current[name] = true;
      try {
        if (mode === 'replace') {
          await replaceSharedCollection(name, data);
        } else {
          await upsertSharedItems(name, data);
        }
      } catch (error) {
        migrationStarted.current[name] = false;
        showSyncError('ข้อมูลเดิม', error);
      }
    };

    void migrate('students', students, 'replace');
    void migrate('mcqs', mcqs, 'replace');
    void migrate('subjs', subjs, 'replace');
    void migrate('submissions', submissions, 'upsert');
    void migrate('settings', [settings], 'replace');
  }, [isAdmin, remoteStatus, students, mcqs, subjs, submissions, settings]);

  const handleLogin = (id: string, pass: string) => {
    if (id === 'TD43845' && pass === 'Natdanai43845') {
      setIsAdmin(true);
      setCurrentView('admin');
      return true;
    }

    if (!settings.isOpen) {
      alert('ระบบสอบยังไม่เปิดให้เข้าใช้งานในขณะนี้');
      return false;
    }
    
    // Student login (ID == PASS)
    if (id === pass) {
      const student = students.find(s => s.id === id);
      if (student) {
        setCurrentUser(student);
        setIsAdmin(false);
        setCurrentView('student-info');
        return true;
      }
    }
    return false;
  };

  const handleLogout = () => {
    setCurrentSubmission(null);
    setCurrentUser(null);
    setIsAdmin(false);
    setCurrentView('login');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-700 font-sans selection:bg-red-100 text-red-800 selection:text-slate-700">
      {currentView === 'instructions' && <InstructionView onNext={() => setCurrentView('login')} />}
      {currentView === 'login' && <LoginView onLogin={handleLogin} />}
      {currentView === 'student-info' && currentUser && (
        <StudentInfoView 
          student={currentUser} 
          onStart={(cls) => {
            setCurrentSubmission(null);
            setCurrentUser({...currentUser, class: cls}); // Ensure correct class
            setCurrentView('exam');
          }} 
          onLogout={handleLogout}
        />
      )}
      {currentView === 'exam' && currentUser && (
        <ExamView 
          student={currentUser}
          mcqs={mcqs.filter(m => matchesExamType(m.examType, settings.currentExamType) && matchesClassGroup(m.classGroup, currentUser.class))}
          subjs={subjs.filter(s => matchesExamType(s.examType, settings.currentExamType) && matchesClassGroup(s.classGroup, currentUser.class))}
          onFinish={(sub) => {
            // ใช้ผลสอบครั้งนี้แสดงในหน้าสรุปทันที ไม่ค้นจากประวัติผลสอบทั้งหมด
            setCurrentSubmission(sub);
            addSubmission(sub);
            setCurrentView('result');
          }}
        />
      )}
      {currentView === 'result' && currentUser && currentSubmission && (
        <ResultView 
          student={currentUser} 
          submission={currentSubmission}
          mcqs={mcqs}
          subjs={subjs}
          onLogout={handleLogout}
        />
      )}
      {currentView === 'admin' && isAdmin && (
        <AdminView 
          students={students}
          setStudents={saveStudents}
          mcqs={mcqs}
          setMcqs={saveMcqs}
          submissions={submissions}
          setSubmissions={saveSubmissions}
          subjs={subjs}
          setSubjs={saveSubjs}
          onLogout={handleLogout}
          databaseStatus={remoteStatus}
          settings={settings}
          saveSettings={saveSettings}
          onSyncAllToCloud={handleSyncAllToCloud}
          isSyncingAll={isSyncingAll}
        />
      )}
    </div>
  );
}

// --- INSTRUCTION VIEW ---
function InstructionView({ onNext }: { onNext: () => void }) {
  const [isAgreed, setIsAgreed] = useState(false);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-4 font-sans">
      <div className="w-full max-w-3xl bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-red-800 p-8 text-center relative">
          <div className="w-28 h-28 mx-auto mb-4 bg-white rounded-full p-2 shadow-lg flex items-center justify-center overflow-hidden">
            {/* โลโก้โรงเรียน: สามารถเปลี่ยน URL รูปภาพด้านล่างเป็นลิงก์ที่อัปโหลดไว้ได้ */}
            <img 
              src="https://i.postimg.cc/L6M9qytC/2AAED7C0-07AE-4904-9446-639075E0D199.png" 
              alt="School Logo" 
              className="w-full h-full object-contain" 
            />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2 drop-shadow-md">โรงเรียนบ้านม่วงพิทยาคม</h1>
          <h2 className="text-xl text-blue-100">คำชี้แจงในการสอบวัดผล</h2>
        </div>
        
        <div className="p-8 space-y-8 text-slate-700 leading-relaxed">
          <div className="bg-blue-50/50 p-6 rounded-2xl border border-blue-100">
            <p className="text-lg text-blue-900 font-bold mb-4 flex items-center gap-2">
              <CheckCircle2 className="text-blue-600" /> ข้อปฏิบัติก่อนเริ่มทำข้อสอบ
            </p>
            <ul className="space-y-4">
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center shrink-0 mt-0.5 text-sm font-bold">1</div>
                <span><strong>เตรียมอุปกรณ์:</strong> ตรวจสอบแบตเตอรี่แท็บเล็ตหรือสมาร์ทโฟนให้เพียงพอต่อการสอบ และตรวจสอบสัญญาณอินเทอร์เน็ตให้เสถียร</span>
              </li>
              <li className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-blue-200 text-blue-700 flex items-center justify-center shrink-0 mt-0.5 text-sm font-bold">2</div>
                <span><strong>เข้าสู่ระบบสอบ:</strong> เปิดลิงก์ข้อสอบที่กำหนดผ่านเบราว์เซอร์มาตรฐาน เช่น Safari หรือ Google Chrome เท่านั้น</span>
              </li>
            </ul>
          </div>

          <div className="bg-red-50 p-6 rounded-2xl border-l-4 border-red-500 shadow-sm">
            <h2 className="font-bold text-lg mb-3 text-red-700 flex items-center gap-2">
              <ShieldAlert size={24} /> กฎระเบียบระหว่างการสอบ (ข้อควรระวังอย่างยิ่ง)
            </h2>
            <p className="text-red-800">
              <strong>ห้ามสลับหน้าจอหรือออกจากการสอบเด็ดขาด:</strong> ระบบข้อสอบมีการติดตั้งระบบตรวจจับพฤติกรรม (Tab Switching Detection) หากนักเรียนพยายามปัดหน้าจอ พับหน้าจอ เปิดแท็บใหม่ หรือสลับไปใช้แอปพลิเคชันอื่น ระบบจะแจ้งเตือนและบันทึกพฤติกรรมการทุจริตทันที <span className="font-bold underline text-red-600">หากฝ่าฝืนเกิน 3 ครั้ง ระบบจะปรับตกและให้ 0 คะแนนทันที</span>
            </p>
          </div>

          <div className="text-center px-8 py-4 bg-slate-50 rounded-xl border border-slate-100">
            <p className="font-medium text-slate-600 italic">
              " ขอให้นักเรียนทุกคนเชื่อมั่นในศักยภาพของตนเอง ตั้งใจทำข้อสอบอย่างเต็มความสามารถ และมีความซื่อสัตย์สุจริต "
            </p>
          </div>

          <div className="pt-4">
            <label className="flex items-center gap-4 p-5 border-2 border-blue-100 rounded-xl cursor-pointer hover:bg-blue-50 hover:border-blue-300 transition-colors bg-white shadow-sm group">
              <input 
                type="checkbox" 
                checked={isAgreed}
                onChange={(e) => setIsAgreed(e.target.checked)}
                className="w-6 h-6 rounded border-blue-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
              <span className="font-medium text-blue-900 select-none group-hover:text-blue-700">ข้าพเจ้าได้อ่านและทำความเข้าใจแนวปฏิบัติในการสอบเรียบร้อยแล้ว</span>
            </label>

            <button 
              onClick={onNext}
              disabled={!isAgreed}
              className={`w-full py-4 mt-6 rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-all shadow-md
                ${isAgreed 
                  ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200 hover:shadow-lg translate-y-0 cursor-pointer' 
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed opacity-70'}`}
            >
              รับทราบและเข้าสู่ระบบ <ChevronRight />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- LOGIN VIEW ---
function LoginView({ onLogin }: { onLogin: (id: string, p: string) => boolean }) {
  const [id, setId] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!onLogin(id, pass)) {
      setError('รหัสผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-4 font-sans">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-red-800 p-8 text-center relative">
          <div className="w-24 h-24 mx-auto mb-4 bg-white rounded-full p-2 shadow-lg flex items-center justify-center overflow-hidden">
            <img 
              src="https://i.postimg.cc/L6M9qytC/2AAED7C0-07AE-4904-9446-639075E0D199.png" 
              alt="School Logo" 
              className="w-full h-full object-contain" 
            />
          </div>
          <h1 className="text-2xl font-bold text-white mb-2 drop-shadow-md">ระบบสอบวิชาสังคมศึกษา</h1>
          <p className="text-blue-100">กรุณาเข้าสู่ระบบด้วยรหัสนักเรียน</p>
        </div>

        <form onSubmit={submit} className="p-8 space-y-5">
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">รหัสนักเรียน / ชื่อผู้ใช้</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <User size={20} />
              </div>
              <input 
                type="text" 
                value={id} 
                onChange={e => setId(e.target.value)}
                className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="กรอกรหัสนักเรียน"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-2">รหัสผ่าน</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock size={20} />
              </div>
              <input 
                type="password" 
                value={pass} 
                onChange={e => setPass(e.target.value)}
                className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                placeholder="กรอกรหัสผ่าน"
              />
            </div>
          </div>
          
          {error && (
            <div className="bg-red-50 text-red-600 p-3 rounded-xl text-sm flex items-center gap-2 border border-red-100">
              <AlertCircle size={18} className="shrink-0"/>
              <p>{error}</p>
            </div>
          )}
          
          <button type="submit" className="w-full py-4 mt-6 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-lg shadow-md shadow-blue-200 hover:shadow-lg transition-all">
            เข้าสู่ระบบ
          </button>
        </form>
      </div>
    </div>
  );
}

// --- STUDENT INFO VIEW ---
function StudentInfoView({ student, onStart, onLogout }: { student: Student, onStart: (cls: string) => void, onLogout: () => void }) {
  const [selectedClass, setSelectedClass] = useState(student.class);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-4 font-sans">
      <div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-red-800 p-6 flex justify-between items-center text-white">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white rounded-full p-1 shadow-sm overflow-hidden shrink-0">
              <img 
                src="https://i.postimg.cc/L6M9qytC/2AAED7C0-07AE-4904-9446-639075E0D199.png" 
                alt="Logo" 
                className="w-full h-full object-contain" 
              />
            </div>
            <h2 className="text-xl font-bold drop-shadow-sm">ข้อมูลผู้เข้าสอบ</h2>
          </div>
          <button onClick={onLogout} className="text-blue-100 hover:text-white p-2 flex items-center gap-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors">
            <LogOut size={18} /> ออกจากระบบ
          </button>
        </div>

        <div className="p-8">
          <div className="space-y-4 mb-8 bg-blue-50/50 p-6 rounded-2xl border border-blue-100 shadow-inner">
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white p-4 rounded-xl border border-blue-50">
                <span className="block text-sm text-blue-400 font-bold mb-1">รหัสนักเรียน</span>
                <span className="text-lg font-bold text-slate-700">{student.id}</span>
              </div>
              <div className="bg-white p-4 rounded-xl border border-blue-50">
                <span className="block text-sm text-blue-400 font-bold mb-1">ชั้นเรียน</span>
                <span className="text-lg font-bold text-slate-700">ม.{student.class}</span>
              </div>
            </div>
            <div className="bg-white p-4 rounded-xl border border-blue-50">
              <span className="block text-sm text-blue-400 font-bold mb-1">ชื่อ - นามสกุล</span>
              <span className="text-lg font-bold text-slate-700">{student.name}</span>
            </div>
            <div className="bg-white p-4 rounded-xl border border-blue-50">
              <span className="block text-sm text-blue-400 font-bold mb-1">เลขที่</span>
              <span className="text-lg font-bold text-slate-700">{student.number}</span>
            </div>
          </div>

          <div className="mb-8">
            <label className="block text-sm font-bold text-slate-700 mb-3">
              โปรดยืนยันห้องเรียนของท่านเพื่อรับชุดข้อสอบให้ถูกต้อง:
            </label>
            <div className="flex gap-4">
              <label className={`flex-1 p-4 rounded-2xl border-2 cursor-pointer flex items-center justify-center gap-3 transition-all ${selectedClass === '6/3' ? 'border-blue-600 bg-blue-50 text-blue-900 shadow-md scale-[1.02]' : 'border-slate-200 hover:bg-slate-50 text-slate-600 hover:border-blue-300'}`}>
                <input type="radio" name="class" value="6/3" checked={selectedClass === '6/3'} onChange={() => setSelectedClass('6/3')} className="hidden" />
                <CheckCircle2 size={24} className={selectedClass === '6/3' ? 'opacity-100 text-blue-600' : 'opacity-20'} />
                <span className="font-bold text-lg">ม.6/3</span>
              </label>
              <label className={`flex-1 p-4 rounded-2xl border-2 cursor-pointer flex items-center justify-center gap-3 transition-all ${selectedClass === '6/8' ? 'border-blue-600 bg-blue-50 text-blue-900 shadow-md scale-[1.02]' : 'border-slate-200 hover:bg-slate-50 text-slate-600 hover:border-blue-300'}`}>
                <input type="radio" name="class" value="6/8" checked={selectedClass === '6/8'} onChange={() => setSelectedClass('6/8')} className="hidden" />
                <CheckCircle2 size={24} className={selectedClass === '6/8' ? 'opacity-100 text-blue-600' : 'opacity-20'} />
                <span className="font-bold text-lg">ม.6/8</span>
              </label>
            </div>
          </div>

          <div className="bg-red-50 p-5 rounded-2xl border-l-4 border-red-500 shadow-sm mb-8 text-sm text-red-800 flex gap-3 items-start">
            <ShieldAlert size={24} className="shrink-0 mt-0.5 text-red-600" />
            <p><strong>คำเตือน:</strong> หากเริ่มทำข้อสอบแล้ว ห้ามย่อหน้าต่าง เปลี่ยนแท็บ หรือเปิดโปรแกรมอื่นเด็ดขาด หากระบบตรวจพบการละเมิดเกิน 3 ครั้ง จะถือว่าทุจริตและปรับคะแนนเป็น 0 ทันที</p>
          </div>

          <button 
            onClick={() => onStart(selectedClass)}
            className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-md shadow-blue-200 hover:shadow-lg transition-all"
          >
            เริ่มทำข้อสอบ <ChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
}

// --- EXAM VIEW ---
function ExamView({ student, mcqs, subjs, onFinish }: { student: Student, mcqs: MCQ[], subjs: Subjective[], onFinish: (s: Submission) => void }) {
  const TIME_LIMIT = 60 * 60; // 60 minutes
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT);
  const [cheatCount, setCheatCount] = useState(0);
  const [isTerminated, setIsTerminated] = useState(false);
  const startTime = useRef(Date.now());
  const lastCheatTime = useRef<number>(0);

  // Randomized Exam State
  const [shuffledMcqs, setShuffledMcqs] = useState<any[]>([]);
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, string>>({});
  const [subjAnswers, setSubjAnswers] = useState<Record<string, string>>({});
  
  const [currentType, setCurrentType] = useState<'mcq' | 'subj'>(mcqs.length === 0 ? 'subj' : 'mcq');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // Force Submit Function
  const forceSubmit = (finalCheatCount: number) => {
    let score = 0;
    
    // Check MCQ Score
    shuffledMcqs.forEach(m => {
      if (mcqAnswers[m.id] === m.originalCorrectText) score++;
    });

    const sub: Submission = {
      id: Date.now().toString(),
      studentId: student.id,
      classGroup: student.class,
      mcqAnswers,
      subjAnswers,
      mcqScore: finalCheatCount >= 4 ? 0 : score, // 0 if terminated
      timeTakenMs: Date.now() - startTime.current,
      cheatCount: finalCheatCount,
      submittedAt: Date.now(),
      subjScores: {} // Admin will grade this
    };

    onFinish(sub);
  };

  // Initialize and Shuffle
  useEffect(() => {
    if (shuffledMcqs.length > 0) return; // Prevent re-shuffling if already initialized
    // 1. Shuffle questions
    const randMcqs = shuffleArray(mcqs).map(q => {
      // 2. Shuffle options for each question
      const origCorrectText = q.options[q.correctIndex];
      const randOptions = shuffleArray(q.options);
      return {
        ...q,
        shuffledOptions: randOptions,
        originalCorrectText: origCorrectText
      };
    });
    setShuffledMcqs(randMcqs);
  }, [mcqs]);

  // Timer
  useEffect(() => {
    if (isTerminated) return;
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isTerminated]);

  useEffect(() => {
    if (timeLeft === 0 && !isTerminated) {
      handleSubmit();
    }
  }, [timeLeft, isTerminated]);

  // Anti-Cheat (Keyboard preventions)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent Ctrl+C / Cmd+C / Ctrl+V / Cmd+V
      if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
      }
    };
    
    // Global copy/paste protection for this view
    const handleCopy = (e: ClipboardEvent) => e.preventDefault();
    
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('copy', handleCopy);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('copy', handleCopy);
    };
  }, []);

  // Anti-Cheat (Visibility Event)
  useEffect(() => {
    const handleViolation = () => {
      if (isTerminated) return;
      if (document.visibilityState === 'visible') return;
      
      const now = Date.now();
      // Debounce: prevent multiple triggers within 2 seconds
      if (now - lastCheatTime.current < 2000) return;
      lastCheatTime.current = now;

      setCheatCount(prev => prev + 1);
    };

    document.addEventListener('visibilitychange', handleViolation);
    
    return () => {
      document.removeEventListener('visibilitychange', handleViolation);
    };
  }, [isTerminated]);

  useEffect(() => {
    if (cheatCount > 0) {
      if (cheatCount >= 4) {
        setIsTerminated(true);
        setTimeout(() => {
          alert("คุณละเมิดกฎการสอบ (เปลี่ยนหน้าจอ/ย่อหน้าต่าง/เปิดแท็บใหม่) ครั้งที่ 4 ระบบทำการยุติการสอบและปรับตก (0 คะแนน)");
          forceSubmit(cheatCount);
        }, 100);
      } else {
        setTimeout(() => {
          alert(`คำเตือน! ห้ามเปลี่ยนหน้าจอ ย่อหน้าต่าง หรือเปิดแท็บใหม่ (ครั้งที่ ${cheatCount}/3) ระบบจะบันทึกพฤติกรรมนี้ไว้`);
        }, 100);
      }
    }
  }, [cheatCount]);

  const handleSubmit = () => {
    setConfirmSubmit(true);
  };

  if (isTerminated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 font-sans p-4">
        <div className="bg-white p-8 rounded-3xl shadow-2xl text-center max-w-md border border-red-200">
          <div className="w-24 h-24 mx-auto mb-6 bg-red-50 text-red-600 rounded-full flex items-center justify-center overflow-hidden shadow-inner">
            <ShieldAlert size={48} />
          </div>
          <h2 className="text-3xl font-bold text-red-600 mb-3 drop-shadow-sm">ถูกยุติการสอบ</h2>
          <p className="text-slate-600 font-medium text-lg">ระบบได้บันทึกคะแนนเป็น 0 เนื่องจากตรวจพบพฤติกรรมเข้าข่ายทุจริต</p>
        </div>
      </div>
    );
  }

  if (mcqs.length === 0 && subjs.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 font-sans p-4">
        <div className="bg-white p-8 rounded-3xl shadow-xl text-center max-w-md border border-slate-200">
          <div className="w-20 h-20 mx-auto mb-4 bg-amber-50 text-amber-600 rounded-full flex items-center justify-center">
            <AlertCircle size={40} />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 mb-2">ไม่พบข้อสอบสำหรับคุณ</h2>
          <p className="text-slate-500 mb-6">
            ยังไม่มีข้อสอบที่กำหนดไว้สำหรับระดับชั้นของคุณ หรือชุดข้อสอบนี้ยังไม่เปิดให้ทำ
          </p>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-md transition-all"
          >
            กลับสู่หน้าหลัก
          </button>
        </div>
      </div>
    );
  }

  if (mcqs.length > 0 && shuffledMcqs.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center font-bold text-slate-500 bg-slate-100">
        <div className="flex items-center gap-3">
          <Loader2 className="animate-spin text-blue-600" size={24} />
          <span>กำลังเตรียมชุดข้อสอบ...</span>
        </div>
      </div>
    );
  }

  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;
  
  const questionPrefixes = ['ก', 'ข', 'ค', 'ง', 'จ'];

  return (
    <div 
      className="min-h-screen bg-slate-100 p-4 pt-6 select-none font-sans"
      onContextMenu={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-md border border-slate-200 p-5 flex justify-between items-center mb-6 sticky top-4 z-50">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xl shadow-inner border border-blue-100">
              {student.class}
            </div>
            <div>
              <div className="font-bold text-slate-800 text-lg">เลขที่ {student.number}</div>
              <div className="text-sm text-slate-500">{student.name}</div>
            </div>
          </div>
          <div className="flex gap-4 items-center">
            <button onClick={() => setShowGrid(!showGrid)} className={`flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl transition-all shadow-sm ${showGrid ? 'bg-slate-800 text-white shadow-slate-300' : 'bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
              <CheckSquare size={18} /> ดูสถานะข้อสอบ (Recheck)
            </button>
            <div className={`flex items-center gap-2 font-mono text-xl font-bold bg-slate-50 px-4 py-2.5 rounded-xl border ${timeLeft < 300 ? 'text-red-600 border-red-200 bg-red-50' : 'text-slate-700 border-slate-200'}`}>
              <Clock size={24} className={timeLeft < 300 ? 'animate-pulse' : ''} />
              {mins.toString().padStart(2, '0')}:{secs.toString().padStart(2, '0')}
            </div>
          </div>
        </div>

        {showGrid && (
          <div className="bg-white p-8 rounded-3xl shadow-lg border border-slate-200 mb-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <CheckSquare size={100} />
            </div>
            <h4 className="font-bold text-lg mb-4 text-slate-800 border-l-4 border-blue-600 pl-3">ตอนที่ 1: ปรนัย</h4>
            <div className="flex flex-wrap gap-2 mb-8 relative z-10">
              {shuffledMcqs.map((q, i) => (
                <button key={q.id} onClick={() => { setCurrentType('mcq'); setCurrentIndex(i); setShowGrid(false); }}
                  className={`w-12 h-12 flex items-center justify-center rounded-xl border-2 text-base font-bold transition-all shadow-sm ${mcqAnswers[q.id] ? 'bg-blue-600 text-white border-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}`}>
                  {i+1}
                </button>
              ))}
            </div>
            <h4 className="font-bold text-lg mb-4 text-slate-800 border-l-4 border-blue-600 pl-3 relative z-10">ตอนที่ 2: อัตนัย</h4>
            <div className="flex flex-wrap gap-2 relative z-10">
              {subjs.map((q, i) => (
                <button key={q.id} onClick={() => { setCurrentType('subj'); setCurrentIndex(i); setShowGrid(false); }}
                  className={`w-12 h-12 flex items-center justify-center rounded-xl border-2 text-base font-bold transition-all shadow-sm ${subjAnswers[q.id]?.trim() ? 'bg-blue-600 text-white border-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}`}>
                  {i+1}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8 min-h-[500px] flex flex-col">
          {currentType === 'mcq' ? (
            <>
              <div className="inline-block bg-blue-50 text-blue-700 px-3 py-1 rounded-lg text-sm font-bold mb-6 w-max">
                ตอนที่ 1: ปรนัย (ข้อ {currentIndex + 1} / {shuffledMcqs.length})
              </div>
              <div className="text-2xl font-medium text-slate-800 mb-8 leading-relaxed">
                {currentIndex + 1}. {shuffledMcqs[currentIndex].text}
              </div>
              
              <div className="space-y-4 flex-1">
                {(shuffledMcqs[currentIndex].shuffledOptions || []).map((opt: string, i: number) => {
                  const isSelected = mcqAnswers[shuffledMcqs[currentIndex].id] === opt;
                  return (
                    <label key={i} className={`block p-5 rounded-2xl border-2 cursor-pointer transition-all ${isSelected ? 'border-blue-600 bg-blue-50/50 shadow-sm' : 'border-slate-100 hover:border-blue-300 hover:bg-slate-50'}`}>
                      <input 
                        type="radio" 
                      name={`mcq_${currentIndex}`} 
                      className="hidden"
                      checked={isSelected}
                      onChange={() => setMcqAnswers({...mcqAnswers, [shuffledMcqs[currentIndex].id]: opt})}
                    />
                    <div className="flex gap-4 items-center">
                      <div className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${isSelected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                        {questionPrefixes[i]}
                      </div>
                      <span className="flex-1 text-slate-700 text-lg">{opt}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="inline-block bg-blue-50 text-blue-700 px-3 py-1 rounded-lg text-sm font-bold mb-6 w-max">
              ตอนที่ 2: อัตนัย (ข้อ {currentIndex + 1} / {subjs.length})
            </div>
            <div className="text-2xl font-medium text-slate-800 mb-8 leading-relaxed">
              {currentIndex + 1}. {subjs[currentIndex].text}
            </div>
            
            <div className="flex-1">
              <textarea 
                className="w-full h-48 p-5 rounded-2xl border-2 border-slate-200 focus:outline-none focus:ring-4 focus:ring-blue-100 focus:border-blue-400 bg-slate-50 resize-none select-text text-lg shadow-inner transition-all"
                placeholder="พิมพ์คำตอบของคุณที่นี่..."
                value={subjAnswers[subjs[currentIndex].id] || ''}
                onChange={(e) => setSubjAnswers({...subjAnswers, [subjs[currentIndex].id]: e.target.value})}
              />
            </div>
          </>
        )}

        {/* Footer Navigation */}
        <div className="flex justify-between items-center mt-8 pt-6 border-t-2 border-slate-100">
          <button 
            onClick={() => {
              if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
              else if (currentType === 'subj') { setCurrentType('mcq'); setCurrentIndex(shuffledMcqs.length - 1); }
            }}
            disabled={currentType === 'mcq' && currentIndex === 0}
            className="px-6 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-bold hover:bg-slate-50 disabled:opacity-50 transition-all hover:border-slate-300"
          >
            ก่อนหน้า
          </button>
          
          <div className="flex gap-2 hidden md:flex">
            <button 
              onClick={() => setCurrentType('mcq')}
              className={`w-3 h-3 rounded-full transition-all ${currentType === 'mcq' ? 'bg-blue-600 w-6' : 'bg-slate-300'}`}
            />
            <button 
              onClick={() => setCurrentType('subj')}
              className={`w-3 h-3 rounded-full transition-all ${currentType === 'subj' ? 'bg-blue-600 w-6' : 'bg-slate-300'}`}
            />
          </div>

          {(currentType === 'mcq' && currentIndex === shuffledMcqs.length - 1) ? (
            <button 
              onClick={() => { setCurrentType('subj'); setCurrentIndex(0); }}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-md hover:bg-blue-700 hover:shadow-lg transition-all"
            >
              ถัดไป (อัตนัย)
            </button>
          ) : (currentType === 'subj' && currentIndex === subjs.length - 1) ? (
            <button 
              onClick={handleSubmit}
              className="px-6 py-3 bg-red-600 text-white rounded-xl font-bold shadow-md hover:bg-red-700 hover:shadow-lg transition-all flex items-center gap-2"
            >
              <CheckCircle2 size={20} /> ส่งข้อสอบ
            </button>
          ) : (
            <button 
              onClick={() => setCurrentIndex(currentIndex + 1)}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-md hover:bg-blue-700 hover:shadow-lg transition-all"
            >
              ถัดไป
            </button>
          )}
        </div>
      </div>
      {confirmSubmit && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md text-center shadow-2xl border border-slate-200">
            <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
              <CheckSquare size={40} />
            </div>
            <h3 className="text-2xl font-bold mb-3 text-slate-800">ยืนยันการส่งข้อสอบ</h3>
            <p className="mb-8 text-slate-600 font-medium text-lg">
              คุณต้องการส่งข้อสอบใช่หรือไม่?<br/>
              <span className="text-red-500 text-sm mt-2 block">เมื่อส่งแล้วจะไม่สามารถกลับมาแก้ไขได้อีก</span>
            </p>
            <div className="flex justify-center gap-4">
              <button onClick={() => setConfirmSubmit(false)} className="flex-1 py-3 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all hover:border-slate-300">กลับไปทำต่อ</button>
              <button onClick={() => {
                setConfirmSubmit(false);
                forceSubmit(cheatCount);
              }} className="flex-1 py-3 bg-red-600 text-white font-bold rounded-xl shadow-md hover:bg-red-700 hover:shadow-lg transition-all flex items-center justify-center gap-2">
                <CheckCircle2 size={20} /> ส่งข้อสอบจริง
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

// --- RESULT VIEW ---
function ResultView({ student, submission, mcqs, subjs, onLogout }: { student: Student, submission: Submission, mcqs: MCQ[], subjs: Subjective[], onLogout: () => void }) {
  const mins = Math.floor(submission.timeTakenMs / 60000);
  const secs = Math.floor((submission.timeTakenMs % 60000) / 1000);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-4 font-sans">
      <div className="w-full max-w-3xl bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
        <div className="bg-gradient-to-r from-green-600 to-emerald-600 p-8 text-center text-white relative">
          <div className="w-24 h-24 mx-auto mb-4 bg-white text-green-600 rounded-full p-2 shadow-lg flex items-center justify-center overflow-hidden">
            <CheckCircle2 size={48} className="drop-shadow-sm" />
          </div>
          <h2 className="text-3xl font-bold mb-2 drop-shadow-md">ส่งข้อสอบสำเร็จ</h2>
          <p className="text-green-50">ระบบได้บันทึกคำตอบของท่านเรียบร้อยแล้ว</p>
        </div>

        <div className="p-8">
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-left space-y-4 mb-8 shadow-inner">
            <div className="grid grid-cols-2 gap-4 text-lg">
              <div className="text-slate-500 font-bold">รหัสนักเรียน</div><div className="font-bold text-right text-slate-800">{student.id}</div>
              <div className="text-slate-500 font-bold">ชื่อ-สกุล</div><div className="font-bold text-right text-slate-800">{student.name}</div>
              <div className="text-slate-500 font-bold">ชั้น / เลขที่</div><div className="font-bold text-right text-slate-800">ม.{student.class} / {student.number}</div>
              <div className="col-span-2 border-t-2 border-slate-200 my-2"></div>
              <div className="text-slate-500 font-bold flex items-center gap-2"><Clock size={20} /> เวลาที่ใช้สอบ</div><div className="font-bold text-right text-blue-600">{mins} นาที {secs} วินาที</div>
              <div className="text-slate-500 font-bold">สถานะการสอบ</div>
              <div className="font-bold text-right text-green-600 flex items-center justify-end gap-1"><CheckCircle2 size={20} /> ส่งแล้ว</div>
              <div className="text-slate-500 font-bold flex items-center gap-2"><ShieldAlert size={20} className={submission.cheatCount > 0 ? 'text-red-500' : 'text-slate-400'}/> คำเตือนทุจริต</div>
              <div className={`font-bold text-right ${submission.cheatCount > 0 ? 'text-red-500' : 'text-slate-400'}`}>{submission.cheatCount} ครั้ง</div>
            </div>
          </div>

          {subjs.length > 0 && (
            <div className="text-left mb-8">
              <h3 className="font-bold text-xl mb-4 text-slate-800 border-l-4 border-blue-600 pl-3">บันทึกคำตอบอัตนัย</h3>
              <div className="space-y-4">
                {subjs.filter(s => matchesClassGroup(s.classGroup, student.class)).map((s, i) => (
                  <div key={s.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-slate-800 font-bold mb-3">{i+1}. {s.text}</div>
                    <div className="text-slate-600 bg-slate-50 p-4 rounded-lg whitespace-pre-wrap border border-slate-100">{submission.subjAnswers[s.id] || <span className="text-slate-400 italic">ไม่ได้ตอบ</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button 
            onClick={onLogout}
            className="w-full py-4 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-md transition-all"
          >
            <LogOut size={20} /> ออกจากระบบและกลับหน้าแรก
          </button>
        </div>
      </div>
    </div>
  );
}

// --- ADMIN VIEW ---
function AdminView({ students, setStudents, mcqs, setMcqs, submissions, setSubmissions, subjs, setSubjs, onLogout, databaseStatus, settings, saveSettings, onSyncAllToCloud, isSyncingAll }: any) {
  const [tab, setTab] = useState<'students' | 'mcqs' | 'subjs' | 'grading' | 'settings'>('settings');
  const [isImporting, setIsImporting] = useState(false);

  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [newStudent, setNewStudent] = useState({ id: '', prefix: '', firstName: '', lastName: '', class: '', number: '' });
  
  const [studentClassFilter, setStudentClassFilter] = useState('all');
  const [subClassFilter, setSubClassFilter] = useState('all');
  const [selectedMcqs, setSelectedMcqs] = useState<Set<string>>(new Set());
  const [selectedSubjs, setSelectedSubjs] = useState<Set<string>>(new Set());

  const [isImportingMcqText, setIsImportingMcqText] = useState(false);
  const [mcqImportText, setMcqImportText] = useState('');
  const [editingMcq, setEditingMcq] = useState<MCQ | null>(null);
  const [isAddingMcq, setIsAddingMcq] = useState(false);
  const [newMcq, setNewMcq] = useState<MCQ>({ id: '', text: '', options: ['', '', '', '', ''], correctIndex: 0, classGroup: '6/3' });
  const [studentToDelete, setStudentToDelete] = useState<Student | null>(null);
  const [mcqToDelete, setMcqToDelete] = useState<MCQ | null>(null);

  const [editingSubj, setEditingSubj] = useState<Subjective | null>(null);
  const [isAddingSubj, setIsAddingSubj] = useState(false);
  const [newSubj, setNewSubj] = useState<Subjective>({ id: '', text: '', classGroup: '6/3' });
  const [subjToDelete, setSubjToDelete] = useState<Subjective | null>(null);
  const [confirmDeleteAllMcqs, setConfirmDeleteAllMcqs] = useState(false);
  const [confirmDeleteAllSubjs, setConfirmDeleteAllSubjs] = useState(false);
  
  const [gradingSub, setGradingSub] = useState<Submission | null>(null);
  const [tempScores, setTempScores] = useState<Record<string, number>>({});

  const handleImportSheet = async () => {
    try {
      setIsImporting(true);

      const spreadsheetId = '1OuHJlzvzj6_qhPPCjv-_g4lwBl8EueHETYPrO2Ikpdk';
      const response = await loadPublicGoogleSheet(spreadsheetId, '0');

      const newStudents: Student[] = (response.table.rows || [])
        .map((row: any) => {
          const values = (row.c || []).map((cell: any) => {
            if (!cell) return '';
            return String(cell.f ?? cell.v ?? '').trim();
          });

          return {
            number: parseInt(values[0], 10) || 0,
            class: (values[1] || '')
              .replace(/ระดับชั้น/gi, '')
              .replace(/ม\.?\s*/g, '')
              .trim(),
            name: values[2] || '',
            id: values[3] ? values[3].replace(/\.0$/, '').trim() : ''
          } as Student;
        })
        .filter((student: Student) => student.id && student.name);

      if (newStudents.length === 0) {
        throw new Error(
          'ไม่พบรายชื่อนักเรียน กรุณาตรวจสอบว่า Google Sheet เปิดสิทธิ์เป็น “ทุกคนที่มีลิงก์ – ผู้มีสิทธิ์ดู” และข้อมูลอยู่ในคอลัมน์ B-E'
        );
      }

      // รวมข้อมูลเดิมกับข้อมูลจาก Sheet โดยใช้รหัสนักเรียนเป็นตัวอ้างอิง
      const studentMap = new Map<string, Student>(
        students.map((student: Student) => [student.id, student])
      );
      let added = 0;
      let updated = 0;

      newStudents.forEach((newStudent: Student) => {
        const existing = studentMap.get(newStudent.id);

        if (!existing) {
          added += 1;
          studentMap.set(newStudent.id, newStudent);
          return;
        }

        if (
          existing.name !== newStudent.name ||
          existing.class !== newStudent.class ||
          existing.number !== newStudent.number
        ) {
          updated += 1;
          studentMap.set(newStudent.id, newStudent);
        }
      });

      const mergedStudents = Array.from(studentMap.values()).sort((a, b) => {
        const classCompare = a.class.localeCompare(b.class, 'th', { numeric: true });
        return classCompare !== 0 ? classCompare : a.number - b.number;
      });

      setStudents(mergedStudents);
      alert(
        `นำเข้ารายชื่อนักเรียนสำเร็จ ${newStudents.length} คน\n` +
        `เพิ่มใหม่ ${added} คน และอัปเดต ${updated} คน`
      );
    } catch (err: any) {
      console.error('Google Sheet import error:', err);
      alert(
        'นำเข้ารายชื่อไม่สำเร็จ\n\n' +
        (err?.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ') +
        '\n\nโปรดเปิด Google Sheet แล้วตั้งค่า แชร์ → การเข้าถึงทั่วไป → ทุกคนที่มีลิงก์ → ผู้มีสิทธิ์ดู'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();

    const createdStudent: Student = {
      id: newStudent.id.trim(),
      name: `${newStudent.prefix}${newStudent.firstName} ${newStudent.lastName}`.trim(),
      class: newStudent.class.trim(),
      number: parseInt(newStudent.number, 10) || 0
    };

    if (!createdStudent.id || !createdStudent.name || !createdStudent.class) {
      alert('กรุณากรอกรหัส ชื่อ และชั้นเรียนให้ครบ');
      return;
    }

    if (students.some((student: Student) => student.id === createdStudent.id)) {
      alert('มีรหัสนักเรียนนี้อยู่แล้ว');
      return;
    }

    setStudents([...students, createdStudent]);
    setIsAddingStudent(false);
    setNewStudent({ id: '', prefix: '', firstName: '', lastName: '', class: '', number: '' });
    alert('เพิ่มนักเรียนลงฐานข้อมูลกลางสำเร็จ');
  };

  const handleBulkChangeExamType = (type: 'mcqs'|'subjs', examType: 'midterm'|'final'|'general') => {
    if (type === 'mcqs') {
      const updated = mcqs.map((m: MCQ) => selectedMcqs.has(m.id) ? { ...m, examType } : m);
      setMcqs(updated);
      setSelectedMcqs(new Set());
    } else {
      const updated = subjs.map((s: Subjective) => selectedSubjs.has(s.id) ? { ...s, examType } : s);
      setSubjs(updated);
      setSelectedSubjs(new Set());
    }
  };

  const handleExportCSV = () => {
    const headers = ["วันที่ส่ง", "รหัสนักเรียน", "ชื่อ-สกุล", "ชั้น", "เลขที่", "คะแนนปรนัย", "คะแนนอัตนัย", "คะแนนรวม", "เวลาที่ใช้ (นาที)", "แจ้งเตือนทุจริต"];
    const rows = submissions.map((s: Submission) => {
       const student = students.find((st: Student) => st.id === s.studentId);
       const subjTotal = Object.values(s.subjScores || {}).reduce((a: number, b: number) => a + b, 0);
       return [
         `"${new Date(s.submittedAt).toLocaleString('th-TH')}"`,
         `"${s.studentId}"`,
         `"${student?.name || 'Unknown'}"`,
         `"${student?.class || '-'}"`,
         `"${student?.number || '-'}"`,
         s.mcqScore,
         subjTotal,
         s.mcqScore + subjTotal,
         (s.timeTakenMs / 60000).toFixed(2),
         s.cheatCount
       ].join(',');
    });
    const csvContent = "\uFEFF" + [headers.join(','), ...rows].join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'exam_results.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSaveMcq = () => {
    if (!editingMcq) return;
    const updated = mcqs.map((m: MCQ) => m.id === editingMcq.id ? editingMcq : m);
    setMcqs(updated);
    setEditingMcq(null);
  };

  const handleSaveGrading = () => {
    if (!gradingSub) return;
    const updated = submissions.map((s: Submission) => 
      s.id === gradingSub.id ? { ...s, subjScores: tempScores } : s
    );
    setSubmissions(updated);
    setGradingSub(null);
  };

  const handleImportTextSubmit = (targetClass: string, targetExamType: 'midterm' | 'final' | 'general' = 'general') => {
    if (!mcqImportText.trim()) {
      alert('กรุณาวางข้อความข้อสอบ');
      return;
    }
    if (!targetClass) targetClass = 'ทั้งหมด';

    try {
      const text = mcqImportText;
      const lines = text.split('\n').map(l => l.trim().replace(/[\u200B-\u200D\uFEFF]/g, '')).filter(Boolean);
      const parsedMcqs: MCQ[] = [];
      let currentMcq: any = null;
      
      const qRegex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]/i;
      const optRegex = /^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]/i;
      const ansRegex = /(?:answer|ตอบ|เฉลย)\s*(?:ข้อ)?\s*:?\s*(?:ข้อ)?\s*([กขคงจa-e])/i;

      for (const line of lines) {
        if (line.match(qRegex)) {
          if (currentMcq) parsedMcqs.push(currentMcq);
          currentMcq = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            text: line.replace(/^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]+/i, ''),
            options: [],
            correctIndex: 0,
            classGroup: targetClass || 'ทั้งหมด',
            examType: targetExamType
          };
        } else if (line.match(optRegex) && currentMcq) {
          currentMcq.options.push(line.replace(/^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]+/i, ''));
        } else if (line.match(ansRegex)) {
          if (currentMcq) {
            const match = line.match(ansRegex);
            if (match) {
              const ansChar = match[1].toLowerCase();
              const charMap: Record<string, number> = { 'ก': 0, 'ข': 1, 'ค': 2, 'ง': 3, 'จ': 4, 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4 };
              if (charMap[ansChar] !== undefined) {
                currentMcq.correctIndex = charMap[ansChar];
              }
            }
          }
        }
      }
      if (currentMcq) parsedMcqs.push(currentMcq);
      
      if (parsedMcqs.length > 0) {
        setMcqs([...mcqs, ...parsedMcqs]);
        alert(`นำเข้าข้อสอบสำเร็จ ${parsedMcqs.length} ข้อ`);
        setIsImportingMcqText(false);
        setMcqImportText('');
      } else {
        alert('ไม่พบข้อสอบที่สามารถนำเข้าได้\n\nคำแนะนำ:\n1. หากใช้ระบบ "พิมพ์เลขข้ออัตโนมัติ" ใน Word เมื่อคัดลอกมาวาง เลขข้ออาจจะหายไป (แนะนำให้นำเข้าไฟล์ Word โดยตรง หรือพิมพ์เลขข้อเอง)\n2. รูปแบบต้องมีเลขข้อ (เช่น 1.), ตัวเลือก (เช่น ก., ข.), และเฉลย (เช่น ตอบ: ก)');
      }
    } catch (err: any) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการแปลงข้อความ: ' + err.message);
    }
  };

  const handleImportWord = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // In iframe environments, window.prompt might be blocked. 
    // We will use 'ทั้งหมด' as default. Users can edit later or use text import for custom class groups.
    const targetClass = 'ทั้งหมด';
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const arrayBuffer = event.target?.result as ArrayBuffer;
        const result = await mammoth.extractRawText({ arrayBuffer });
        const text = result.value;
        
        // Simple heuristic parser:
        // 1. Question?
        // ก. option
        // ข. option
        // ค. option
        // ง. option
        // จ. option
        // Answer: ก
        
        const lines = text.split('\n').map(l => l.trim().replace(/[\u200B-\u200D\uFEFF]/g, '')).filter(Boolean);
        const parsedMcqs: MCQ[] = [];
        let currentMcq: any = null;
        
        const qRegex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]/i;
        const optRegex = /^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]/i;
        const ansRegex = /(?:answer|ตอบ|เฉลย)\s*(?:ข้อ)?\s*:?\s*(?:ข้อ)?\s*([กขคงจa-e])/i;

        for (const line of lines) {
          if (line.match(qRegex)) {
            if (currentMcq) parsedMcqs.push(currentMcq);
            currentMcq = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
              text: line.replace(/^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]+/i, ''),
              options: [],
              correctIndex: 0,
              classGroup: targetClass || 'ทั้งหมด'
            };
          } else if (line.match(optRegex) && currentMcq) {
            currentMcq.options.push(line.replace(/^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]+/i, ''));
          } else if (line.match(ansRegex)) {
            if (currentMcq) {
              const match = line.match(ansRegex);
              if (match) {
                const ansChar = match[1].toLowerCase();
                const charMap: Record<string, number> = { 'ก': 0, 'ข': 1, 'ค': 2, 'ง': 3, 'จ': 4, 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4 };
                if (charMap[ansChar] !== undefined) {
                  currentMcq.correctIndex = charMap[ansChar];
                }
              }
            }
          }
        }
        if (currentMcq) parsedMcqs.push(currentMcq);
        
        if (parsedMcqs.length > 0) {
          setMcqs([...mcqs, ...parsedMcqs]);
          alert(`นำเข้าข้อสอบสำเร็จ ${parsedMcqs.length} ข้อ`);
        } else {
          alert('ไม่พบข้อสอบที่สามารถนำเข้าได้\n\nคำแนะนำ:\n1. หากใช้ระบบ "พิมพ์เลขข้ออัตโนมัติ" ใน Word ระบบจะไม่สามารถอ่านเลขข้อได้ (ให้พิมพ์ 1. แล้วเว้นวรรคเอง)\n2. รูปแบบต้องมีเลขข้อ (เช่น 1.), ตัวเลือก (เช่น ก., ข.), และเฉลย (เช่น Answer: ก)');
        }
      } catch (err: any) {
        console.error(err);
        alert('เกิดข้อผิดพลาดในการอ่านไฟล์ Word: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // reset
  };

  return (
    <div className="min-h-screen bg-slate-50 flex font-sans">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-blue-200 p-6 flex flex-col">
        <h2 className="text-xl font-bold text-blue-900 mb-8">ระบบจัดการสอบ</h2>
        <div className="space-y-2 flex-1">
          <button onClick={() => setTab('settings')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'settings' ? 'bg-blue-50 text-blue-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>ตั้งค่าระบบ</button>
          <button onClick={() => setTab('students')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'students' ? 'bg-blue-50 text-blue-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>จัดการนักเรียน</button>
          <button onClick={() => setTab('mcqs')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'mcqs' ? 'bg-blue-50 text-blue-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>คลังข้อสอบ (ปรนัย)</button>
          <button onClick={() => setTab('subjs')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'subjs' ? 'bg-blue-50 text-blue-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>คลังข้อสอบ (อัตนัย)</button>
          <button onClick={() => setTab('grading')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'grading' ? 'bg-blue-50 text-blue-900 font-medium' : 'text-slate-500 hover:bg-slate-50'}`}>ตรวจผลสอบ</button>
        </div>
        <button onClick={onLogout} className="mt-auto flex items-center gap-2 text-red-600 px-4 py-2 hover:bg-red-50 rounded-lg">
          <LogOut size={20} /> ออกจากระบบ
        </button>
      </div>

      {/* Main Area */}
      <div className="flex-1 p-8 overflow-y-auto h-screen">
        {Object.values(databaseStatus || {}).some((status) => status === 'error') && (
          <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">
            ฐานข้อมูลกลางยังเชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบ Firebase Project และ Firestore Rules ก่อนใช้สอบจริง
          </div>
        )}
        {Object.values(databaseStatus || {}).every((status) => status === 'ready' || status === 'empty') && (
          <div className="mb-5 rounded-xl border border-green-200 bg-green-50 p-4 text-green-700">
            เชื่อมต่อฐานข้อมูลกลางแล้ว การแก้ข้อสอบและผลสอบจะอัปเดตทุกเครื่อง
          </div>
        )}
        {tab === 'settings' && (
          <div>
            <h3 className="text-2xl font-bold mb-6">ตั้งค่าระบบ</h3>
            <div className="bg-white rounded-xl border border-blue-200 p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-blue-100 pb-6">
                <div>
                  <h4 className="font-bold text-lg text-blue-900">สถานะระบบสอบ</h4>
                  <p className="text-sm text-slate-500">เปิดหรือปิดการเข้าใช้งานระบบสอบสำหรับนักเรียน</p>
                </div>
                <button
                  onClick={() => saveSettings({ ...settings, isOpen: !settings.isOpen })}
                  className={`px-6 py-2 rounded-full font-bold transition-colors ${settings.isOpen ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'}`}
                >
                  {settings.isOpen ? '🟢 ระบบเปิดอยู่' : '🔴 ระบบปิดอยู่'}
                </button>
              </div>
              <div>
                <h4 className="font-bold text-lg text-blue-900 mb-2">ชุดข้อสอบที่ใช้สอบ</h4>
                <p className="text-sm text-slate-500 mb-4">เลือกประเภทข้อสอบที่ต้องการให้นักเรียนทำ (กลางภาค, ปลายภาค, หรือทั่วไป)</p>
                <select
                  value={settings.currentExamType}
                  onChange={(e) => saveSettings({ ...settings, currentExamType: e.target.value as any })}
                  className="w-full max-w-md border border-blue-200 p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value="general">ทั่วไป (General)</option>
                  <option value="midterm">กลางภาค (Midterm)</option>
                  <option value="final">ปลายภาค (Final)</option>
                </select>
              </div>
              <div className="border-t border-blue-100 pt-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                  <div>
                    <h4 className="font-bold text-lg text-blue-900">ฐานข้อมูลกลางและการซิงค์ (Cloud Firestore)</h4>
                    <p className="text-sm text-slate-500">
                      ซิงค์ข้อสอบ รายชื่อนักเรียน และการตั้งค่าขึ้นคลาวด์ เพื่อให้โทรศัพท์และคอมพิวเตอร์ทุกเครื่องได้รับข้อสอบชุดเดียวกันทันที
                    </p>
                  </div>
                  <button
                    onClick={onSyncAllToCloud}
                    disabled={isSyncingAll}
                    className="flex items-center justify-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl shadow-sm transition-all disabled:opacity-50 shrink-0"
                  >
                    <RefreshCw size={18} className={isSyncingAll ? 'animate-spin' : ''} />
                    {isSyncingAll ? 'กำลังซิงค์ขึ้นคลาวด์...' : 'ซิงค์ข้อมูลทั้งหมดขึ้นคลาวด์ทันที'}
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-medium">
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block">ข้อสอบปรนัย (MCQ):</span>
                    <span className="font-bold text-slate-800 text-sm">{mcqs.length} ข้อ</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block">ข้อสอบอัตนัย (เขียน):</span>
                    <span className="font-bold text-slate-800 text-sm">{subjs.length} ข้อ</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block">รายชื่อนักเรียน:</span>
                    <span className="font-bold text-slate-800 text-sm">{students.length} คน</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-slate-500 block">ประวัติการส่งสอบ:</span>
                    <span className="font-bold text-slate-800 text-sm">{submissions.length} รายการ</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {tab === 'students' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-4">
                <h3 className="text-2xl font-bold">รายชื่อนักเรียน</h3>
                <select 
                  className="border border-blue-200 p-2 rounded-lg bg-white"
                  value={studentClassFilter}
                  onChange={(e) => setStudentClassFilter(e.target.value)}
                >
                  <option value="all">ทุกห้องเรียน</option>
                  {Array.from(new Set(students.map((s: Student) => s.class))).sort().map(c => (
                    <option key={c as string} value={c as string}>ห้อง {c as string}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={handleImportSheet}
                  disabled={isImporting}
                  className="flex items-center gap-2 px-4 py-2 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255] text-sm disabled:opacity-50"
                >
                  {isImporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  นำเข้า Google Sheet
                </button>
                <button onClick={() => setIsAddingStudent(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มนักเรียน
                </button>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-blue-200 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-blue-50">
                  <tr>
                    <th className="p-4 font-medium text-blue-900">รหัส</th>
                    <th className="p-4 font-medium text-blue-900">ชื่อ-สกุล</th>
                    <th className="p-4 font-medium text-blue-900">ชั้น</th>
                    <th className="p-4 font-medium text-blue-900">เลขที่</th>
                    <th className="p-4 font-medium text-blue-900">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E3D5CA]">
                  {students.filter((s: Student) => studentClassFilter === 'all' || s.class === studentClassFilter).map((s: Student) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="p-4">{s.id}</td>
                      <td className="p-4">{s.name}</td>
                      <td className="p-4">{s.class}</td>
                      <td className="p-4">{s.number}</td>
                      <td className="p-4 flex gap-2 text-slate-500">
                        <button onClick={() => setEditingStudent(s)} className="hover:text-blue-600"><Edit2 size={18} /></button>
                        <button onClick={() => setStudentToDelete(s)} className="hover:text-red-600"><Trash2 size={18} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'mcqs' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-2xl font-bold">คลังข้อสอบ (ปรนัย)</h3>
                <div className="text-sm text-slate-500 mt-1">ทั้งหมด {mcqs.length} ข้อ | เลือก {selectedMcqs.size} ข้อ</div>
              </div>
              <div className="flex gap-2 items-center flex-wrap">
                {selectedMcqs.size > 0 && (
                  <select 
                    className="border border-blue-200 p-2 rounded-lg bg-white h-[38px] text-sm"
                    onChange={(e) => {
                      if (e.target.value) handleBulkChangeExamType('mcqs', e.target.value as any);
                      e.target.value = '';
                    }}
                  >
                    <option value="">เปลี่ยนประเภทที่เลือก...</option>
                    <option value="general">ทั่วไป</option>
                    <option value="midterm">กลางภาค</option>
                    <option value="final">ปลายภาค</option>
                  </select>
                )}
                <button onClick={() => {
                  if (selectedMcqs.size === mcqs.length && mcqs.length > 0) setSelectedMcqs(new Set());
                  else setSelectedMcqs(new Set(mcqs.map((m: MCQ) => m.id)));
                }} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-lg hover:bg-slate-50 text-sm h-[38px]">
                  {selectedMcqs.size === mcqs.length && mcqs.length > 0 ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
                </button>
                <button onClick={() => setConfirmDeleteAllMcqs(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm">
                  <Trash2 size={16} /> ลบทั้งหมด
                </button>
                <button onClick={() => setIsImportingMcqText(true)} className="flex items-center gap-2 px-4 py-2 bg-slate-500 text-white rounded-lg hover:bg-slate-600 text-sm">
                  <Upload size={16} /> นำเข้าข้อความ
                </button>
                <label className="flex items-center gap-2 px-4 py-2 bg-slate-500 text-white rounded-lg hover:bg-slate-600 text-sm cursor-pointer">
                  <Upload size={16} /> นำเข้า Word
                  <input type="file" accept=".docx" className="hidden" onChange={handleImportWord} />
                </label>
                <button onClick={() => setIsAddingMcq(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มข้อสอบ
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {mcqs.map((m: MCQ, i: number) => (
                <div key={m.id} className="bg-white p-6 rounded-xl border border-blue-200 shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <input 
                        type="checkbox" 
                        className="w-5 h-5 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                        checked={selectedMcqs.has(m.id)}
                        onChange={(e) => {
                          const newSet = new Set(selectedMcqs);
                          if (e.target.checked) newSet.add(m.id);
                          else newSet.delete(m.id);
                          setSelectedMcqs(newSet);
                        }}
                      />
                      <div className="flex gap-2">
                        <span className="bg-blue-50 px-3 py-1 rounded text-sm text-blue-900">ม.{m.classGroup}</span>
                        <span className="bg-red-100 text-red-800 px-3 py-1 rounded text-sm text-blue-900">{m.examType === 'midterm' ? 'กลางภาค' : m.examType === 'final' ? 'ปลายภาค' : 'ทั่วไป'}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingMcq(m)} className="text-slate-500 hover:text-blue-600"><Edit2 size={18} /></button>
                      <button onClick={() => setMcqToDelete(m)} className="text-slate-500 hover:text-red-600"><Trash2 size={18} /></button>
                    </div>
                  </div>
                  <div className="font-medium mb-4">{m.text}</div>
                  <div className="grid grid-cols-2 gap-2 text-sm text-slate-500">
                    {(m.options || []).map((opt, idx) => (
                      <div key={idx} className={idx === m.correctIndex ? 'text-green-600 font-bold bg-green-50 p-2 rounded' : 'p-2'}>
                        - {opt}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'subjs' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-2xl font-bold">คลังข้อสอบ (อัตนัย)</h3>
                <div className="text-sm text-slate-500 mt-1">ทั้งหมด {subjs.length} ข้อ | เลือก {selectedSubjs.size} ข้อ</div>
              </div>
              <div className="flex gap-2 items-center">
                {selectedSubjs.size > 0 && (
                  <select 
                    className="border border-blue-200 p-2 rounded-lg bg-white h-[38px] text-sm"
                    onChange={(e) => {
                      if (e.target.value) handleBulkChangeExamType('subjs', e.target.value as any);
                      e.target.value = '';
                    }}
                  >
                    <option value="">เปลี่ยนประเภทที่เลือก...</option>
                    <option value="general">ทั่วไป</option>
                    <option value="midterm">กลางภาค</option>
                    <option value="final">ปลายภาค</option>
                  </select>
                )}
                <button onClick={() => {
                  if (selectedSubjs.size === subjs.length && subjs.length > 0) setSelectedSubjs(new Set());
                  else setSelectedSubjs(new Set(subjs.map((s: Subjective) => s.id)));
                }} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-lg hover:bg-slate-50 text-sm">
                  {selectedSubjs.size === subjs.length && subjs.length > 0 ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมด'}
                </button>
                <button onClick={() => setConfirmDeleteAllSubjs(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm">
                  <Trash2 size={16} /> ลบทั้งหมด
                </button>
                <button onClick={() => setIsAddingSubj(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มข้อสอบ
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {subjs.map((s: Subjective, i: number) => (
                <div key={s.id} className="bg-white p-6 rounded-xl border border-blue-200 shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-3">
                      <input 
                        type="checkbox" 
                        className="w-5 h-5 rounded border-blue-300 text-blue-600 focus:ring-blue-500"
                        checked={selectedSubjs.has(s.id)}
                        onChange={(e) => {
                          const newSet = new Set(selectedSubjs);
                          if (e.target.checked) newSet.add(s.id);
                          else newSet.delete(s.id);
                          setSelectedSubjs(newSet);
                        }}
                      />
                      <div className="flex gap-2">
                        <span className="bg-blue-50 px-3 py-1 rounded text-sm text-blue-900">ม.{s.classGroup}</span>
                        <span className="bg-red-100 text-red-800 px-3 py-1 rounded text-sm text-blue-900">{s.examType === 'midterm' ? 'กลางภาค' : s.examType === 'final' ? 'ปลายภาค' : 'ทั่วไป'}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingSubj(s)} className="text-slate-500 hover:text-blue-600"><Edit2 size={18} /></button>
                      <button onClick={() => setSubjToDelete(s)} className="text-slate-500 hover:text-red-600"><Trash2 size={18} /></button>
                    </div>
                  </div>
                  <div className="font-medium mb-4">{s.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'grading' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-4">
                <h3 className="text-2xl font-bold">ผลการสอบและการตรวจให้คะแนน</h3>
                <select 
                  className="border border-blue-200 p-2 rounded-lg bg-white"
                  value={subClassFilter}
                  onChange={(e) => setSubClassFilter(e.target.value)}
                >
                  <option value="all">ทุกห้องเรียน</option>
                  {Array.from(new Set(students.map((s: Student) => s.class))).sort().map(c => (
                    <option key={c as string} value={c as string}>ห้อง {c as string}</option>
                  ))}
                </select>
              </div>
              <button onClick={handleExportCSV} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
                <Download size={16} /> ส่งออกข้อมูล (CSV)
              </button>
            </div>
            
            <div className="bg-white rounded-xl border border-blue-200 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-blue-50">
                  <tr>
                    <th className="p-4 font-medium text-blue-900">วันที่/เวลาส่ง</th>
                    <th className="p-4 font-medium text-blue-900">รหัส นร.</th>
                    <th className="p-4 font-medium text-blue-900">ชื่อ-สกุล</th>
                    <th className="p-4 font-medium text-blue-900">ชั้น/เลขที่</th>
                    <th className="p-4 font-medium text-blue-900">คะแนน (ปรนัย+อัตนัย)</th>
                    <th className="p-4 font-medium text-blue-900">เวลาที่ใช้</th>
                    <th className="p-4 font-medium text-blue-900">สถานะทุจริต</th>
                    <th className="p-4 font-medium text-blue-900">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E3D5CA]">
                  {submissions
                    .filter((s: Submission) => {
                      const student = students.find((st: Student) => st.id === s.studentId);
                      return subClassFilter === 'all' || (student && student.class === subClassFilter) || s.classGroup === subClassFilter;
                    })
                    .sort((a: Submission, b: Submission) => {
                      const sA = students.find((st: Student) => st.id === a.studentId);
                      const sB = students.find((st: Student) => st.id === b.studentId);
                      return (sA?.number || 0) - (sB?.number || 0);
                    })
                    .map((s: Submission) => {
                      const student = students.find((st: Student) => st.id === s.studentId);
                      const subjScoreTotal = Object.values(s.subjScores || {}).reduce((acc: number, val: number) => acc + val, 0);
                      return (
                      <tr key={s.id} className="hover:bg-slate-50">
                        <td className="p-4">{new Date(s.submittedAt).toLocaleString('th-TH')}</td>
                        <td className="p-4">{s.studentId}</td>
                        <td className="p-4">{student?.name || '-'}</td>
                        <td className="p-4">{student?.class || '-'}/{student?.number || '-'}</td>
                        <td className="p-4 font-bold text-green-600">{s.mcqScore} + {subjScoreTotal} = {s.mcqScore + subjScoreTotal}</td>
                      <td className="p-4">{Math.floor(s.timeTakenMs/60000)} น.</td>
                      <td className="p-4">
                        {s.cheatCount > 0 ? <span className="text-red-500 font-medium">พบ ({s.cheatCount})</span> : <span className="text-green-500">ปกติ</span>}
                      </td>
                      <td className="p-4 text-blue-600 cursor-pointer hover:underline" onClick={() => { setGradingSub(s); setTempScores(s.subjScores || {}); }}>ตรวจ/ดูคำตอบ</td>
                    </tr>
                  )})}
                  {submissions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-slate-500">ยังไม่มีข้อมูลการส่งข้อสอบ</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Admin Modals */}
      {editingStudent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-blue-900">แก้ไขข้อมูลนักเรียน</h3>
            <div className="space-y-3 text-slate-700">
              <div><label className="block text-sm">เลขที่</label><input className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingStudent.number} onChange={e=>setEditingStudent({...editingStudent, number: parseInt(e.target.value) || 0})} /></div>
              <div><label className="block text-sm">รหัสนักเรียน (ไม่ควรแก้)</label><input className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingStudent.id} onChange={e=>setEditingStudent({...editingStudent, id: e.target.value})} disabled /></div>
              <div><label className="block text-sm">ชื่อ-นามสกุล</label><input className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingStudent.name} onChange={e=>setEditingStudent({...editingStudent, name: e.target.value})} /></div>
              <div><label className="block text-sm">ชั้น</label><input className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingStudent.class} onChange={e=>setEditingStudent({...editingStudent, class: e.target.value})} /></div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setEditingStudent(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setStudents(students.map((s: Student) => s.id === editingStudent.id ? editingStudent : s));
                  setEditingStudent(null);
                }} className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">บันทึก</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAddingStudent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-blue-900">เพิ่มนักเรียนใหม่ (บันทึกลง Sheet)</h3>
            <form onSubmit={handleAddStudent} className="space-y-3 text-slate-700">
              <div><label className="block text-sm">เลขที่</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.number} onChange={e=>setNewStudent({...newStudent, number: e.target.value})} /></div>
              <div><label className="block text-sm">รหัสนักเรียน</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.id} onChange={e=>setNewStudent({...newStudent, id: e.target.value})} /></div>
              <div><label className="block text-sm">คำนำหน้า (เช่น นาย, นางสาว)</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.prefix} onChange={e=>setNewStudent({...newStudent, prefix: e.target.value})} /></div>
              <div><label className="block text-sm">ชื่อ</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.firstName} onChange={e=>setNewStudent({...newStudent, firstName: e.target.value})} /></div>
              <div><label className="block text-sm">นามสกุล</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.lastName} onChange={e=>setNewStudent({...newStudent, lastName: e.target.value})} /></div>
              <div><label className="block text-sm">ห้อง (เช่น 6/3)</label><input required className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newStudent.class} onChange={e=>setNewStudent({...newStudent, class: e.target.value})} /></div>
              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={()=>setIsAddingStudent(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button type="submit" className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">บันทึก</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isAddingMcq && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-blue-900">เพิ่มข้อสอบใหม่ (ปรนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newMcq.classGroup} onChange={e=>setNewMcq({...newMcq, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newMcq.examType || 'general'} onChange={e=>setNewMcq({...newMcq, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-blue-200 p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-blue-300" value={newMcq.text} onChange={e=>setNewMcq({...newMcq, text: e.target.value})} />
              </div>
              {(newMcq.options || []).map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={opt} onChange={e => {
                      const newOpts = [...newMcq.options];
                      newOpts[idx] = e.target.value;
                      setNewMcq({...newMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setNewMcq({...newMcq, correctIndex: idx})} className={`px-4 rounded border ${newMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-slate-50 border-blue-200 text-slate-500'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setIsAddingMcq(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setMcqs([...mcqs, { ...newMcq, id: Date.now().toString() }]);
                  setIsAddingMcq(false);
                  setNewMcq({ id: '', text: '', options: ['', '', '', '', ''], correctIndex: 0, classGroup: '6/3' });
                }} className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">เพิ่มข้อสอบ</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isImportingMcqText && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl flex flex-col h-[90vh]">
            <h3 className="text-xl font-bold mb-2 text-blue-900 shrink-0">นำเข้าข้อสอบจากข้อความ (คัดลอกและวาง)</h3>
            <p className="text-sm text-slate-500 mb-4 shrink-0">
              รูปแบบที่รองรับ:<br/>
              1. คำถาม<br/>
              ก. ตัวเลือกที่ 1<br/>
              ข. ตัวเลือกที่ 2<br/>
              ค. ตัวเลือกที่ 3<br/>
              ง. ตัวเลือกที่ 4<br/>
              ตอบ: ก
            </p>
            <div className="flex gap-4 mb-4 shrink-0">
              <div className="flex-1">
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ ทั้งหมด)</label>
                <input 
                  type="text" 
                  className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" 
                  placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" 
                  defaultValue="ทั้งหมด"
                  id="importClassInput"
                />
              </div>
              <div className="flex-1">
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" id="importExamTypeInput">
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
            </div>
            <div className="flex-1 mb-4 relative min-h-[150px]">
              <textarea 
                className="absolute inset-0 w-full h-full border border-blue-200 p-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none" 
                placeholder="วางข้อความที่นี่..." 
                value={mcqImportText} 
                onChange={e => setMcqImportText(e.target.value)} 
              />
            </div>
            <div className="flex justify-end gap-2 shrink-0">
              <button onClick={() => { setIsImportingMcqText(false); setMcqImportText(''); }} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                const classInput = document.getElementById('importClassInput') as HTMLInputElement;
                const typeInput = document.getElementById('importExamTypeInput') as HTMLSelectElement;
                handleImportTextSubmit(classInput ? classInput.value : 'ทั้งหมด', typeInput ? typeInput.value as any : 'general');
              }} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">นำเข้าข้อสอบ</button>
            </div>
          </div>
        </div>
      )}

      {editingMcq && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-blue-900">แก้ไขข้อสอบ (ปรนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div><label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label><input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingMcq.classGroup} onChange={e=>setEditingMcq({...editingMcq, classGroup: e.target.value})} /></div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingMcq.examType || 'general'} onChange={e=>setEditingMcq({...editingMcq, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <div><label className="block text-sm font-bold mb-1">คำถาม</label><textarea className="w-full border border-blue-200 p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingMcq.text} onChange={e=>setEditingMcq({...editingMcq, text: e.target.value})} /></div>
              {(editingMcq.options || []).map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={opt} onChange={e => {
                      const newOpts = [...editingMcq.options];
                      newOpts[idx] = e.target.value;
                      setEditingMcq({...editingMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setEditingMcq({...editingMcq, correctIndex: idx})} className={`px-4 rounded border ${editingMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-slate-50 border-blue-200 text-slate-500'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setEditingMcq(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button onClick={handleSaveMcq} className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">บันทึก</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {gradingSub && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl w-full max-w-3xl flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-6 border-b border-blue-200">
              <div>
                <h3 className="text-xl font-bold text-blue-900">ตรวจและดูคำตอบ</h3>
                <div className="text-sm text-slate-500 mt-1">รหัสนักเรียน: <span className="font-medium text-blue-900">{gradingSub.studentId}</span> | คะแนนปรนัย: <span className="font-medium text-green-600">{gradingSub.mcqScore}</span></div>
              </div>
              <button onClick={()=>setGradingSub(null)} className="text-slate-500 hover:text-blue-900"><X size={24} /></button>
            </div>
            
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-50">
              {mcqs.filter((m: any) => gradingSub.mcqAnswers && gradingSub.mcqAnswers[m.id] !== undefined).length > 0 && (
                <div className="mb-8">
                  <h4 className="font-bold text-blue-900 mb-4 text-lg border-b pb-2">ผลการสอบปรนัย (คะแนนรวม: {gradingSub.mcqScore})</h4>
                  <div className="space-y-4">
                    {mcqs.filter((m: any) => gradingSub.mcqAnswers && gradingSub.mcqAnswers[m.id] !== undefined).map((mcq: any, i: number) => {
                      const studentAnswer = gradingSub.mcqAnswers[mcq.id];
                      const isCorrect = studentAnswer === mcq.options[mcq.correctIndex];
                      return (
                        <div key={mcq.id} className="border border-blue-200 p-4 rounded-xl bg-white shadow-sm">
                          <div className="font-bold text-blue-900 mb-2">ข้อ {i+1}: {mcq.text}</div>
                          <div className={`p-3 rounded-lg text-sm ${isCorrect ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                            <div className="font-semibold">คำตอบที่เลือก: {studentAnswer || "- ไม่ได้ตอบ -"} {isCorrect ? '✅ ถูกต้อง' : '❌ ผิด'}</div>
                            {!isCorrect && <div className="mt-1 text-gray-600">เฉลยที่ถูกต้อง: {mcq.options[mcq.correctIndex]}</div>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              
              <h4 className="font-bold text-blue-900 mb-4 text-lg border-b pb-2">ผลการสอบอัตนัย</h4>
              {subjs.filter((s: any) => matchesClassGroup(s.classGroup, gradingSub.classGroup)).map((subj: any, i: number) => (
                <div key={subj.id} className="border border-blue-200 p-5 rounded-xl bg-white shadow-sm">
                  <div className="font-bold text-blue-900 mb-3">ข้อ {i+1}: {subj.text}</div>
                  <div className="bg-slate-50 border border-blue-100 p-4 rounded-lg mb-4 min-h-[80px] whitespace-pre-wrap text-slate-700">
                    {gradingSub.subjAnswers[subj.id] || <span className="text-gray-400 italic">- ไม่ได้ตอบ -</span>}
                  </div>
                  <div className="flex items-center gap-3 bg-blue-50 p-3 rounded-lg w-max">
                    <label className="font-medium text-sm text-blue-900">ให้คะแนนข้อนี้:</label>
                    <input 
                      type="number" 
                      min="0"
                      className="border border-blue-200 p-2 rounded w-24 text-center font-bold text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-300"
                      value={tempScores[subj.id] ?? 0}
                      onChange={e => setTempScores({...tempScores, [subj.id]: parseInt(e.target.value) || 0})}
                    />
                  </div>
                </div>
              ))}
            </div>
            
            <div className="flex justify-end gap-3 p-6 border-t border-blue-200 bg-white rounded-b-xl">
              <button onClick={()=>setGradingSub(null)} className="px-6 py-2.5 border border-blue-200 text-slate-500 rounded-lg font-medium hover:bg-slate-50">ยกเลิก</button>
              <button onClick={handleSaveGrading} className="px-6 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">บันทึกคะแนนทั้งหมด</button>
            </div>
          </div>
        </div>
      )}

      {studentToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-blue-900">ยืนยันการลบนักเรียน</h3>
            <p className="mb-6 text-slate-700">
              คุณต้องการลบรายชื่อนักเรียน <span className="font-bold">{studentToDelete.name}</span> (รหัส {studentToDelete.id}) ใช่หรือไม่?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setStudentToDelete(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                setStudents(students.filter((x: Student) => x.id !== studentToDelete.id));
                setStudentToDelete(null);
              }} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">ลบรายชื่อ</button>
            </div>
          </div>
        </div>
      )}

      {mcqToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-blue-900">ยืนยันการลบข้อสอบ (ปรนัย)</h3>
            <p className="mb-6 text-slate-700">
              คุณต้องการลบข้อสอบนี้ใช่หรือไม่? <br/><br/>
              <span className="font-bold">{mcqToDelete.text}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setMcqToDelete(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                setMcqs(mcqs.filter((m: MCQ) => m.id !== mcqToDelete.id));
                setMcqToDelete(null);
              }} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">ลบข้อสอบ</button>
            </div>
          </div>
        </div>
      )}

      {isAddingSubj && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-blue-900">เพิ่มข้อสอบใหม่ (อัตนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newSubj.classGroup} onChange={e=>setNewSubj({...newSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={newSubj.examType || 'general'} onChange={e=>setNewSubj({...newSubj, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-blue-200 p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-blue-300" value={newSubj.text} onChange={e=>setNewSubj({...newSubj, text: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setIsAddingSubj(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setSubjs([...subjs, { ...newSubj, id: Date.now().toString() }]);
                  setIsAddingSubj(false);
                  setNewSubj({ id: '', text: '', classGroup: '6/3' });
                }} className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">เพิ่มข้อสอบ</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingSubj && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-blue-900">แก้ไขข้อสอบ (อัตนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingSubj.classGroup} onChange={e=>setEditingSubj({...editingSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2 rounded focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingSubj.examType || 'general'} onChange={e=>setEditingSubj({...editingSubj, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-blue-200 p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-blue-300" value={editingSubj.text} onChange={e=>setEditingSubj({...editingSubj, text: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setEditingSubj(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setSubjs(subjs.map((s: Subjective) => s.id === editingSubj.id ? editingSubj : s));
                  setEditingSubj(null);
                }} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">บันทึก</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subjToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-blue-900">ยืนยันการลบข้อสอบ (อัตนัย)</h3>
            <p className="mb-6 text-slate-700">
              คุณต้องการลบข้อสอบนี้ใช่หรือไม่? <br/><br/>
              <span className="font-bold">{subjToDelete.text}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSubjToDelete(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                setSubjs(subjs.filter((s: Subjective) => s.id !== subjToDelete.id));
                setSubjToDelete(null);
              }} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">ลบข้อสอบ</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteAllMcqs && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-red-600">ลบข้อสอบปรนัยทั้งหมด</h3>
            <p className="mb-6 text-slate-700">
              คุณแน่ใจหรือไม่ว่าต้องการลบข้อสอบปรนัยทั้งหมดในคลัง? <br/><br/>
              <span className="font-bold text-red-600">การกระทำนี้ไม่สามารถกู้คืนได้</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteAllMcqs(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                setMcqs([]);
                setConfirmDeleteAllMcqs(false);
              }} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">ยืนยันการลบทั้งหมด</button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteAllSubjs && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-red-600">ลบข้อสอบอัตนัยทั้งหมด</h3>
            <p className="mb-6 text-slate-700">
              คุณแน่ใจหรือไม่ว่าต้องการลบข้อสอบอัตนัยทั้งหมดในคลัง? <br/><br/>
              <span className="font-bold text-red-600">การกระทำนี้ไม่สามารถกู้คืนได้</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteAllSubjs(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded hover:bg-slate-50">ยกเลิก</button>
              <button onClick={() => {
                setSubjs([]);
                setConfirmDeleteAllSubjs(false);
              }} className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700">ยืนยันการลบทั้งหมด</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
