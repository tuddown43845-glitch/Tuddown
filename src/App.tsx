import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AlertCircle, Clock, CheckCircle2, ChevronRight, User, LogOut, Download, Plus, Trash2, Edit2, ShieldAlert, Loader2, X, CheckSquare, Upload } from 'lucide-react';
import { googleSignIn, getAccessToken, initAuth } from './firebase';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

// --- TYPES ---
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
};

type Subjective = {
  id: string;
  text: string;
  image?: string;
  classGroup: string;
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

// --- APP COMPONENT ---
export default function App() {
  // DB State (LocalStorage)
  const [students, setStudents] = useState<Student[]>([]);
  const [mcqs, setMcqs] = useState<MCQ[]>([]);
  const [subjs, setSubjs] = useState<Subjective[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);

  // Auth State
  const [currentUser, setCurrentUser] = useState<Student | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentView, setCurrentView] = useState<'instructions' | 'login' | 'student-info' | 'exam' | 'result' | 'admin'>('instructions');

  // Load Data
  useEffect(() => {
    const s = localStorage.getItem('social_students');
    const m = localStorage.getItem('social_mcqs');
    const sj = localStorage.getItem('social_subjs');
    const sm = localStorage.getItem('social_submissions');

    if (s) setStudents(JSON.parse(s)); else setStudents(INITIAL_STUDENTS);
    if (m) setMcqs(JSON.parse(m)); else setMcqs(INITIAL_MCQS);
    if (sj) setSubjs(JSON.parse(sj)); else setSubjs(INITIAL_SUBJS);
    if (sm) setSubmissions(JSON.parse(sm));
  }, []);

  // Save Data Helpers
  const saveSubmissions = (data: Submission[]) => {
    setSubmissions(data);
    localStorage.setItem('social_submissions', JSON.stringify(data));
  };
  const saveStudents = (data: Student[]) => {
    setStudents(data);
    localStorage.setItem('social_students', JSON.stringify(data));
  };
  const saveMcqs = (data: MCQ[]) => {
    setMcqs(data);
    localStorage.setItem('social_mcqs', JSON.stringify(data));
  };
  const saveSubjs = (data: Subjective[]) => {
    setSubjs(data);
    localStorage.setItem('social_subjs', JSON.stringify(data));
  };

  const handleLogin = (id: string, pass: string) => {
    if (id === 'TD43845' && pass === 'Natdanai43845') {
      setIsAdmin(true);
      setCurrentView('admin');
      return true;
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
    setCurrentUser(null);
    setIsAdmin(false);
    setCurrentView('login');
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-[#5C4D42] font-sans selection:bg-[#E3D5CA] selection:text-[#5C4D42]">
      {currentView === 'instructions' && <InstructionView onNext={() => setCurrentView('login')} />}
      {currentView === 'login' && <LoginView onLogin={handleLogin} />}
      {currentView === 'student-info' && currentUser && (
        <StudentInfoView 
          student={currentUser} 
          onStart={(cls) => {
            setCurrentUser({...currentUser, class: cls}); // Ensure correct class
            setCurrentView('exam');
          }} 
          onLogout={handleLogout}
        />
      )}
      {currentView === 'exam' && currentUser && (
        <ExamView 
          student={currentUser}
          mcqs={mcqs.filter(m => m.classGroup === 'ทั้งหมด' || m.classGroup === 'all' || m.classGroup.includes(currentUser.class))}
          subjs={subjs.filter(s => s.classGroup === 'ทั้งหมด' || s.classGroup === 'all' || s.classGroup.includes(currentUser.class))}
          onFinish={(sub) => {
            saveSubmissions([...submissions, sub]);
            setCurrentView('result');
          }}
        />
      )}
      {currentView === 'result' && currentUser && (
        <ResultView 
          student={currentUser} 
          submission={submissions.find(s => s.studentId === currentUser.id)!}
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
        />
      )}
    </div>
  );
}

// --- INSTRUCTION VIEW ---
function InstructionView({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-xl p-8 border border-[#E3D5CA]">
        <h1 className="text-2xl font-bold text-[#4A3B32] mb-6 text-center">คำชี้แจงในการสอบ</h1>
        <div className="space-y-6 text-[#5C4D42] leading-relaxed">
          <p>ให้นักเรียนอ่านและทำความเข้าใจแนวปฏิบัติในการสอบผ่านแท็บเล็ตอย่างละเอียด เพื่อให้การวัดและประเมินผลเป็นไปด้วยความเรียบร้อย โปร่งใส และยุติธรรม</p>
          
          <div>
            <h2 className="font-bold text-lg mb-2 flex items-center gap-2"><span className="text-xl">📌</span> ข้อปฏิบัติก่อนเริ่มทำข้อสอบ</h2>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li><strong>เตรียมอุปกรณ์:</strong> ตรวจสอบแบตเตอรี่แท็บเล็ตให้เพียงพอต่อการสอบ และเชื่อมต่ออินเทอร์เน็ตให้เรียบร้อย</li>
              <li><strong>เข้าสู่ระบบสอบ:</strong> เปิดลิงก์ข้อสอบที่กำหนดผ่านเบราว์เซอร์ (Safari หรือ Chrome)</li>
            </ul>
          </div>

          <div className="bg-red-50 border border-red-200 p-6 rounded-xl">
            <h2 className="font-bold text-lg mb-3 text-red-700 flex items-center gap-2"><span className="text-xl">🚨</span> กฎระเบียบระหว่างการสอบ (ข้อควรระวังอย่างยิ่ง)</h2>
            <p className="text-red-600">
              <strong>ห้ามสลับหน้าจอหรือออกจากการสอบเด็ดขาด:</strong> ระบบข้อสอบมีการติดตั้งระบบตรวจจับพฤติกรรม (Tab Switching Detection) หากนักเรียนพยายามปัดหน้าจอ พับหน้าจอ เปิดแท็บใหม่ หรือสลับไปใช้แอปพลิเคชันอื่น (เช่น Google หรือแอป AI) ระบบจะทำการบันทึกพฤติกรรมการทุจริตทันที และอาจส่งผลให้การสอบครั้งนี้เป็นโมฆะ
            </p>
          </div>

          <p className="text-center font-medium text-[#8E7B6C] mt-6 pt-4 border-t border-[#F5EBE4]">
            ขอให้นักเรียนชั้น ม.6 ทุกคนเชื่อมั่นในศักยภาพของตนเอง ตั้งใจทำข้อสอบอย่างเต็มความสามารถ และมีความซื่อสัตย์สุจริต
          </p>
        </div>
        <button 
          onClick={onNext}
          className="w-full py-4 mt-8 bg-[#8E7B6C] hover:bg-[#726255] text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-colors"
        >
          รับทราบและเข้าสู่ระบบ <ChevronRight />
        </button>
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
    <div className="flex items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 border border-[#E3D5CA]">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-[#F5EBE4] text-[#8E7B6C] rounded-full flex items-center justify-center mx-auto mb-4">
            <User size={32} />
          </div>
          <h1 className="text-2xl font-bold text-[#4A3B32]">ระบบสอบวิชาสังคมศึกษา</h1>
          <p className="text-[#8E7B6C] mt-2">กรุณาเข้าสู่ระบบด้วยรหัสนักเรียน</p>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">รหัสนักเรียน / ชื่อผู้ใช้</label>
            <input 
              type="text" 
              value={id} 
              onChange={e => setId(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-[#E3D5CA] bg-[#FDFBF7] focus:outline-none focus:ring-2 focus:ring-[#C8B6A6] transition-colors"
              placeholder="กรอกรหัสนักเรียน"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">รหัสผ่าน</label>
            <input 
              type="password" 
              value={pass} 
              onChange={e => setPass(e.target.value)}
              className="w-full px-4 py-3 rounded-lg border border-[#E3D5CA] bg-[#FDFBF7] focus:outline-none focus:ring-2 focus:ring-[#C8B6A6] transition-colors"
              placeholder="กรอกรหัสผ่าน"
            />
          </div>
          
          {error && <p className="text-red-500 text-sm flex items-center gap-1"><AlertCircle size={16}/>{error}</p>}
          
          <button type="submit" className="w-full py-3 mt-4 bg-[#8E7B6C] hover:bg-[#726255] text-white rounded-lg font-medium transition-colors">
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
    <div className="max-w-2xl mx-auto p-4 pt-12">
      <div className="bg-white rounded-2xl shadow-sm border border-[#E3D5CA] p-8">
        <div className="flex justify-between items-start mb-6">
          <h2 className="text-2xl font-bold text-[#4A3B32]">ข้อมูลนักเรียน</h2>
          <button onClick={onLogout} className="text-[#8E7B6C] hover:text-[#4A3B32] p-2 flex items-center gap-2">
            <LogOut size={20} /> ออกจากระบบ
          </button>
        </div>

        <div className="space-y-4 mb-8 bg-[#FDFBF7] p-6 rounded-xl border border-[#F5EBE4]">
          <div className="flex gap-4"><span className="w-32 text-[#8E7B6C]">รหัสนักเรียน:</span> <span className="font-medium">{student.id}</span></div>
          <div className="flex gap-4"><span className="w-32 text-[#8E7B6C]">ชื่อ-สกุล:</span> <span className="font-medium">{student.name}</span></div>
          <div className="flex gap-4"><span className="w-32 text-[#8E7B6C]">ชั้น:</span> <span className="font-medium">ม.{student.class}</span></div>
          <div className="flex gap-4"><span className="w-32 text-[#8E7B6C]">เลขที่:</span> <span className="font-medium">{student.number}</span></div>
        </div>

        <div className="mb-8">
          <label className="block font-medium mb-3">โปรดยืนยันห้องเรียนของท่านเพื่อรับชุดข้อสอบ:</label>
          <div className="flex gap-4">
            <label className={`flex-1 p-4 rounded-xl border cursor-pointer flex items-center justify-center gap-2 transition-all ${selectedClass === '6/3' ? 'border-[#8E7B6C] bg-[#F5EBE4] text-[#4A3B32]' : 'border-[#E3D5CA] hover:bg-[#FDFBF7]'}`}>
              <input type="radio" name="class" value="6/3" checked={selectedClass === '6/3'} onChange={() => setSelectedClass('6/3')} className="hidden" />
              <CheckCircle2 size={20} className={selectedClass === '6/3' ? 'opacity-100' : 'opacity-0'} />
              ม.6/3
            </label>
            <label className={`flex-1 p-4 rounded-xl border cursor-pointer flex items-center justify-center gap-2 transition-all ${selectedClass === '6/8' ? 'border-[#8E7B6C] bg-[#F5EBE4] text-[#4A3B32]' : 'border-[#E3D5CA] hover:bg-[#FDFBF7]'}`}>
              <input type="radio" name="class" value="6/8" checked={selectedClass === '6/8'} onChange={() => setSelectedClass('6/8')} className="hidden" />
              <CheckCircle2 size={20} className={selectedClass === '6/8' ? 'opacity-100' : 'opacity-0'} />
              ม.6/8
            </label>
          </div>
        </div>

        <div className="bg-red-50 p-4 rounded-lg mb-8 text-sm text-red-700 flex gap-3 items-start">
          <ShieldAlert size={20} className="shrink-0 mt-0.5" />
          <p><strong>คำเตือน:</strong> หากเริ่มทำข้อสอบแล้ว ห้ามย่อหน้าต่าง เปลี่ยนแท็บ หรือเปิดโปรแกรมอื่นเด็ดขาด หากระบบตรวจพบการละเมิดเกิน 2 ครั้ง จะถือว่าทุจริตและปรับคะแนนเป็น 0 ทันที</p>
        </div>

        <button 
          onClick={() => onStart(selectedClass)}
          className="w-full py-4 bg-[#8E7B6C] hover:bg-[#726255] text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 transition-colors"
        >
          เริ่มทำข้อสอบ <ChevronRight />
        </button>
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
  
  const [currentType, setCurrentType] = useState<'mcq' | 'subj'>('mcq');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(false);

  // Initialize and Shuffle
  useEffect(() => {
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
          handleSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isTerminated]);

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
      
      const now = Date.now();
      // Debounce: prevent multiple triggers within 2 seconds
      if (now - lastCheatTime.current < 2000) return;
      lastCheatTime.current = now;

      setCheatCount(prev => {
        const newCount = prev + 1;
        if (newCount >= 2) {
          setIsTerminated(true);
          alert("คุณละเมิดกฎการสอบ (เปลี่ยนหน้าจอ/ย่อหน้าต่าง/เปิดแท็บใหม่) ครบ 2 ครั้ง ระบบทำการยุติการสอบและปรับตก (0 คะแนน)");
          forceSubmit(newCount);
        } else {
          alert(`คำเตือน! ห้ามเปลี่ยนหน้าจอ ย่อหน้าต่าง หรือเปิดแท็บใหม่ (ครั้งที่ ${newCount}/2) หากครบ 2 ครั้งจะถูกปรับตกทันที`);
        }
        return newCount;
      });
    };

    // Note: window.blur is disabled here because in an iframe environment (like AI Studio)
    // clicking outside the iframe (e.g. on the chat) triggers blur, causing false positives.
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') handleViolation();
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isTerminated]);

  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const forceSubmit = (cheats: number) => {
    const timeTakenMs = Date.now() - startTime.current;
    onFinish({
      id: `sub_${Date.now()}`,
      studentId: student.id,
      classGroup: student.class,
      mcqAnswers: {},
      subjAnswers: {},
      mcqScore: 0,
      timeTakenMs,
      cheatCount: cheats,
      submittedAt: Date.now(),
      subjScores: {}
    });
  };

  const executeSubmit = () => {
    const timeTakenMs = Date.now() - startTime.current;
    
    // Calculate score
    let score = 0;
    shuffledMcqs.forEach(q => {
      if (mcqAnswers[q.id] === q.originalCorrectText) {
        score += 1;
      }
    });

    onFinish({
      id: `sub_${Date.now()}`,
      studentId: student.id,
      classGroup: student.class,
      mcqAnswers,
      subjAnswers,
      mcqScore: score,
      timeTakenMs,
      cheatCount,
      submittedAt: Date.now(),
      subjScores: {}
    });
  };

  const handleSubmit = () => {
    setConfirmSubmit(true);
  };

  if (isTerminated) {
    return <div className="min-h-screen flex items-center justify-center text-red-600 font-bold text-2xl">ถูกยุติการสอบเนื่องจากทุจริต</div>;
  }

  if (shuffledMcqs.length === 0) return <div>Loading...</div>;

  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;
  
  const questionPrefixes = ['ก', 'ข', 'ค', 'ง', 'จ'];

  return (
    <div 
      className="max-w-4xl mx-auto p-4 pt-8 select-none"
      onContextMenu={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-[#E3D5CA] p-4 flex justify-between items-center mb-6 sticky top-4 z-10">
        <div>
          <div className="font-bold text-[#4A3B32]">ม.{student.class} เลขที่ {student.number}</div>
          <div className="text-sm text-[#8E7B6C]">{student.name}</div>
        </div>
        <div className="flex gap-4 items-center">
          <button onClick={() => setShowGrid(!showGrid)} className="flex items-center gap-2 text-sm bg-[#F5EBE4] border border-[#E3D5CA] px-3 py-2 rounded-lg hover:bg-[#E3D5CA] text-[#4A3B32] transition-colors">
            <CheckSquare size={18} /> ดูสถานะข้อสอบ (Recheck)
          </button>
          <div className={`flex items-center gap-2 font-mono text-xl ${timeLeft < 300 ? 'text-red-500' : 'text-[#8E7B6C]'}`}>
            <Clock size={24} />
            {mins.toString().padStart(2, '0')}:{secs.toString().padStart(2, '0')}
          </div>
        </div>
      </div>

      {showGrid && (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-[#E3D5CA] mb-6">
          <h4 className="font-bold text-md mb-3 text-[#4A3B32]">ตอนที่ 1: ปรนัย</h4>
          <div className="flex flex-wrap gap-2 mb-6">
            {shuffledMcqs.map((q, i) => (
              <button key={q.id} onClick={() => { setCurrentType('mcq'); setCurrentIndex(i); setShowGrid(false); }}
                className={`w-10 h-10 flex items-center justify-center rounded-lg border text-sm font-medium transition-colors ${mcqAnswers[q.id] ? 'bg-green-500 text-white border-green-600' : 'bg-[#FDFBF7] border-[#E3D5CA] text-[#8E7B6C] hover:bg-[#F5EBE4]'}`}>
                {i+1}
              </button>
            ))}
          </div>
          <h4 className="font-bold text-md mb-3 text-[#4A3B32]">ตอนที่ 2: อัตนัย</h4>
          <div className="flex flex-wrap gap-2">
            {subjs.map((q, i) => (
              <button key={q.id} onClick={() => { setCurrentType('subj'); setCurrentIndex(i); setShowGrid(false); }}
                className={`w-10 h-10 flex items-center justify-center rounded-lg border text-sm font-medium transition-colors ${subjAnswers[q.id]?.trim() ? 'bg-green-500 text-white border-green-600' : 'bg-[#FDFBF7] border-[#E3D5CA] text-[#8E7B6C] hover:bg-[#F5EBE4]'}`}>
                {i+1}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="bg-white rounded-xl shadow-sm border border-[#E3D5CA] p-8 min-h-[500px] flex flex-col">
        {currentType === 'mcq' ? (
          <>
            <div className="text-sm text-[#8E7B6C] mb-4 font-medium">ตอนที่ 1: ปรนัย (ข้อ {currentIndex + 1} / {shuffledMcqs.length})</div>
            <div className="text-xl text-[#4A3B32] mb-8 leading-relaxed">
              {currentIndex + 1}. {shuffledMcqs[currentIndex].text}
            </div>
            
            <div className="space-y-3 flex-1">
              {shuffledMcqs[currentIndex].shuffledOptions.map((opt: string, i: number) => {
                const isSelected = mcqAnswers[shuffledMcqs[currentIndex].id] === opt;
                return (
                  <label key={i} className={`block p-4 rounded-xl border cursor-pointer transition-all ${isSelected ? 'border-[#8E7B6C] bg-[#F5EBE4] text-[#4A3B32]' : 'border-[#E3D5CA] hover:bg-[#FDFBF7]'}`}>
                    <input 
                      type="radio" 
                      name={`mcq_${currentIndex}`} 
                      className="hidden"
                      checked={isSelected}
                      onChange={() => setMcqAnswers({...mcqAnswers, [shuffledMcqs[currentIndex].id]: opt})}
                    />
                    <div className="flex gap-4 items-center">
                      <div className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-medium ${isSelected ? 'bg-[#8E7B6C] text-white' : 'bg-[#FDFBF7] border border-[#E3D5CA]'}`}>
                        {questionPrefixes[i]}
                      </div>
                      <span className="flex-1">{opt}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="text-sm text-[#8E7B6C] mb-4 font-medium">ตอนที่ 2: อัตนัย (ข้อ {currentIndex + 1} / {subjs.length})</div>
            <div className="text-xl text-[#4A3B32] mb-8 leading-relaxed">
              {currentIndex + 1}. {subjs[currentIndex].text}
            </div>
            
            <div className="flex-1">
              <textarea 
                className="w-full h-48 p-4 rounded-xl border border-[#E3D5CA] focus:outline-none focus:ring-2 focus:ring-[#C8B6A6] bg-[#FDFBF7] resize-none select-text"
                placeholder="พิมพ์คำตอบของคุณที่นี่..."
                value={subjAnswers[subjs[currentIndex].id] || ''}
                onChange={(e) => setSubjAnswers({...subjAnswers, [subjs[currentIndex].id]: e.target.value})}
              />
            </div>
          </>
        )}

        {/* Footer Navigation */}
        <div className="flex justify-between items-center mt-8 pt-6 border-t border-[#F5EBE4]">
          <button 
            onClick={() => {
              if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
              else if (currentType === 'subj') { setCurrentType('mcq'); setCurrentIndex(shuffledMcqs.length - 1); }
            }}
            disabled={currentType === 'mcq' && currentIndex === 0}
            className="px-6 py-3 rounded-lg border border-[#E3D5CA] text-[#8E7B6C] hover:bg-[#FDFBF7] disabled:opacity-50"
          >
            ก่อนหน้า
          </button>
          
          <div className="flex gap-2">
            <button 
              onClick={() => setCurrentType('mcq')}
              className={`w-3 h-3 rounded-full ${currentType === 'mcq' ? 'bg-[#8E7B6C]' : 'bg-[#E3D5CA]'}`}
            />
            <button 
              onClick={() => setCurrentType('subj')}
              className={`w-3 h-3 rounded-full ${currentType === 'subj' ? 'bg-[#8E7B6C]' : 'bg-[#E3D5CA]'}`}
            />
          </div>

          {(currentType === 'mcq' && currentIndex === shuffledMcqs.length - 1) ? (
            <button 
              onClick={() => { setCurrentType('subj'); setCurrentIndex(0); }}
              className="px-6 py-3 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255]"
            >
              ถัดไป (อัตนัย)
            </button>
          ) : (currentType === 'subj' && currentIndex === subjs.length - 1) ? (
            <button 
              onClick={handleSubmit}
              className="px-8 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-bold"
            >
              ส่งข้อสอบ
            </button>
          ) : (
            <button 
              onClick={() => setCurrentIndex(currentIndex + 1)}
              className="px-6 py-3 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255]"
            >
              ถัดไป
            </button>
          )}
        </div>
      </div>
      {confirmSubmit && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md text-center">
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">ยืนยันการส่งข้อสอบ</h3>
            <p className="mb-6 text-[#5C4D42]">
              คุณต้องการส่งข้อสอบใช่หรือไม่? เมื่อส่งแล้วจะไม่สามารถแก้ไขได้
            </p>
            <div className="flex justify-center gap-4">
              <button onClick={() => setConfirmSubmit(false)} className="px-6 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded-lg hover:bg-[#FDFBF7]">ยกเลิก</button>
              <button onClick={() => {
                setConfirmSubmit(false);
                executeSubmit();
              }} className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700">ยืนยันการส่ง</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- RESULT VIEW ---
function ResultView({ student, submission, mcqs, subjs, onLogout }: { student: Student, submission: Submission, mcqs: MCQ[], subjs: Subjective[], onLogout: () => void }) {
  const mins = Math.floor(submission.timeTakenMs / 60000);
  const secs = Math.floor((submission.timeTakenMs % 60000) / 1000);

  return (
    <div className="max-w-3xl mx-auto p-4 pt-12">
      <div className="bg-white rounded-2xl shadow-sm border border-[#E3D5CA] p-8 text-center">
        <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h2 className="text-3xl font-bold text-[#4A3B32] mb-2">ส่งข้อสอบสำเร็จ</h2>
        <p className="text-[#8E7B6C] mb-8">ระบบได้บันทึกคำตอบของท่านเรียบร้อยแล้ว</p>

        <div className="bg-[#FDFBF7] border border-[#F5EBE4] rounded-xl p-6 text-left space-y-4 mb-8">
          <div className="grid grid-cols-2 gap-4">
            <div className="text-[#8E7B6C]">รหัสนักเรียน</div><div className="font-medium text-right">{student.id}</div>
            <div className="text-[#8E7B6C]">ชื่อ-สกุล</div><div className="font-medium text-right">{student.name}</div>
            <div className="text-[#8E7B6C]">ชั้น / เลขที่</div><div className="font-medium text-right">ม.{student.class} / {student.number}</div>
            <div className="col-span-2 border-t border-[#E3D5CA] my-2"></div>
            <div className="text-[#8E7B6C]">เวลาที่ใช้สอบ</div><div className="font-medium text-right text-blue-600">{mins} นาที {secs} วินาที</div>
            <div className="text-[#8E7B6C]">สถานะการสอบ</div>
            <div className="font-bold text-right text-xl text-green-600">ส่งแล้ว</div>
            <div className="text-[#8E7B6C]">คำเตือนทุจริต</div>
            <div className={`font-medium text-right ${submission.cheatCount > 0 ? 'text-red-500' : 'text-gray-500'}`}>{submission.cheatCount} ครั้ง</div>
          </div>
        </div>

        <div className="text-left mb-8">
          <h3 className="font-bold text-lg mb-4 text-[#4A3B32]">คำตอบอัตนัยที่ส่ง</h3>
          <div className="space-y-4">
            {subjs.filter(s => s.classGroup === 'ทั้งหมด' || s.classGroup === 'all' || s.classGroup.includes(student.class)).map((s, i) => (
              <div key={s.id} className="bg-[#FDFBF7] p-4 rounded-lg border border-[#F5EBE4]">
                <div className="text-sm font-medium mb-2">{i+1}. {s.text}</div>
                <div className="text-[#8E7B6C] whitespace-pre-wrap">{submission.subjAnswers[s.id] || '- ไม่ได้ตอบ -'}</div>
              </div>
            ))}
          </div>
        </div>

        <button 
          onClick={onLogout}
          className="px-8 py-3 bg-[#8E7B6C] hover:bg-[#726255] text-white rounded-lg font-medium"
        >
          กลับหน้าแรก
        </button>
      </div>
    </div>
  );
}

// --- ADMIN VIEW ---
function AdminView({ students, setStudents, mcqs, setMcqs, submissions, setSubmissions, subjs, setSubjs, onLogout }: any) {
  const [tab, setTab] = useState<'students' | 'mcqs' | 'subjs' | 'grading'>('students');
  const [isImporting, setIsImporting] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);

  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [newStudent, setNewStudent] = useState({ id: '', prefix: '', firstName: '', lastName: '', class: '', number: '' });
  
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

  useEffect(() => {
    initAuth(() => setAuthInitialized(true), () => setAuthInitialized(true));
  }, []);

  const handleImportSheet = async () => {
    try {
      setIsImporting(true);
      let token = await getAccessToken();
      if (!token) {
        const result = await googleSignIn();
        if (result) token = result.accessToken;
      }
      
      if (!token) throw new Error("Authentication failed");

      // The sheet ID from user's URL
      const spreadsheetId = '1Bt9tuUiXmmBH99Ij0m3-Z3hG7V31Ua-i';

      const fileMetaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=mimeType`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const fileMeta = await fileMetaRes.json();
      
      let newStudents: Student[] = [];

      if (fileMeta.mimeType === 'application/vnd.google-apps.spreadsheet') {
        // Native Google Sheets
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A2:E`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.values) {
          newStudents = data.values.map((row: any[]) => ({
            id: row[4] ? row[4].toString().trim() : '',
            name: row[3] ? row[3].toString().trim() : '',
            class: row[2] ? row[2].toString().replace('ม.', '').trim() : '',
            number: row[1] ? (parseInt(row[1], 10) || 0) : 0
          })).filter((s: any) => s.id && s.name);
        }
      } else {
        // Excel file (.xlsx) or other binary format viewed in Drive
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?alt=media`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const arrayBuffer = await res.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        
        // Skip header (row 0), and map the same columns
        newStudents = data.slice(1).map((row: any[]) => ({
          id: row[4] ? row[4].toString().trim() : '',
          name: row[3] ? row[3].toString().trim() : '',
          class: row[2] ? row[2].toString().replace('ม.', '').trim() : '',
          number: row[1] ? (parseInt(row[1], 10) || 0) : 0
        })).filter((s: any) => s.id && s.name);
      }
      
      if (newStudents.length > 0) {
        // Merge with existing, updating matches by ID and adding new ones
        const studentMap = new Map<string, Student>(students.map((s: Student) => [s.id, s]));
        let added = 0;
        let updated = 0;
        
        newStudents.forEach((newS: Student) => {
          if (studentMap.has(newS.id)) {
            const existing = studentMap.get(newS.id);
            if (existing!.name !== newS.name || existing!.class !== newS.class || existing!.number !== newS.number) {
              updated++;
              studentMap.set(newS.id, newS);
            }
          } else {
            added++;
            studentMap.set(newS.id, newS);
          }
        });
        
        setStudents(Array.from(studentMap.values()));
        alert(`นำเข้านักเรียนสำเร็จ เพิ่มใหม่ ${added} คน, อัปเดตข้อมูล ${updated} คน`);
      } else {
        alert('ไม่พบข้อมูลนักเรียน หรือรูปแบบตารางไม่ถูกต้อง (ต้องมีคอลัมน์ ลำดับ, เลขที่, ระดับชั้น, ชื่อ-นามสกุล, รหัสนักเรียน)');
      }
    } catch (err: any) {
      console.error(err);
      alert('เกิดข้อผิดพลาดในการนำเข้าข้อมูล: ' + err.message);
    } finally {
      setIsImporting(false);
    }
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let token = await getAccessToken();
      if (!token) {
        const result = await googleSignIn();
        if (result) token = result.accessToken;
      }
      if (token) {
        const spreadsheetId = '1Bt9tuUiXmmBH99Ij0m3-Z3hG7V31Ua-i';
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A:E:append?valueInputOption=USER_ENTERED`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            values: [['', newStudent.number, `ม.${newStudent.class}`, `${newStudent.prefix}${newStudent.firstName} ${newStudent.lastName}`.trim(), newStudent.id]]
          })
        });
      }
      const createdStudent: Student = {
        id: newStudent.id,
        name: `${newStudent.prefix}${newStudent.firstName} ${newStudent.lastName}`.trim(),
        class: newStudent.class,
        number: parseInt(newStudent.number, 10) || 0
      };
      setStudents([...students, createdStudent]);
      setIsAddingStudent(false);
      setNewStudent({ id: '', prefix: '', firstName: '', lastName: '', class: '', number: '' });
      alert('เพิ่มนักเรียนและบันทึกลง Google Sheet สำเร็จ');
    } catch (err: any) {
      alert('เพิ่มข้อมูลไม่สำเร็จ: ' + err.message);
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

  const handleImportTextSubmit = (targetClass: string) => {
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
    <div className="min-h-screen bg-[#FDFBF7] flex">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-[#E3D5CA] p-6 flex flex-col">
        <h2 className="text-xl font-bold text-[#4A3B32] mb-8">ระบบจัดการสอบ</h2>
        <div className="space-y-2 flex-1">
          <button onClick={() => setTab('students')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'students' ? 'bg-[#F5EBE4] text-[#4A3B32] font-medium' : 'text-[#8E7B6C] hover:bg-[#FDFBF7]'}`}>จัดการนักเรียน</button>
          <button onClick={() => setTab('mcqs')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'mcqs' ? 'bg-[#F5EBE4] text-[#4A3B32] font-medium' : 'text-[#8E7B6C] hover:bg-[#FDFBF7]'}`}>คลังข้อสอบ (ปรนัย)</button>
          <button onClick={() => setTab('subjs')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'subjs' ? 'bg-[#F5EBE4] text-[#4A3B32] font-medium' : 'text-[#8E7B6C] hover:bg-[#FDFBF7]'}`}>คลังข้อสอบ (อัตนัย)</button>
          <button onClick={() => setTab('grading')} className={`w-full text-left px-4 py-3 rounded-lg ${tab === 'grading' ? 'bg-[#F5EBE4] text-[#4A3B32] font-medium' : 'text-[#8E7B6C] hover:bg-[#FDFBF7]'}`}>ตรวจผลสอบ</button>
        </div>
        <button onClick={onLogout} className="mt-auto flex items-center gap-2 text-red-600 px-4 py-2 hover:bg-red-50 rounded-lg">
          <LogOut size={20} /> ออกจากระบบ
        </button>
      </div>

      {/* Main Area */}
      <div className="flex-1 p-8 overflow-y-auto h-screen">
        {tab === 'students' && (
          <div>
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-2xl font-bold">รายชื่อนักเรียน</h3>
              <div className="flex gap-2">
                <button 
                  onClick={handleImportSheet}
                  disabled={isImporting || !authInitialized}
                  className="flex items-center gap-2 px-4 py-2 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255] text-sm disabled:opacity-50"
                >
                  {isImporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  นำเข้า Google Sheet
                </button>
                <button onClick={() => setIsAddingStudent(true)} className="flex items-center gap-2 px-4 py-2 bg-[#4A3B32] text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มนักเรียน
                </button>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-[#E3D5CA] overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#F5EBE4]">
                  <tr>
                    <th className="p-4 font-medium text-[#4A3B32]">รหัส</th>
                    <th className="p-4 font-medium text-[#4A3B32]">ชื่อ-สกุล</th>
                    <th className="p-4 font-medium text-[#4A3B32]">ชั้น</th>
                    <th className="p-4 font-medium text-[#4A3B32]">เลขที่</th>
                    <th className="p-4 font-medium text-[#4A3B32]">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E3D5CA]">
                  {students.map((s: Student) => (
                    <tr key={s.id} className="hover:bg-[#FDFBF7]">
                      <td className="p-4">{s.id}</td>
                      <td className="p-4">{s.name}</td>
                      <td className="p-4">{s.class}</td>
                      <td className="p-4">{s.number}</td>
                      <td className="p-4 flex gap-2 text-[#8E7B6C]">
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
              <h3 className="text-2xl font-bold">คลังข้อสอบ (ปรนัย)</h3>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDeleteAllMcqs(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm">
                  <Trash2 size={16} /> ลบทั้งหมด
                </button>
                <button onClick={() => setIsImportingMcqText(true)} className="flex items-center gap-2 px-4 py-2 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255] text-sm">
                  <Upload size={16} /> นำเข้าจากข้อความ
                </button>
                <label className="flex items-center gap-2 px-4 py-2 bg-[#8E7B6C] text-white rounded-lg hover:bg-[#726255] text-sm cursor-pointer">
                  <Upload size={16} /> นำเข้า Word
                  <input type="file" accept=".docx" className="hidden" onChange={handleImportWord} />
                </label>
                <button onClick={() => setIsAddingMcq(true)} className="flex items-center gap-2 px-4 py-2 bg-[#4A3B32] text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มข้อสอบ
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {mcqs.map((m: MCQ, i: number) => (
                <div key={m.id} className="bg-white p-6 rounded-xl border border-[#E3D5CA] shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <span className="bg-[#F5EBE4] px-3 py-1 rounded text-sm text-[#4A3B32]">ม.{m.classGroup}</span>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingMcq(m)} className="text-[#8E7B6C] hover:text-blue-600"><Edit2 size={18} /></button>
                      <button onClick={() => setMcqToDelete(m)} className="text-[#8E7B6C] hover:text-red-600"><Trash2 size={18} /></button>
                    </div>
                  </div>
                  <div className="font-medium mb-4">{m.text}</div>
                  <div className="grid grid-cols-2 gap-2 text-sm text-[#8E7B6C]">
                    {m.options.map((opt, idx) => (
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
              <h3 className="text-2xl font-bold">คลังข้อสอบ (อัตนัย)</h3>
              <div className="flex gap-2">
                <button onClick={() => setConfirmDeleteAllSubjs(true)} className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm">
                  <Trash2 size={16} /> ลบทั้งหมด
                </button>
                <button onClick={() => setIsAddingSubj(true)} className="flex items-center gap-2 px-4 py-2 bg-[#4A3B32] text-white rounded-lg hover:bg-black text-sm">
                  <Plus size={16} /> เพิ่มข้อสอบ
                </button>
              </div>
            </div>
            <div className="space-y-4">
              {subjs.map((s: Subjective, i: number) => (
                <div key={s.id} className="bg-white p-6 rounded-xl border border-[#E3D5CA] shadow-sm">
                  <div className="flex justify-between items-start mb-4">
                    <span className="bg-[#F5EBE4] px-3 py-1 rounded text-sm text-[#4A3B32]">ม.{s.classGroup}</span>
                    <div className="flex gap-2">
                      <button onClick={() => setEditingSubj(s)} className="text-[#8E7B6C] hover:text-blue-600"><Edit2 size={18} /></button>
                      <button onClick={() => setSubjToDelete(s)} className="text-[#8E7B6C] hover:text-red-600"><Trash2 size={18} /></button>
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
              <h3 className="text-2xl font-bold">ผลการสอบและการตรวจให้คะแนน</h3>
              <button onClick={handleExportCSV} className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm">
                <Download size={16} /> ส่งออกข้อมูล (CSV)
              </button>
            </div>
            
            <div className="bg-white rounded-xl border border-[#E3D5CA] overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#F5EBE4]">
                  <tr>
                    <th className="p-4 font-medium text-[#4A3B32]">วันที่/เวลาส่ง</th>
                    <th className="p-4 font-medium text-[#4A3B32]">รหัส นร.</th>
                    <th className="p-4 font-medium text-[#4A3B32]">คะแนน (ปรนัย+อัตนัย)</th>
                    <th className="p-4 font-medium text-[#4A3B32]">เวลาที่ใช้</th>
                    <th className="p-4 font-medium text-[#4A3B32]">สถานะทุจริต</th>
                    <th className="p-4 font-medium text-[#4A3B32]">จัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E3D5CA]">
                  {submissions.map((s: Submission) => {
                    const subjScoreTotal = Object.values(s.subjScores || {}).reduce((a: number, b: number) => a + b, 0);
                    return (
                    <tr key={s.id} className="hover:bg-[#FDFBF7]">
                      <td className="p-4">{new Date(s.submittedAt).toLocaleString('th-TH')}</td>
                      <td className="p-4">{s.studentId}</td>
                      <td className="p-4 font-bold text-green-600">{s.mcqScore} + {subjScoreTotal} = {s.mcqScore + subjScoreTotal}</td>
                      <td className="p-4">{Math.floor(s.timeTakenMs/60000)} น.</td>
                      <td className="p-4">
                        {s.cheatCount > 0 ? <span className="text-red-500 font-medium">พบ ({s.cheatCount})</span> : <span className="text-green-500">ปกติ</span>}
                      </td>
                      <td className="p-4 text-blue-600 cursor-pointer hover:underline" onClick={() => { setGradingSub(s); setTempScores(s.subjScores || {}); }}>ตรวจอัตนัย</td>
                    </tr>
                  )})}
                  {submissions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-[#8E7B6C]">ยังไม่มีข้อมูลการส่งข้อสอบ</td>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">แก้ไขข้อมูลนักเรียน</h3>
            <div className="space-y-3 text-[#5C4D42]">
              <div><label className="block text-sm">เลขที่</label><input className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingStudent.number} onChange={e=>setEditingStudent({...editingStudent, number: parseInt(e.target.value) || 0})} /></div>
              <div><label className="block text-sm">รหัสนักเรียน (ไม่ควรแก้)</label><input className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingStudent.id} onChange={e=>setEditingStudent({...editingStudent, id: e.target.value})} disabled /></div>
              <div><label className="block text-sm">ชื่อ-นามสกุล</label><input className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingStudent.name} onChange={e=>setEditingStudent({...editingStudent, name: e.target.value})} /></div>
              <div><label className="block text-sm">ชั้น</label><input className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingStudent.class} onChange={e=>setEditingStudent({...editingStudent, class: e.target.value})} /></div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setEditingStudent(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">เพิ่มนักเรียนใหม่ (บันทึกลง Sheet)</h3>
            <form onSubmit={handleAddStudent} className="space-y-3 text-[#5C4D42]">
              <div><label className="block text-sm">เลขที่</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.number} onChange={e=>setNewStudent({...newStudent, number: e.target.value})} /></div>
              <div><label className="block text-sm">รหัสนักเรียน</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.id} onChange={e=>setNewStudent({...newStudent, id: e.target.value})} /></div>
              <div><label className="block text-sm">คำนำหน้า (เช่น นาย, นางสาว)</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.prefix} onChange={e=>setNewStudent({...newStudent, prefix: e.target.value})} /></div>
              <div><label className="block text-sm">ชื่อ</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.firstName} onChange={e=>setNewStudent({...newStudent, firstName: e.target.value})} /></div>
              <div><label className="block text-sm">นามสกุล</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.lastName} onChange={e=>setNewStudent({...newStudent, lastName: e.target.value})} /></div>
              <div><label className="block text-sm">ห้อง (เช่น 6/3)</label><input required className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newStudent.class} onChange={e=>setNewStudent({...newStudent, class: e.target.value})} /></div>
              <div className="flex justify-end gap-2 mt-6">
                <button type="button" onClick={()=>setIsAddingStudent(false)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
                <button type="submit" className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">บันทึก</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isAddingMcq && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">เพิ่มข้อสอบใหม่ (ปรนัย)</h3>
            <div className="space-y-4 text-[#5C4D42]">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newMcq.classGroup} onChange={e=>setNewMcq({...newMcq, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-[#E3D5CA] p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newMcq.text} onChange={e=>setNewMcq({...newMcq, text: e.target.value})} />
              </div>
              {newMcq.options.map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={opt} onChange={e => {
                      const newOpts = [...newMcq.options];
                      newOpts[idx] = e.target.value;
                      setNewMcq({...newMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setNewMcq({...newMcq, correctIndex: idx})} className={`px-4 rounded border ${newMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-[#FDFBF7] border-[#E3D5CA] text-[#8E7B6C]'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setIsAddingMcq(false)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-2 text-[#4A3B32] shrink-0">นำเข้าข้อสอบจากข้อความ (คัดลอกและวาง)</h3>
            <p className="text-sm text-[#8E7B6C] mb-4 shrink-0">
              รูปแบบที่รองรับ:<br/>
              1. คำถาม<br/>
              ก. ตัวเลือกที่ 1<br/>
              ข. ตัวเลือกที่ 2<br/>
              ค. ตัวเลือกที่ 3<br/>
              ง. ตัวเลือกที่ 4<br/>
              ตอบ: ก
            </p>
            <div className="mb-4 shrink-0">
              <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
              <input 
                type="text" 
                className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" 
                placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" 
                defaultValue="ทั้งหมด"
                id="importClassInput"
              />
            </div>
            <div className="flex-1 mb-4 relative min-h-[150px]">
              <textarea 
                className="absolute inset-0 w-full h-full border border-[#E3D5CA] p-4 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#C8B6A6] resize-none" 
                placeholder="วางข้อความที่นี่..." 
                value={mcqImportText} 
                onChange={e => setMcqImportText(e.target.value)} 
              />
            </div>
            <div className="flex justify-end gap-2 shrink-0">
              <button onClick={() => { setIsImportingMcqText(false); setMcqImportText(''); }} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
              <button onClick={() => {
                const classInput = document.getElementById('importClassInput') as HTMLInputElement;
                handleImportTextSubmit(classInput ? classInput.value : 'ทั้งหมด');
              }} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700">นำเข้าข้อสอบ</button>
            </div>
          </div>
        </div>
      )}

      {editingMcq && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">แก้ไขข้อสอบ (ปรนัย)</h3>
            <div className="space-y-4 text-[#5C4D42]">
              <div><label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label><input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingMcq.classGroup} onChange={e=>setEditingMcq({...editingMcq, classGroup: e.target.value})} /></div>
              <div><label className="block text-sm font-bold mb-1">คำถาม</label><textarea className="w-full border border-[#E3D5CA] p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingMcq.text} onChange={e=>setEditingMcq({...editingMcq, text: e.target.value})} /></div>
              {editingMcq.options.map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={opt} onChange={e => {
                      const newOpts = [...editingMcq.options];
                      newOpts[idx] = e.target.value;
                      setEditingMcq({...editingMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setEditingMcq({...editingMcq, correctIndex: idx})} className={`px-4 rounded border ${editingMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-[#FDFBF7] border-[#E3D5CA] text-[#8E7B6C]'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setEditingMcq(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
                <button onClick={handleSaveMcq} className="px-4 py-2 bg-[#8E7B6C] text-white rounded hover:bg-[#726255]">บันทึก</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {gradingSub && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl w-full max-w-3xl flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-6 border-b border-[#E3D5CA]">
              <div>
                <h3 className="text-xl font-bold text-[#4A3B32]">ตรวจข้อสอบอัตนัย</h3>
                <div className="text-sm text-[#8E7B6C] mt-1">รหัสนักเรียน: <span className="font-medium text-[#4A3B32]">{gradingSub.studentId}</span> | คะแนนปรนัย: <span className="font-medium text-green-600">{gradingSub.mcqScore}</span></div>
              </div>
              <button onClick={()=>setGradingSub(null)} className="text-[#8E7B6C] hover:text-[#4A3B32]"><X size={24} /></button>
            </div>
            
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-[#FDFBF7]">
              {subjs.filter((s: any) => s.classGroup === 'ทั้งหมด' || s.classGroup === 'all' || s.classGroup.includes(gradingSub.classGroup)).map((subj: any, i: number) => (
                <div key={subj.id} className="border border-[#E3D5CA] p-5 rounded-xl bg-white shadow-sm">
                  <div className="font-bold text-[#4A3B32] mb-3">ข้อ {i+1}: {subj.text}</div>
                  <div className="bg-[#FDFBF7] border border-[#F5EBE4] p-4 rounded-lg mb-4 min-h-[80px] whitespace-pre-wrap text-[#5C4D42]">
                    {gradingSub.subjAnswers[subj.id] || <span className="text-gray-400 italic">- ไม่ได้ตอบ -</span>}
                  </div>
                  <div className="flex items-center gap-3 bg-[#F5EBE4] p-3 rounded-lg w-max">
                    <label className="font-medium text-sm text-[#4A3B32]">ให้คะแนนข้อนี้:</label>
                    <input 
                      type="number" 
                      min="0"
                      className="border border-[#E3D5CA] p-2 rounded w-24 text-center font-bold text-[#4A3B32] focus:outline-none focus:ring-2 focus:ring-[#C8B6A6]"
                      value={tempScores[subj.id] ?? 0}
                      onChange={e => setTempScores({...tempScores, [subj.id]: parseInt(e.target.value) || 0})}
                    />
                  </div>
                </div>
              ))}
            </div>
            
            <div className="flex justify-end gap-3 p-6 border-t border-[#E3D5CA] bg-white rounded-b-xl">
              <button onClick={()=>setGradingSub(null)} className="px-6 py-2.5 border border-[#E3D5CA] text-[#8E7B6C] rounded-lg font-medium hover:bg-[#FDFBF7]">ยกเลิก</button>
              <button onClick={handleSaveGrading} className="px-6 py-2.5 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700">บันทึกคะแนนทั้งหมด</button>
            </div>
          </div>
        </div>
      )}

      {studentToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">ยืนยันการลบนักเรียน</h3>
            <p className="mb-6 text-[#5C4D42]">
              คุณต้องการลบรายชื่อนักเรียน <span className="font-bold">{studentToDelete.name}</span> (รหัส {studentToDelete.id}) ใช่หรือไม่?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setStudentToDelete(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">ยืนยันการลบข้อสอบ (ปรนัย)</h3>
            <p className="mb-6 text-[#5C4D42]">
              คุณต้องการลบข้อสอบนี้ใช่หรือไม่? <br/><br/>
              <span className="font-bold">{mcqToDelete.text}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setMcqToDelete(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">เพิ่มข้อสอบใหม่ (อัตนัย)</h3>
            <div className="space-y-4 text-[#5C4D42]">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newSubj.classGroup} onChange={e=>setNewSubj({...newSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-[#E3D5CA] p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={newSubj.text} onChange={e=>setNewSubj({...newSubj, text: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setIsAddingSubj(false)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">แก้ไขข้อสอบ (อัตนัย)</h3>
            <div className="space-y-4 text-[#5C4D42]">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-[#E3D5CA] p-2 rounded focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingSubj.classGroup} onChange={e=>setEditingSubj({...editingSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">คำถาม</label>
                <textarea className="w-full border border-[#E3D5CA] p-2 rounded h-24 focus:outline-none focus:ring-1 focus:ring-[#C8B6A6]" value={editingSubj.text} onChange={e=>setEditingSubj({...editingSubj, text: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setEditingSubj(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <h3 className="text-xl font-bold mb-4 text-[#4A3B32]">ยืนยันการลบข้อสอบ (อัตนัย)</h3>
            <p className="mb-6 text-[#5C4D42]">
              คุณต้องการลบข้อสอบนี้ใช่หรือไม่? <br/><br/>
              <span className="font-bold">{subjToDelete.text}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSubjToDelete(null)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <p className="mb-6 text-[#5C4D42]">
              คุณแน่ใจหรือไม่ว่าต้องการลบข้อสอบปรนัยทั้งหมดในคลัง? <br/><br/>
              <span className="font-bold text-red-600">การกระทำนี้ไม่สามารถกู้คืนได้</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteAllMcqs(false)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
            <p className="mb-6 text-[#5C4D42]">
              คุณแน่ใจหรือไม่ว่าต้องการลบข้อสอบอัตนัยทั้งหมดในคลัง? <br/><br/>
              <span className="font-bold text-red-600">การกระทำนี้ไม่สามารถกู้คืนได้</span>
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDeleteAllSubjs(false)} className="px-4 py-2 border border-[#E3D5CA] text-[#8E7B6C] rounded hover:bg-[#FDFBF7]">ยกเลิก</button>
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
