import React, { useState, useEffect, useRef, Component } from 'react';
import { 
  AlertCircle, Clock, CheckCircle2, ChevronRight, User, LogOut, Download, Plus, Trash2, 
  Edit2, ShieldAlert, Loader2, X, CheckSquare, Upload, Lock, RefreshCw, Copy, Check, 
  Printer, FileCheck, Archive, ArchiveRestore, FileDown, Highlighter, Bold, Italic, 
  Underline, Eye, BookOpen 
} from 'lucide-react';
import { replaceSharedCollection, subscribeSharedCollection, upsertSharedItems, saveSubmissionDirectly, flushPendingSubmissions, deleteSubmissionDirectly, deleteSubmissionsBatch, clearAllSubmissionsDirectly, type SharedCollectionName } from './firebase';
import mammoth from 'mammoth';

// --- TYPES ---
type Settings = {
  id: string;
  isOpen: boolean;
  currentExamType: 'midterm' | 'final' | 'general';
  examFormat?: 'both' | 'mcq_only' | 'subj_only';
  maxMcqCount?: number; // 0 หรือ undefined = ทั้งหมดในคลัง
  maxSubjCount?: number; // 0 หรือ undefined = ทั้งหมดในคลัง
  questionSelectionMode?: 'random' | 'order'; // 'random' (สุ่มข้อสอบ) หรือ 'order' (เรียงตามลำดับคลัง)
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

// ฟังก์ชันคัดเลือกข้อสอบตามจำนวนที่กำหนด (เช่น คลังมี 60 ข้อ คัดเลือกมา 45 ข้อ)
const selectExamQuestions = <T,>(
  items: T[], 
  limitCount?: number, 
  selectionMode: 'random' | 'order' = 'random'
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

// --- FORMATTED TEXT PARSER & RENDERER ---
function parseInlineFormatting(str: string): React.ReactNode[] {
  if (!str) return [];

  // Match our supported inline tokens:
  // 1: Highlight ==...== or <mark>...</mark> or [hl]...[/hl] or [yellow]...[/yellow]
  // 2: Bold **...** or <b>...</b> or <strong>...</strong>
  // 3: Underline __...__ or <u>...</u>
  // 4: Italic *...* or <i>...</i> or <em>...</em>
  // 5: Strikethrough ~~...~~ or <del>...</del> or <s>...</s>
  // 6: Red [red]...[/red]
  // 7: Blue [blue]...[/blue]
  // 8: Green [green]...[/green]
  // 9: Amber/Orange [orange]...[/orange] or [amber]...[/amber]
  // 10: Purple [purple]...[/purple]
  // 11: Badge [badge]...[/badge]
  const pattern = /(?:==([\s\S]+?)==|<mark>([\s\S]+?)<\/mark>|\[(?:hl|highlight|yellow)\]([\s\S]+?)\[\/(?:hl|highlight|yellow)\])|(?:\*\*([\s\S]+?)\*\*|<b>([\s\S]+?)<\/b>|<strong>([\s\S]+?)<\/strong>)|(?:__([\s\S]+?)__|<u>([\s\S]+?)<\/u>)|(?:\*([^\*\n]+?)\*|<i>([\s\S]+?)<\/i>|<em>([\s\S]+?)<\/em>)|(?:~~([\s\S]+?)~~|<del>([\s\S]+?)<\/del>|<s>([\s\S]+?)<\/s>)|(?:\[red\]([\s\S]+?)\[\/red\])|(?:\[blue\]([\s\S]+?)\[\/blue\])|(?:\[green\]([\s\S]+?)\[\/green\])|(?:\[(?:orange|amber)\]([\s\S]+?)\[\/(?:orange|amber)\])|(?:\[purple\]([\s\S]+?)\[\/purple\])|(?:\[badge\]([\s\S]+?)\[\/badge\])/gi;

  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(str)) !== null) {
    if (match.index > lastIndex) {
      elements.push(str.substring(lastIndex, match.index));
    }

    const hlContent = match[1] || match[2] || match[3];
    const boldContent = match[4] || match[5] || match[6];
    const underlineContent = match[7] || match[8];
    const italicContent = match[9] || match[10] || match[11];
    const delContent = match[12] || match[13] || match[14];
    const redContent = match[15];
    const blueContent = match[16];
    const greenContent = match[17];
    const orangeContent = match[18];
    const purpleContent = match[19];
    const badgeContent = match[20];

    const key = `inline-${match.index}`;

    if (hlContent !== undefined) {
      elements.push(
        <mark key={key} className="bg-amber-200 text-amber-950 font-bold px-1.5 py-0.5 mx-0.5 rounded-md border-b-2 border-amber-400 inline shadow-2xs">
          {parseInlineFormatting(hlContent)}
        </mark>
      );
    } else if (boldContent !== undefined) {
      elements.push(
        <strong key={key} className="font-bold text-slate-900">
          {parseInlineFormatting(boldContent)}
        </strong>
      );
    } else if (underlineContent !== undefined) {
      elements.push(
        <span key={key} className="underline underline-offset-4 decoration-2 decoration-blue-500 font-semibold">
          {parseInlineFormatting(underlineContent)}
        </span>
      );
    } else if (italicContent !== undefined) {
      elements.push(
        <em key={key} className="italic text-slate-800">
          {parseInlineFormatting(italicContent)}
        </em>
      );
    } else if (delContent !== undefined) {
      elements.push(
        <span key={key} className="line-through text-slate-400">
          {parseInlineFormatting(delContent)}
        </span>
      );
    } else if (redContent !== undefined) {
      elements.push(
        <span key={key} className="text-red-600 font-bold">
          {parseInlineFormatting(redContent)}
        </span>
      );
    } else if (blueContent !== undefined) {
      elements.push(
        <span key={key} className="text-blue-700 font-bold">
          {parseInlineFormatting(blueContent)}
        </span>
      );
    } else if (greenContent !== undefined) {
      elements.push(
        <span key={key} className="text-emerald-700 font-bold">
          {parseInlineFormatting(greenContent)}
        </span>
      );
    } else if (orangeContent !== undefined) {
      elements.push(
        <span key={key} className="text-amber-700 font-bold">
          {parseInlineFormatting(orangeContent)}
        </span>
      );
    } else if (purpleContent !== undefined) {
      elements.push(
        <span key={key} className="text-purple-700 font-bold">
          {parseInlineFormatting(purpleContent)}
        </span>
      );
    } else if (badgeContent !== undefined) {
      elements.push(
        <span key={key} className="inline-flex items-center px-2 py-0.5 rounded-md text-xs sm:text-sm font-bold bg-blue-100 text-blue-900 border border-blue-200 mx-1">
          {parseInlineFormatting(badgeContent)}
        </span>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < str.length) {
    elements.push(str.substring(lastIndex));
  }

  return elements;
}

function FormattedText({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;

  // Clean and normalize line breaks and non-breaking spaces
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;/gi, ' ');

  // Split by [box]...[/box] blocks first
  const boxPattern = /\[(box|passage|quote)\]([\s\S]*?)\[\/\1\]/gi;
  const blocks: { type: 'text' | 'box'; content: string }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boxPattern.exec(cleanText)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: cleanText.substring(lastIndex, match.index) });
    }
    blocks.push({ type: 'box', content: match[2] });
    lastIndex = boxPattern.lastIndex;
  }

  if (lastIndex < cleanText.length) {
    blocks.push({ type: 'text', content: cleanText.substring(lastIndex) });
  }

  return (
    <div className={`whitespace-pre-wrap break-words leading-relaxed font-sans ${className}`}>
      {blocks.map((block, blockIdx) => {
        if (block.type === 'box') {
          return (
            <div 
              key={`box-${blockIdx}`} 
              className="my-3.5 p-4 sm:p-5 rounded-2xl bg-amber-50/90 border-l-4 border-amber-500 border-y border-r border-amber-200 text-slate-800 shadow-xs whitespace-pre-wrap leading-relaxed text-left"
            >
              <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-800 mb-2 select-none">
                <BookOpen size={14} className="text-amber-600 shrink-0" />
                <span>บทความ / ข้อมูลประกอบคำถาม</span>
              </div>
              <div className="text-base text-slate-800 font-medium">
                {parseInlineFormatting(block.content)}
              </div>
            </div>
          );
        }

        const lines = block.content.split('\n');
        return (
          <span key={`text-block-${blockIdx}`}>
            {lines.map((line, idx) => {
              const isLast = idx === lines.length - 1;
              if (line.startsWith('> ')) {
                return (
                  <div key={idx} className="border-l-4 border-blue-500 bg-blue-50/70 px-4 py-2.5 my-2 rounded-r-xl text-slate-700 italic">
                    {parseInlineFormatting(line.slice(2))}
                  </div>
                );
              }
              if (line.startsWith('- ') || line.startsWith('• ')) {
                return (
                  <div key={idx} className="flex items-start gap-2 ml-2 my-1">
                    <span className="text-blue-600 font-bold select-none">•</span>
                    <span className="flex-1">{parseInlineFormatting(line.slice(2))}</span>
                  </div>
                );
              }
              return (
                <React.Fragment key={idx}>
                  {parseInlineFormatting(line)}
                  {!isLast && '\n'}
                </React.Fragment>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

// Reusable Question Input with integrated Formatting Toolbar and Live Preview
function FormattedQuestionTextarea({
  label = 'คำถาม',
  value,
  onChange,
  placeholder = 'พิมพ์คำถาม... เช่น อ่านบทความต่อไปนี้:\n[box]ข้อมูลสถานการณ์[/box]\nข้อใดคือความหมายของ ==คำสำคัญ==?',
  rows = 4,
  required = false
}: {
  label?: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showPreview, setShowPreview] = useState(false);

  const applyFormat = (prefix: string, suffix = '', placeholderText = '') => {
    const el = textareaRef.current;
    if (!el) {
      onChange((value || '') + prefix + placeholderText + suffix);
      return;
    }
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const currentVal = value || '';
    const selected = currentVal.substring(start, end);
    const textToWrap = selected || placeholderText;
    const replacement = prefix + textToWrap + suffix;
    const newVal = currentVal.substring(0, start) + replacement + currentVal.substring(end);
    onChange(newVal);

    setTimeout(() => {
      el.focus();
      const newCursorStart = start + prefix.length;
      const newCursorEnd = newCursorStart + textToWrap.length;
      el.setSelectionRange(newCursorStart, newCursorEnd);
    }, 15);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="block text-sm font-bold text-slate-800">
          {label} <span className="font-normal text-xs text-slate-500">(รองรับเว้นวรรคคำ ขึ้นบรรทัดใหม่ ไฮไลต์ ตัวหนา ตัวเอียง ขีดเส้นใต้ กล่องบทความ)</span>
        </label>
        {value && value.trim() ? (
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
              showPreview ? 'bg-blue-600 text-white shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-300'
            }`}
            title="ดูตัวอย่างการแสดงผลสำหรับนักเรียน"
          >
            <Eye size={13} /> {showPreview ? 'ซ่อนตัวอย่าง' : 'ดูตัวอย่างที่นักเรียนเห็น'}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 p-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-medium text-slate-700 shadow-2xs">
        <span className="text-[11px] text-slate-500 font-bold px-1 select-none flex items-center gap-1">
          <Highlighter size={13} className="text-amber-600" /> แถบจัดรูปแบบ:
        </span>
        <button
          type="button"
          onClick={() => applyFormat('==', '==', 'เน้นคำสำคัญ')}
          className="px-2.5 py-1 bg-amber-200 hover:bg-amber-300 text-amber-950 font-bold rounded-lg border border-amber-400 transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
          title="ไฮไลต์เน้นข้อความ (==ข้อความ==) คลุมข้อความแล้วกดได้เลย"
        >
          <span>🖍️ ไฮไลต์เน้นคำ</span>
        </button>
        <button
          type="button"
          onClick={() => applyFormat('**', '**', 'ข้อความตัวหนา')}
          className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 font-bold rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
          title="ตัวหนา (**ข้อความ**)"
        >
          <Bold size={12} /> หนา
        </button>
        <button
          type="button"
          onClick={() => applyFormat('*', '*', 'ข้อความตัวเอียง')}
          className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 italic rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
          title="ตัวเอียง (*ข้อความ*)"
        >
          <Italic size={12} /> เอียง
        </button>
        <button
          type="button"
          onClick={() => applyFormat('__', '__', 'ข้อความขีดเส้นใต้')}
          className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 underline decoration-blue-500 font-semibold rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
          title="ขีดเส้นใต้ (__ข้อความ__)"
        >
          <Underline size={12} /> ขีดเส้นใต้
        </button>
        <button
          type="button"
          onClick={() => applyFormat('[red]', '[/red]', 'ข้อความสีแดง')}
          className="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 font-bold rounded-lg border border-red-200 transition-colors cursor-pointer"
          title="ข้อความสีแดง ([red]ข้อความ[/red])"
        >
          🔴 แดง
        </button>
        <button
          type="button"
          onClick={() => applyFormat('[blue]', '[/blue]', 'ข้อความสีน้ำเงิน')}
          className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold rounded-lg border border-blue-200 transition-colors cursor-pointer"
          title="ข้อความสีน้ำเงิน ([blue]ข้อความ[/blue])"
        >
          🔵 น้ำเงิน
        </button>
        <button
          type="button"
          onClick={() => applyFormat('[green]', '[/green]', 'ข้อความสีเขียว')}
          className="px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold rounded-lg border border-emerald-200 transition-colors cursor-pointer"
          title="ข้อความสีเขียว ([green]ข้อความ[/green])"
        >
          🟢 เขียว
        </button>
        <button
          type="button"
          onClick={() => applyFormat('[box]\n', '\n[/box]', 'บทความหรือสถานการณ์ประกอบคำถาม')}
          className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 font-medium rounded-lg border border-amber-300 transition-colors cursor-pointer flex items-center gap-1"
          title="กล่องบทความ/สถานการณ์ ([box]...[/box])"
        >
          <BookOpen size={12} /> กล่องบทความ
        </button>
        <button
          type="button"
          onClick={() => applyFormat('\n', '', '')}
          className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-700 rounded-lg border border-slate-300 transition-colors cursor-pointer"
          title="ขึ้นบรรทัดใหม่"
        >
          ↵ ขึ้นบรรทัด
        </button>
        <button
          type="button"
          onClick={() => applyFormat('    ', '', '')}
          className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-700 rounded-lg border border-slate-300 transition-colors cursor-pointer"
          title="เว้นวรรค 4 เคาะ"
        >
          ⇥ เว้นวรรค 4 เคาะ
        </button>
      </div>

      <textarea
        ref={textareaRef}
        rows={rows}
        required={required}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-blue-200 p-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 whitespace-pre-wrap font-sans text-base leading-relaxed"
      />

      <div className="text-[11px] text-slate-500 italic">
        💡 สามารถกด Spacebar เพื่อเว้นวรรคหลายช่อง และกด Enter เพื่อขึ้นบรรทัดใหม่ได้ตามปกติ หรือคลุมข้อความแล้วกดปุ่มจัดรูปแบบด้านบน
      </div>

      {showPreview && value && (
        <div className="mt-2.5 p-4 rounded-xl bg-slate-50 border-2 border-blue-200 shadow-inner text-left animate-in fade-in duration-150">
          <div className="text-[11px] font-bold uppercase tracking-wider text-blue-700 mb-2 flex items-center gap-1.5">
            <Eye size={13} /> ตัวอย่างข้อสอบที่นักเรียนจะมองเห็นจริง (Live Preview):
          </div>
          <FormattedText text={value} className="text-base text-slate-800" />
        </div>
      )}
    </div>
  );
}

function FormattingToolbar({ 
  onInsert,
  previewText,
  textareaRef 
}: { 
  onInsert: (prefix: string, suffix?: string, placeholder?: string) => void;
  previewText?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [showPreview, setShowPreview] = useState(false);

  const handleToolbarClick = (prefix: string, suffix = '', placeholder = '') => {
    if (textareaRef && textareaRef.current) {
      const el = textareaRef.current;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const currentVal = el.value;
      const selected = currentVal.substring(start, end);
      const inserted = selected || placeholder;
      onInsert(prefix, suffix, inserted);
      
      setTimeout(() => {
        el.focus();
        el.setSelectionRange(start + prefix.length, start + prefix.length + inserted.length);
      }, 10);
    } else {
      onInsert(prefix, suffix, placeholder);
    }
  };

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center justify-between gap-1.5 p-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-medium text-slate-700 shadow-2xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500 font-bold px-1 select-none flex items-center gap-1">
            <Highlighter size={13} className="text-amber-600" /> จัดรูปแบบ:
          </span>
          <button
            type="button"
            onClick={() => handleToolbarClick('==', '==', 'เน้นคำสำคัญ')}
            className="px-2.5 py-1 bg-amber-100 hover:bg-amber-200 text-amber-950 font-bold rounded-lg border border-amber-300 transition-colors cursor-pointer flex items-center gap-1 shadow-2xs"
            title="ไฮไลต์เน้นข้อความ (==ข้อความ==)"
          >
            <span className="bg-amber-300 text-amber-950 px-1 rounded font-bold">🖍️ ไฮไลต์</span>
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('**', '**', 'ข้อความตัวหนา')}
            className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 font-bold rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
            title="ตัวหนา (**ข้อความ**)"
          >
            <Bold size={12} /> หนา
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('*', '*', 'ข้อความตัวเอียง')}
            className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 italic rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
            title="ตัวเอียง (*ข้อความ*)"
          >
            <Italic size={12} /> เอียง
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('__', '__', 'ข้อความขีดเส้นใต้')}
            className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-800 underline decoration-blue-500 font-semibold rounded-lg border border-slate-300 transition-colors cursor-pointer flex items-center gap-1"
            title="ขีดเส้นใต้ (__ข้อความ__)"
          >
            <Underline size={12} /> ขีดเส้นใต้
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('[red]', '[/red]', 'ข้อความสีแดง')}
            className="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 font-bold rounded-lg border border-red-200 transition-colors cursor-pointer"
            title="ข้อความสีแดง ([red]ข้อความ[/red])"
          >
            🔴 สีแดง
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('[blue]', '[/blue]', 'ข้อความสีน้ำเงิน')}
            className="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold rounded-lg border border-blue-200 transition-colors cursor-pointer"
            title="ข้อความสีน้ำเงิน ([blue]ข้อความ[/blue])"
          >
            🔵 สีน้ำเงิน
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('[box]\n', '\n[/box]', 'บทความหรือสถานการณ์ประกอบคำถาม')}
            className="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 font-medium rounded-lg border border-amber-300 transition-colors cursor-pointer flex items-center gap-1"
            title="กล่องบทความ/สถานการณ์ ([box]...[/box])"
          >
            <BookOpen size={12} /> กล่องบทความ
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('\n', '', '')}
            className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-700 rounded-lg border border-slate-300 transition-colors cursor-pointer"
            title="ขึ้นบรรทัดใหม่"
          >
            ↵ ขึ้นบรรทัด
          </button>
          <button
            type="button"
            onClick={() => handleToolbarClick('    ', '', '')}
            className="px-2 py-1 bg-white hover:bg-slate-50 text-slate-700 rounded-lg border border-slate-300 transition-colors cursor-pointer"
            title="เว้นวรรค 4 เคาะ"
          >
            ⇥ เว้นวรรค
          </button>
        </div>

        {previewText !== undefined && (
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1 transition-all cursor-pointer ${
              showPreview ? 'bg-blue-600 text-white shadow-xs' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-300'
            }`}
            title="ดูตัวอย่างการแสดงผลสำหรับนักเรียน"
          >
            <Eye size={12} /> {showPreview ? 'ซ่อนตัวอย่าง' : 'ดูตัวอย่าง'}
          </button>
        )}
      </div>

      {showPreview && previewText !== undefined && (
        <div className="mt-2 p-4 rounded-xl bg-slate-50 border-2 border-blue-200 shadow-inner text-left">
          <div className="text-[11px] font-bold uppercase tracking-wider text-blue-700 mb-2 flex items-center gap-1.5">
            <Eye size={13} /> ตัวอย่างข้อสอบที่นักเรียนจะมองเห็นจริง (Live Preview):
          </div>
          {previewText.trim() ? (
            <FormattedText text={previewText} className="text-base text-slate-800" />
          ) : (
            <span className="text-xs text-slate-400 italic">ยังไม่ได้พิมพ์ข้อความคำถาม</span>
          )}
        </div>
      )}
    </div>
  );
}

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

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false, error: null };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-100 font-sans p-4">
          <div className="bg-white p-8 rounded-3xl shadow-xl text-center max-w-md border border-red-200">
            <div className="w-16 h-16 mx-auto mb-4 bg-red-50 text-red-600 rounded-full flex items-center justify-center">
              <AlertCircle size={32} />
            </div>
            <h2 className="text-2xl font-bold text-slate-800 mb-2">เกิดข้อผิดพลาดในการแสดงผล</h2>
            <p className="text-slate-500 mb-6 text-sm">
              {this.state.error?.message || 'ระบบพบปัญหาชั่วคราวในการเปิดหน้าข้อสอบ'}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-md transition-all cursor-pointer"
            >
              รีเฟรชหน้าเว็บใหม่
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    return { 
      id: 'system_settings', 
      isOpen: true, 
      currentExamType: 'general', 
      examFormat: 'both',
      maxMcqCount: 0,
      maxSubjCount: 0,
      questionSelectionMode: 'random'
    };
  });

  // Auth State
  const [currentUser, setCurrentUser] = useState<Student | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentView, setCurrentView] = useState<'instructions' | 'login' | 'student-info' | 'exam' | 'result' | 'admin'>('instructions');
  // ชุดข้อสอบที่คัดเลือกมาให้นักเรียนทำในรอบนี้ (คงที่ตลอดการสอบ)
  const [activeExamQuestions, setActiveExamQuestions] = useState<{ mcqs: MCQ[]; subjs: Subjective[] } | null>(null);
  // เก็บผลการสอบครั้งที่เพิ่งส่งโดยตรง ป้องกันหน้าสรุปหยิบผลเก่าของนักเรียนคนเดิม
  const [currentSubmission, setCurrentSubmission] = useState<Submission | null>(null);
  const [submissionSyncStatus, setSubmissionSyncStatus] = useState<'synced' | 'local_only' | 'pending'>('pending');

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
  const addSubmission = async (sub: Submission): Promise<{ success: boolean; error?: string }> => {
    // 1. บันทึกผลสอบไว้ใน localStorage และ state ทันที
    setSubmissions(prev => {
      const exists = prev.some(p => p.id === sub.id);
      const newData = exists ? prev.map(p => p.id === sub.id ? sub : p) : [...prev, sub];
      localStorage.setItem('social_submissions', JSON.stringify(newData));
      return newData;
    });

    // 2. ส่งขึ้นฐานข้อมูลกลางแบบ Direct Write พร้อมระบบ retry
    const res = await saveSubmissionDirectly(sub);
    setSubmissionSyncStatus(res.success ? 'synced' : 'local_only');
    return res;
  };

  // ดักจับการกู้คืนเน็ต และพยายามส่งผลสอบที่ค้างส่งขึ้นคลาวด์อัตโนมัติ
  useEffect(() => {
    const syncOffline = async () => {
      const count = await flushPendingSubmissions();
      if (count > 0 && currentSubmission) {
        setSubmissionSyncStatus('synced');
      }
    };
    window.addEventListener('online', syncOffline);
    const interval = setInterval(syncOffline, 8000);
    return () => {
      window.removeEventListener('online', syncOffline);
      clearInterval(interval);
    };
  }, [currentSubmission]);

  const handleRetrySubmissionSync = async () => {
    if (!currentSubmission) return;
    setSubmissionSyncStatus('pending');
    const res = await saveSubmissionDirectly(currentSubmission);
    if (res.success) {
      setSubmissionSyncStatus('synced');
      alert('บันทึกและยืนยันผลสอบขึ้นสู่ฐานข้อมูลกลาง (Cloud Server) สำเร็จเรียบร้อยแล้ว!');
    } else {
      setSubmissionSyncStatus('local_only');
      alert('ยังไม่สามารถเชื่อมต่อฐานข้อมูลได้ในขณะนี้ (อาจเป็นเพราะสัญญาณเน็ตขัดข้อง) แต่ระบบได้บันทึกข้อสอบไว้ในเครื่องแล้ว ไม่สูญหายแน่นอนครับ');
    }
  };
  const saveSubmissions = (data: Submission[]) => {
    setSubmissions(data);
    localStorage.setItem('social_submissions', JSON.stringify(data));
    void upsertSharedItems('submissions', data).catch((error) =>
      showSyncError('ผลสอบ', error),
    );
  };

  const handleDeleteSubmission = async (submissionId: string): Promise<boolean> => {
    const ok = await deleteSubmissionDirectly(submissionId);
    const remaining = submissions.filter(s => s.id !== submissionId);
    setSubmissions(remaining);
    localStorage.setItem('social_submissions', JSON.stringify(remaining));
    return ok;
  };

  const handleDeleteMultipleSubmissions = async (submissionIds: string[]): Promise<boolean> => {
    const ok = await deleteSubmissionsBatch(submissionIds);
    const idSet = new Set(submissionIds);
    const remaining = submissions.filter(s => !idSet.has(s.id));
    setSubmissions(remaining);
    localStorage.setItem('social_submissions', JSON.stringify(remaining));
    return ok;
  };

  const handleClearAllSubmissions = async (): Promise<boolean> => {
    const ok = await clearAllSubmissionsDirectly();
    setSubmissions([]);
    localStorage.setItem('social_submissions', JSON.stringify([]));
    return ok;
  };

  const handleToggleArchiveSubmission = (submissionId: string) => {
    const updated = submissions.map(s => {
      if (s.id === submissionId) {
        const nextArchived = !s.isArchived;
        return {
          ...s,
          isArchived: nextArchived,
          archivedAt: nextArchived ? Date.now() : undefined
        };
      }
      return s;
    });
    setSubmissions(updated);
    localStorage.setItem('social_submissions', JSON.stringify(updated));
    void upsertSharedItems('submissions', updated).catch(error =>
      showSyncError('จัดเก็บผลสอบ', error),
    );
  };

  const handleBulkArchiveSubmissions = (submissionIds: string[], archiveStatus: boolean) => {
    const idSet = new Set(submissionIds);
    const updated = submissions.map(s => {
      if (idSet.has(s.id)) {
        return {
          ...s,
          isArchived: archiveStatus,
          archivedAt: archiveStatus ? Date.now() : undefined
        };
      }
      return s;
    });
    setSubmissions(updated);
    localStorage.setItem('social_submissions', JSON.stringify(updated));
    void upsertSharedItems('submissions', updated).catch(error =>
      showSyncError('จัดเก็บผลสอบ', error),
    );
  };

  const handleDownloadArchiveJSON = () => {
    const exportData = {
      title: 'คลังจัดเก็บข้อมูลผลการสอบนักเรียน โรงเรียนบ้านม่วงพิทยาคม',
      exportedAt: new Date().toISOString(),
      examType: settings.currentExamType,
      examFormat: settings.examFormat || 'both',
      totalCount: submissions.length,
      submissions: submissions
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `exam_archive_backup_${settings.currentExamType}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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

  const handleLogin = (id: string, pass: string): { success: boolean; isClosed?: boolean } => {
    if (id === 'TD43845' && pass === 'Natdanai43845') {
      setIsAdmin(true);
      setCurrentView('admin');
      return { success: true };
    }

    if (!settings.isOpen) {
      return { success: false, isClosed: true };
    }
    
    // Student login (ID == PASS)
    if (id === pass) {
      const student = students.find(s => s.id === id);
      if (student) {
        setCurrentUser(student);
        setIsAdmin(false);
        setCurrentView('student-info');
        return { success: true };
      }
    }
    return { success: false };
  };

  const handleLogout = () => {
    setCurrentSubmission(null);
    setCurrentUser(null);
    setIsAdmin(false);
    setCurrentView('login');
  };

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 text-slate-700 font-sans selection:bg-red-100 text-red-800 selection:text-slate-700">
        {!isAdmin && !settings.isOpen && (
          <div className="bg-gradient-to-r from-red-600 via-rose-600 to-red-700 text-white text-xs sm:text-sm font-bold py-2.5 px-4 text-center flex items-center justify-center gap-2 shadow-sm sticky top-0 z-50">
            <Lock size={16} className="shrink-0 animate-pulse" />
            <span>⛔ สถานะระบบสอบ: ระบบปิดอยู่ (คุณครูผู้คุมสอบยังไม่เปิดระบบให้นักเรียนเข้าทำข้อสอบ)</span>
          </div>
        )}
      {currentView === 'instructions' && (
        <InstructionView 
          isOpen={settings.isOpen} 
          onNext={() => setCurrentView('login')} 
        />
      )}
      {currentView === 'login' && (
        <LoginView 
          isOpen={settings.isOpen} 
          onLogin={handleLogin} 
        />
      )}
      {currentView === 'student-info' && currentUser && (() => {
        const eligibleMcqs = settings.examFormat === 'subj_only' ? [] : mcqs.filter(m => matchesExamType(m.examType, settings.currentExamType) && matchesClassGroup(m.classGroup, currentUser.class));
        const eligibleSubjs = settings.examFormat === 'mcq_only' ? [] : subjs.filter(s => matchesExamType(s.examType, settings.currentExamType) && matchesClassGroup(s.classGroup, currentUser.class));
        const mcqCountToTake = settings.maxMcqCount && settings.maxMcqCount > 0 ? Math.min(settings.maxMcqCount, eligibleMcqs.length) : eligibleMcqs.length;
        const subjCountToTake = settings.maxSubjCount && settings.maxSubjCount > 0 ? Math.min(settings.maxSubjCount, eligibleSubjs.length) : eligibleSubjs.length;

        return (
          <StudentInfoView 
            student={currentUser} 
            settings={settings}
            mcqCount={mcqCountToTake}
            subjCount={subjCountToTake}
            totalPoolMcqCount={eligibleMcqs.length}
            totalPoolSubjCount={eligibleSubjs.length}
            existingSubmission={submissions.find(s => s.studentId === currentUser.id && !s.isArchived)}
            onViewResult={(sub) => {
              setCurrentSubmission(sub);
              setCurrentView('result');
            }}
            onStart={(cls) => {
              setCurrentSubmission(null);
              const updatedUser = {...currentUser, class: cls};
              setCurrentUser(updatedUser);

              const poolMcqs = settings.examFormat === 'subj_only' ? [] : mcqs.filter(m => matchesExamType(m.examType, settings.currentExamType) && matchesClassGroup(m.classGroup, cls));
              const poolSubjs = settings.examFormat === 'mcq_only' ? [] : subjs.filter(s => matchesExamType(s.examType, settings.currentExamType) && matchesClassGroup(s.classGroup, cls));

              const chosenMcqs = selectExamQuestions(poolMcqs, settings.maxMcqCount, settings.questionSelectionMode || 'random');
              const chosenSubjs = selectExamQuestions(poolSubjs, settings.maxSubjCount, settings.questionSelectionMode || 'random');

              setActiveExamQuestions({ mcqs: chosenMcqs, subjs: chosenSubjs });
              setCurrentView('exam');
            }} 
            onLogout={handleLogout}
          />
        );
      })()}
      {currentView === 'exam' && currentUser && (() => {
        const poolMcqs = settings.examFormat === 'subj_only' ? [] : mcqs.filter(m => matchesExamType(m.examType, settings.currentExamType) && matchesClassGroup(m.classGroup, currentUser.class));
        const poolSubjs = settings.examFormat === 'mcq_only' ? [] : subjs.filter(s => matchesExamType(s.examType, settings.currentExamType) && matchesClassGroup(s.classGroup, currentUser.class));

        const examMcqs = activeExamQuestions ? activeExamQuestions.mcqs : selectExamQuestions(poolMcqs, settings.maxMcqCount, settings.questionSelectionMode || 'random');
        const examSubjs = activeExamQuestions ? activeExamQuestions.subjs : selectExamQuestions(poolSubjs, settings.maxSubjCount, settings.questionSelectionMode || 'random');

        return (
          <ExamView 
            student={currentUser}
            isOpen={settings.isOpen}
            mcqs={examMcqs}
            subjs={examSubjs}
            settings={settings}
            onFinish={async (sub) => {
              // ใช้ผลสอบครั้งนี้แสดงในหน้าสรุปทันที ไม่ค้นจากประวัติผลสอบทั้งหมด
              setCurrentSubmission(sub);
              const res = await addSubmission(sub);
              setCurrentView('result');
              return res.success;
            }}
          />
        );
      })()}
      {currentView === 'result' && currentUser && currentSubmission && (
        <ResultView 
          student={currentUser} 
          submission={currentSubmission}
          mcqs={mcqs}
          subjs={subjs}
          onLogout={handleLogout}
          syncStatus={submissionSyncStatus}
          onRetrySync={handleRetrySubmissionSync}
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
          onDeleteSubmission={handleDeleteSubmission}
          onDeleteMultipleSubmissions={handleDeleteMultipleSubmissions}
          onClearAllSubmissions={handleClearAllSubmissions}
          onToggleArchiveSubmission={handleToggleArchiveSubmission}
          onBulkArchiveSubmissions={handleBulkArchiveSubmissions}
          onDownloadArchiveJSON={handleDownloadArchiveJSON}
        />
      )}
      </div>
    </ErrorBoundary>
  );
}

// --- INSTRUCTION VIEW ---
function InstructionView({ isOpen = true, onNext }: { isOpen?: boolean; onNext: () => void }) {
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

        {/* System Closed Notice Banner */}
        {!isOpen && (
          <div className="mx-6 sm:mx-8 mt-6 p-4 rounded-2xl bg-amber-50 border-2 border-amber-300 text-amber-950 flex items-start gap-3.5 shadow-xs">
            <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-xs mt-0.5">
              <Lock size={20} />
            </div>
            <div className="text-left text-xs sm:text-sm">
              <span className="font-bold text-amber-950 block text-base">⛔ ขณะนี้ระบบสอบปิดให้บริการอยู่ (ระบบปิด)</span>
              <span className="text-amber-800 leading-relaxed block mt-0.5">
                คุณครูผู้คุมสอบยังไม่เปิดระบบให้นักเรียนเข้าทำข้อสอบ กรุณารอคุณครูแจ้งเปิดระบบสอบ
              </span>
            </div>
          </div>
        )}
        
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
              <strong>ห้ามสลับหน้าจอหรือออกจากการสอบเด็ดขาด:</strong> ระบบข้อสอบมีการติดตั้งระบบตรวจจับพฤติกรรม (Tab Switching Detection) หากนักเรียนพยายามปัดหน้าจอ พับหน้าจอ เปิดแท็บใหม่ หรือสลับไปใช้แอปพลิเคชันอื่น ระบบจะแจ้งเตือนและบันทึกพฤติกรรมการทุจริตทันที <span className="font-bold underline text-red-600">หากฝ่าฝืนเกิน 4 ครั้ง ระบบจะปรับตกและให้ 0 คะแนนทันที</span>
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
function LoginView({ 
  isOpen = true,
  onLogin 
}: { 
  isOpen?: boolean;
  onLogin: (id: string, p: string) => { success: boolean; isClosed?: boolean } | boolean;
}) {
  const [id, setId] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // If student attempts to log in while closed
    if (!isOpen && id.trim() !== 'TD43845') {
      setError('⛔ ขณะนี้ระบบสอบปิดให้บริการอยู่ ไม่สามารถเข้าสอบได้ กรุณารอคุณครูผู้คุมสอบเปิดระบบ');
      return;
    }

    const res = onLogin(id, pass);
    if (typeof res === 'object') {
      if (!res.success) {
        if (res.isClosed) {
          setError('⛔ ขณะนี้ระบบสอบปิดให้บริการอยู่ ไม่สามารถเข้าสอบได้ กรุณารอคุณครูผู้คุมสอบเปิดระบบ');
        } else {
          setError('รหัสนักเรียนหรือรหัสผ่านไม่ถูกต้อง');
        }
      }
    } else if (!res) {
      setError(!isOpen ? '⛔ ขณะนี้ระบบสอบปิดให้บริการอยู่ ไม่สามารถเข้าสอบได้ กรุณารอคุณครูผู้คุมสอบเปิดระบบ' : 'รหัสนักเรียนหรือรหัสผ่านไม่ถูกต้อง');
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

        <div className="p-8 space-y-5">
          {/* Closed Status Banner */}
          {!isOpen && (
            <div className="bg-amber-50 border-2 border-amber-300 text-amber-950 rounded-2xl p-4 flex items-start gap-3 text-left shadow-xs">
              <div className="w-9 h-9 bg-amber-500 text-white rounded-xl flex items-center justify-center shrink-0 shadow-sm mt-0.5">
                <Lock size={18} />
              </div>
              <div className="text-xs">
                <div className="font-bold text-amber-900 text-sm">⛔ ขณะนี้ระบบสอบปิดอยู่ (ระบบปิด)</div>
                <div className="text-amber-800 mt-0.5 leading-relaxed">
                  ยังไม่เปิดให้นักเรียนเข้าทำข้อสอบ กรุณารอคุณครูผู้คุมสอบเปิดระบบ
                </div>
                <div className="text-[11px] text-amber-700/80 mt-1">
                  * สำหรับคุณครูผู้สอน สามารถกรอกรหัสผู้ดูแลเพื่อเปิดระบบสอบได้ตามปกติ
                </div>
              </div>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
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
              <div className="bg-red-50 text-red-700 p-3.5 rounded-xl text-xs sm:text-sm flex items-start gap-2.5 border border-red-200 leading-relaxed animate-in fade-in duration-150">
                <AlertCircle size={18} className="shrink-0 text-red-600 mt-0.5"/>
                <p className="font-medium">{error}</p>
              </div>
            )}
            
            <button 
              type="submit" 
              className={`w-full py-4 mt-6 rounded-xl font-bold text-lg shadow-md transition-all cursor-pointer ${
                !isOpen 
                  ? 'bg-amber-600 hover:bg-amber-700 text-white shadow-amber-200' 
                  : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200 hover:shadow-lg'
              }`}
            >
              {!isOpen ? 'เข้าสู่ระบบ (ระบบสอบปิดอยู่)' : 'เข้าสู่ระบบ'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// --- STUDENT INFO VIEW ---
function StudentInfoView({ 
  student, 
  settings, 
  mcqCount = 0, 
  subjCount = 0, 
  totalPoolMcqCount = 0,
  totalPoolSubjCount = 0,
  existingSubmission,
  onViewResult,
  onStart, 
  onLogout 
}: { 
  student: Student; 
  settings?: Settings; 
  mcqCount?: number; 
  subjCount?: number; 
  totalPoolMcqCount?: number;
  totalPoolSubjCount?: number;
  existingSubmission?: Submission | null;
  onViewResult?: (sub: Submission) => void;
  onStart: (cls: string) => void; 
  onLogout: () => void; 
}) {
  const cleanClass = (student.class || '6/3').trim().replace(/^ม\.?\s*/, '');
  const [selectedClass, setSelectedClass] = useState(cleanClass || '6/3');
  const availableClasses = Array.from(new Set(['6/3', '6/8', cleanClass].filter(Boolean)));

  const formatText = settings?.examFormat === 'mcq_only' 
    ? 'เฉพาะข้อสอบปรนัย (ช้อยส์ ก ข ค ง จ)' 
    : settings?.examFormat === 'subj_only' 
      ? 'เฉพาะข้อสอบอัตนัย (ข้อเขียนตอบบรรยาย)' 
      : 'ข้อสอบ 2 ตอน (ตอนที่ 1 ปรนัย + ตอนที่ 2 อัตนัย)';

  const examTypeName = settings?.currentExamType === 'midterm' 
    ? 'การสอบวัดผลกลางภาค (Midterm)' 
    : settings?.currentExamType === 'final' 
      ? 'การสอบวัดผลปลายภาค (Final)' 
      : 'การสอบวัดผลทั่วไป (General Exam)';

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
          <button onClick={onLogout} className="text-blue-100 hover:text-white p-2 flex items-center gap-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors cursor-pointer">
            <LogOut size={18} /> ออกจากระบบ
          </button>
        </div>

        <div className="p-8">
          <div className="space-y-4 mb-6 bg-blue-50/50 p-6 rounded-2xl border border-blue-100 shadow-inner">
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

          {/* Exam Summary Box */}
          <div className="mb-6 p-5 rounded-2xl bg-slate-50 border border-slate-200 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-blue-700 bg-blue-100 px-3 py-1 rounded-full">
                {examTypeName}
              </span>
              <span className="text-xs font-bold text-slate-500">
                เวลาสอบ 60 นาที
              </span>
            </div>
            <div className="text-slate-800 font-bold text-base mb-1">
              รูปแบบการสอบ: <span className="text-blue-900">{formatText}</span>
            </div>
            <div className="text-sm text-slate-500 flex flex-wrap gap-2 mt-2">
              {(settings?.examFormat !== 'subj_only') && (
                <span className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg font-medium text-slate-700 text-xs flex items-center gap-1.5 shadow-2xs">
                  <span>📝 ปรนัย:</span>
                  <span className="font-bold text-blue-900">{mcqCount > 0 ? `${mcqCount} ข้อ` : 'ไม่มีข้อสอบปรนัย'}</span>
                  {totalPoolMcqCount > mcqCount && mcqCount > 0 && (
                    <span className="text-[11px] text-slate-500 font-normal">(คัดเลือกจากคลัง {totalPoolMcqCount} ข้อ)</span>
                  )}
                </span>
              )}
              {(settings?.examFormat !== 'mcq_only') && (
                <span className="bg-white border border-slate-200 px-3 py-1.5 rounded-lg font-medium text-slate-700 text-xs flex items-center gap-1.5 shadow-2xs">
                  <span>✍️ อัตนัย:</span>
                  <span className="font-bold text-blue-900">{subjCount > 0 ? `${subjCount} ข้อ` : 'ไม่มีข้อสอบอัตนัย'}</span>
                  {totalPoolSubjCount > subjCount && subjCount > 0 && (
                    <span className="text-[11px] text-slate-500 font-normal">(คัดเลือกจากคลัง {totalPoolSubjCount} ข้อ)</span>
                  )}
                </span>
              )}
            </div>
          </div>

          {existingSubmission ? (
            /* Student has already submitted this exam */
            <div className="bg-emerald-50 border-2 border-emerald-400 rounded-3xl p-6 shadow-sm mb-4 text-center animate-in fade-in duration-200">
              <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-3 shadow-inner">
                <CheckCircle2 size={36} />
              </div>
              <h3 className="text-xl font-bold text-emerald-900 mb-1">ท่านได้ส่งข้อสอบชุดนี้เข้าสู่ระบบแล้ว</h3>
              <p className="text-slate-600 text-xs mb-3">
                วันที่ส่ง: <span className="font-semibold text-slate-800">{new Date(existingSubmission.submittedAt).toLocaleString('th-TH')}</span>
              </p>
              
              {existingSubmission.confirmationCode && (
                <div className="inline-block bg-white border border-emerald-300 rounded-xl px-4 py-2 font-mono text-sm font-bold text-blue-800 shadow-xs mb-4">
                  รหัสยืนยัน: {existingSubmission.confirmationCode}
                </div>
              )}

              <div className="bg-white/90 p-4 rounded-2xl border border-emerald-200 text-xs text-slate-700 mb-5 text-left space-y-1.5 shadow-2xs">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">คะแนนปรนัย:</span>
                  <span className="font-bold text-emerald-700 text-sm">{existingSubmission.mcqScore} คะแนน</span>
                </div>
                {Object.keys(existingSubmission.subjScores || {}).length > 0 && (
                  <div className="flex justify-between items-center">
                    <span className="text-slate-500">คะแนนอัตนัย (ครูตรวจแล้ว):</span>
                    <span className="font-bold text-blue-700 text-sm">
                      {Object.values(existingSubmission.subjScores).reduce((a: number, b: number) => a + b, 0)} คะแนน
                    </span>
                  </div>
                )}
                <div className="pt-2 border-t border-slate-100 text-[11px] text-amber-800 flex items-center gap-1.5">
                  <AlertCircle size={14} className="shrink-0 text-amber-600" />
                  <span>หากต้องการเข้าสอบใหม่ กรุณาติดต่อคุณครูเพื่อลบข้อมูลผลสอบเดิมของท่านในระบบ</span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  type="button"
                  onClick={() => onViewResult && onViewResult(existingSubmission)}
                  className="flex-1 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl shadow-md shadow-emerald-200 hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <FileCheck size={18} /> ดูผลคะแนนและใบยืนยันการส่ง
                </button>
                <button
                  type="button"
                  onClick={onLogout}
                  className="px-6 py-3.5 border-2 border-slate-300 text-slate-700 font-bold rounded-xl hover:bg-slate-50 transition-all cursor-pointer"
                >
                  ออกจากระบบ
                </button>
              </div>
            </div>
          ) : (
            /* Student has NOT submitted or submission was cleared/deleted -> can start */
            <>
              <div className="mb-8">
                <label className="block text-sm font-bold text-slate-700 mb-3">
                  โปรดยืนยันห้องเรียนของท่านเพื่อรับชุดข้อสอบให้ถูกต้อง:
                </label>
                <div className="flex flex-wrap gap-4">
                  {availableClasses.map(cls => (
                    <label key={cls} className={`flex-1 min-w-[120px] p-4 rounded-2xl border-2 cursor-pointer flex items-center justify-center gap-3 transition-all ${selectedClass === cls ? 'border-blue-600 bg-blue-50 text-blue-900 shadow-md scale-[1.02]' : 'border-slate-200 hover:bg-slate-50 text-slate-600 hover:border-blue-300'}`}>
                      <input type="radio" name="class" value={cls} checked={selectedClass === cls} onChange={() => setSelectedClass(cls)} className="hidden" />
                      <CheckCircle2 size={24} className={selectedClass === cls ? 'opacity-100 text-blue-600' : 'opacity-20'} />
                      <span className="font-bold text-lg">ม.{cls}</span>
                    </label>
                  ))}
                </div>
              </div>

              {!settings?.isOpen && (
                <div className="mb-6 p-4 rounded-2xl bg-amber-50 border-2 border-amber-400 text-amber-950 flex items-start gap-3.5 shadow-sm">
                  <div className="w-10 h-10 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-xs mt-0.5">
                    <Lock size={20} />
                  </div>
                  <div className="text-left text-xs sm:text-sm">
                    <span className="font-bold text-amber-950 block text-base">⛔ ขณะนี้ระบบสอบปิดให้บริการอยู่ (ระบบปิด)</span>
                    <span className="text-amber-800 leading-relaxed block mt-0.5">
                      คุณครูผู้คุมสอบยังไม่เปิดระบบสอบให้นักเรียนเข้าทำข้อสอบ หรือปิดระบบสอบชั่วคราว จึงยังไม่สามารถเริ่มทำข้อสอบได้ในขณะนี้ กรุณารอคุณครูแจ้งเปิดระบบสอบ
                    </span>
                  </div>
                </div>
              )}

              <div className="bg-red-50 p-5 rounded-2xl border-l-4 border-red-500 shadow-sm mb-8 text-sm text-red-800 flex gap-3 items-start">
                <ShieldAlert size={24} className="shrink-0 mt-0.5 text-red-600" />
                <p><strong>คำเตือน:</strong> หากเริ่มทำข้อสอบแล้ว ห้ามย่อหน้าต่าง เปลี่ยนแท็บ หรือเปิดโปรแกรมอื่นเด็ดขาด หากระบบตรวจพบการละเมิดเกิน 4 ครั้ง จะถือว่าทุจริตและปรับคะแนนเป็น 0 ทันที</p>
              </div>

              <button 
                type="button"
                disabled={!settings?.isOpen}
                onClick={() => settings?.isOpen && onStart(selectedClass)}
                className={`w-full py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-md transition-all ${
                  !settings?.isOpen 
                    ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none'
                    : 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-200 hover:shadow-lg cursor-pointer'
                }`}
              >
                {!settings?.isOpen ? (
                  <>
                    <Lock size={20} /> ระบบสอบปิดอยู่ (ไม่สามารถเริ่มทำข้อสอบได้)
                  </>
                ) : (
                  <>
                    เริ่มทำข้อสอบ <ChevronRight />
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --- EXAM VIEW ---
function ExamView({ 
  student, 
  isOpen = true,
  mcqs, 
  subjs, 
  settings,
  onFinish 
}: { 
  student: Student; 
  isOpen?: boolean;
  mcqs: MCQ[]; 
  subjs: Subjective[]; 
  settings?: Settings;
  onFinish: (s: Submission) => Promise<boolean> | void;
}) {
  const TIME_LIMIT = 60 * 60; // 60 minutes
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT);
  const [cheatCount, setCheatCount] = useState(0);
  const [isTerminated, setIsTerminated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const startTime = useRef(Date.now());
  const lastCheatTime = useRef<number>(0);
  const MAX_VIOLATIONS = 4; // แจ้งเตือนได้สูงสุด 4 ครั้ง ก่อนระบบตัดสิทธิ์ในครั้งที่ 5

  // Randomized Exam State
  const [shuffledMcqs, setShuffledMcqs] = useState<any[]>([]);
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, string>>({});
  const [subjAnswers, setSubjAnswers] = useState<Record<string, string>>({});
  
  const [currentType, setCurrentType] = useState<'mcq' | 'subj'>(mcqs.length === 0 ? 'subj' : 'mcq');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showGrid, setShowGrid] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const hasMcqs = (mcqs && mcqs.length > 0) || shuffledMcqs.length > 0;
  const hasSubjs = subjs && subjs.length > 0;
  const isBoth = hasMcqs && hasSubjs;

  // Force Submit Function
  const forceSubmit = async (finalCheatCount: number) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    let score = 0;
    
    // Check MCQ Score
    shuffledMcqs.forEach(m => {
      if (mcqAnswers[m.id] === m.originalCorrectText) score++;
    });

    const now = Date.now();
    const randSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const confCode = `CONF-${(student.class || 'ALL').replace('/', '')}-${student.id}-${now.toString(36).slice(-4).toUpperCase()}`;

    const sub: Submission = {
      id: `sub_${student.id}_${now}_${randSuffix}`,
      confirmationCode: confCode,
      studentId: student.id,
      studentName: student.name,
      studentClass: student.class,
      studentNumber: student.number,
      classGroup: student.class,
      mcqAnswers,
      subjAnswers,
      mcqScore: finalCheatCount > MAX_VIOLATIONS ? 0 : score, // 0 if terminated
      timeTakenMs: now - startTime.current,
      cheatCount: finalCheatCount,
      submittedAt: now,
      subjScores: {}, // Admin will grade this
      totalMcqCount: shuffledMcqs.length,
      totalSubjCount: subjs.length,
      assignedMcqIds: shuffledMcqs.map(m => m.id),
      assignedSubjIds: subjs.map(s => s.id)
    };

    try {
      await onFinish(sub);
    } catch (e) {
      console.error("Submission error:", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Initialize and Shuffle
  useEffect(() => {
    if (shuffledMcqs.length > 0) return; // Prevent re-shuffling if already initialized
    const validMcqs = (mcqs || []).filter(q => q && q.text && Array.isArray(q.options) && q.options.length > 0);
    
    // 1. Question ordering: preserve order if questionSelectionMode is 'order'
    const isOrderMode = settings?.questionSelectionMode === 'order';
    const baseMcqs = isOrderMode ? validMcqs : shuffleArray(validMcqs);

    const randMcqs = baseMcqs.map(q => {
      // 2. Options shuffling
      const opts = Array.isArray(q.options) ? q.options : [];
      const correctIdx = typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex < opts.length ? q.correctIndex : 0;
      const origCorrectText = opts[correctIdx] || opts[0] || '';
      const randOptions = isOrderMode ? [...opts] : shuffleArray(opts);
      return {
        ...q,
        options: opts,
        shuffledOptions: randOptions,
        originalCorrectText: origCorrectText
      };
    });
    setShuffledMcqs(randMcqs);
    if (randMcqs.length === 0 && subjs.length > 0) {
      setCurrentType('subj');
      setCurrentIndex(0);
    } else if (randMcqs.length > 0) {
      setCurrentType('mcq');
      setCurrentIndex(0);
    }
  }, [mcqs, subjs, settings?.questionSelectionMode]);

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
      if (cheatCount > MAX_VIOLATIONS) {
        setIsTerminated(true);
        setTimeout(() => {
          alert(`คุณละเมิดกฎการสอบ (เปลี่ยนหน้าจอ/ย่อหน้าต่าง/เปิดแท็บใหม่) ครั้งที่ ${cheatCount} ซึ่งเกินจำนวนที่กำหนด (${MAX_VIOLATIONS} ครั้ง)\nระบบทำการยุติการสอบและส่งข้อสอบอัตโนมัติ (ปรับคะแนนเป็น 0)`);
          void forceSubmit(cheatCount);
        }, 100);
      } else if (cheatCount === MAX_VIOLATIONS) {
        setTimeout(() => {
          alert(`คำเตือนครั้งสุดท้าย! (ครั้งที่ ${cheatCount}/${MAX_VIOLATIONS})\nห้ามเปลี่ยนหน้าจอ ย่อหน้าต่าง หรือเปิดแท็บใหม่เด็ดขาด! หากตรวจพบอีกเป็นครั้งที่ ${MAX_VIOLATIONS + 1} ระบบจะยุติการสอบและปรับตก 0 คะแนนทันที`);
        }, 100);
      } else {
        setTimeout(() => {
          alert(`คำเตือน! ห้ามเปลี่ยนหน้าจอ ย่อหน้าต่าง หรือเปิดแท็บใหม่ (ครั้งที่ ${cheatCount}/${MAX_VIOLATIONS})\nระบบได้บันทึกพฤติกรรมนี้ไว้`);
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
        {!isOpen && (
          <div className="mb-6 p-4 rounded-2xl bg-red-600 text-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                <Lock size={22} className="text-white" />
              </div>
              <div className="text-left text-xs sm:text-sm">
                <span className="font-bold text-white block text-sm sm:text-base">⛔ คุณครูได้ปิดระบบสอบแล้ว (ระบบปิดอยู่)</span>
                <span className="text-red-100 block text-xs mt-0.5 leading-relaxed">
                  ขณะนี้ระบบสอบถูกปิดแล้ว กรุณาตรวจสอบคำตอบที่ทำไว้และกดปุ่ม "ส่งข้อสอบ" เพื่อส่งคะแนนของคุณเข้าสู่ระบบทันที
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              className="px-4 py-2.5 bg-white hover:bg-red-50 text-red-700 font-bold rounded-xl text-xs sm:text-sm shadow transition-all shrink-0 cursor-pointer"
            >
              ส่งข้อสอบทันที
            </button>
          </div>
        )}

        {/* Header */}
        <div className="bg-white rounded-2xl shadow-md border border-slate-200 p-5 flex flex-wrap justify-between items-center gap-4 mb-6 sticky top-4 z-40">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center font-bold text-xl shadow-inner border border-blue-100 shrink-0">
              {student.class}
            </div>
            <div>
              <div className="font-bold text-slate-800 text-lg">เลขที่ {student.number}</div>
              <div className="text-sm text-slate-500">{student.name}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            {cheatCount > 0 && (
              <div className="flex items-center gap-1.5 text-xs font-bold text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded-xl animate-pulse">
                <ShieldAlert size={16} /> สลับจอ {cheatCount}/{MAX_VIOLATIONS}
              </div>
            )}
            <button onClick={() => setShowGrid(!showGrid)} className={`flex items-center gap-2 text-sm font-bold px-4 py-2.5 rounded-xl transition-all shadow-sm cursor-pointer ${showGrid ? 'bg-slate-800 text-white shadow-slate-300' : 'bg-slate-50 border border-slate-200 text-slate-600 hover:bg-slate-100'}`}>
              <CheckSquare size={18} /> ดูสถานะข้อสอบ (Recheck)
            </button>
            <div className={`flex items-center gap-2 font-mono text-xl font-bold bg-slate-50 px-4 py-2.5 rounded-xl border ${timeLeft < 300 ? 'text-red-600 border-red-200 bg-red-50' : 'text-slate-700 border-slate-200'}`}>
              <Clock size={22} className={timeLeft < 300 ? 'animate-pulse' : ''} />
              {mins.toString().padStart(2, '0')}:{secs.toString().padStart(2, '0')}
            </div>
          </div>
        </div>

        {showGrid && (
          <div className="bg-white p-8 rounded-3xl shadow-lg border border-slate-200 mb-6 relative overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <CheckSquare size={100} />
            </div>
            {shuffledMcqs.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-bold text-lg text-slate-800 border-l-4 border-blue-600 pl-3">
                    {isBoth ? 'ตอนที่ 1: ปรนัย (เลือกตอบ)' : 'ข้อสอบปรนัย (เลือกตอบ)'}
                  </h4>
                  <span className="text-sm font-medium text-slate-500">
                    ตอบแล้ว {Object.keys(mcqAnswers).length} / {shuffledMcqs.length} ข้อ
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 relative z-10">
                  {shuffledMcqs.map((q, i) => (
                    <button key={q.id} onClick={() => { setCurrentType('mcq'); setCurrentIndex(i); setShowGrid(false); }}
                      className={`w-12 h-12 flex items-center justify-center rounded-xl border-2 text-base font-bold transition-all shadow-sm cursor-pointer ${mcqAnswers[q.id] ? 'bg-blue-600 text-white border-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}`}>
                      {i+1}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {subjs.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-bold text-lg text-slate-800 border-l-4 border-blue-600 pl-3 relative z-10">
                    {isBoth ? 'ตอนที่ 2: อัตนัย (เขียนตอบ)' : 'ข้อสอบอัตนัย (เขียนตอบ)'}
                  </h4>
                  <span className="text-sm font-medium text-slate-500">
                    ตอบแล้ว {Object.values(subjAnswers).filter(v => v && v.trim()).length} / {subjs.length} ข้อ
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 relative z-10">
                  {subjs.map((q, i) => (
                    <button key={q.id} onClick={() => { setCurrentType('subj'); setCurrentIndex(i); setShowGrid(false); }}
                      className={`w-12 h-12 flex items-center justify-center rounded-xl border-2 text-base font-bold transition-all shadow-sm cursor-pointer ${subjAnswers[q.id]?.trim() ? 'bg-blue-600 text-white border-blue-700' : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}`}>
                      {i+1}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Main Content */}
        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 p-8 min-h-[500px] flex flex-col">
          {currentType === 'mcq' && shuffledMcqs[currentIndex] ? (
            <>
              <div className="inline-block bg-blue-50 text-blue-700 px-3.5 py-1.5 rounded-lg text-sm font-bold mb-6 w-max border border-blue-100">
                {isBoth 
                  ? `ตอนที่ 1: ปรนัย (ข้อ ${currentIndex + 1} / ${shuffledMcqs.length})` 
                  : `ข้อสอบปรนัย (ข้อ ${currentIndex + 1} / ${shuffledMcqs.length})`}
              </div>
              <div className="text-2xl font-medium text-slate-800 mb-8 leading-relaxed flex items-start gap-2.5">
                <span className="font-bold text-blue-900 shrink-0 select-none">{currentIndex + 1}.</span>
                <div className="flex-1">
                  <FormattedText text={shuffledMcqs[currentIndex].text} className="text-2xl font-medium text-slate-800" />
                </div>
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
                      <div className="flex-1 text-slate-700 text-lg">
                        <FormattedText text={opt} />
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        ) : currentType === 'subj' && subjs[currentIndex] ? (
          <>
            <div className="inline-block bg-blue-50 text-blue-700 px-3.5 py-1.5 rounded-lg text-sm font-bold mb-6 w-max border border-blue-100">
              {isBoth 
                ? `ตอนที่ 2: อัตนัย (ข้อ ${currentIndex + 1} / ${subjs.length})` 
                : `ข้อสอบอัตนัย (ข้อ ${currentIndex + 1} / ${subjs.length})`}
            </div>
            <div className="text-2xl font-medium text-slate-800 mb-8 leading-relaxed flex items-start gap-2.5">
              <span className="font-bold text-blue-900 shrink-0 select-none">{currentIndex + 1}.</span>
              <div className="flex-1">
                <FormattedText text={subjs[currentIndex].text} className="text-2xl font-medium text-slate-800" />
              </div>
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
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3 py-12">
            <AlertCircle size={36} />
            <p className="font-bold">ไม่พบข้อสอบในหมวดนี้</p>
          </div>
        )}

        {/* Footer Navigation */}
        <div className="flex justify-between items-center mt-8 pt-6 border-t-2 border-slate-100">
          <button 
            onClick={() => {
              if (currentIndex > 0) setCurrentIndex(currentIndex - 1);
              else if (currentType === 'subj' && hasMcqs) { setCurrentType('mcq'); setCurrentIndex(shuffledMcqs.length - 1); }
            }}
            disabled={(currentType === 'mcq' && currentIndex === 0) || (currentType === 'subj' && currentIndex === 0 && !hasMcqs)}
            className="px-6 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-bold hover:bg-slate-50 disabled:opacity-40 transition-all hover:border-slate-300 cursor-pointer disabled:cursor-not-allowed"
          >
            ก่อนหน้า
          </button>
          
          <div className="flex gap-2 hidden md:flex">
            {shuffledMcqs.length > 0 && (
              <button 
                onClick={() => { setCurrentType('mcq'); setCurrentIndex(0); }}
                className={`w-3 h-3 rounded-full transition-all cursor-pointer ${currentType === 'mcq' ? 'bg-blue-600 w-6' : 'bg-slate-300'}`}
              />
            )}
            {subjs.length > 0 && (
              <button 
                onClick={() => { setCurrentType('subj'); setCurrentIndex(0); }}
                className={`w-3 h-3 rounded-full transition-all cursor-pointer ${currentType === 'subj' ? 'bg-blue-600 w-6' : 'bg-slate-300'}`}
              />
            )}
          </div>

          {(currentType === 'mcq' && currentIndex === shuffledMcqs.length - 1) ? (
            subjs.length > 0 ? (
              <button 
                onClick={() => { setCurrentType('subj'); setCurrentIndex(0); }}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-md hover:bg-blue-700 hover:shadow-lg transition-all cursor-pointer"
              >
                ถัดไป (อัตนัย)
              </button>
            ) : (
              <button 
                onClick={handleSubmit}
                className="px-6 py-3 bg-red-600 text-white rounded-xl font-bold shadow-md hover:bg-red-700 hover:shadow-lg transition-all flex items-center gap-2 cursor-pointer"
              >
                <CheckCircle2 size={20} /> ส่งข้อสอบ
              </button>
            )
          ) : (currentType === 'subj' && currentIndex === subjs.length - 1) ? (
            <button 
              onClick={handleSubmit}
              className="px-6 py-3 bg-red-600 text-white rounded-xl font-bold shadow-md hover:bg-red-700 hover:shadow-lg transition-all flex items-center gap-2 cursor-pointer"
            >
              <CheckCircle2 size={20} /> ส่งข้อสอบ
            </button>
          ) : (
            <button 
              onClick={() => setCurrentIndex(currentIndex + 1)}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-md hover:bg-blue-700 hover:shadow-lg transition-all cursor-pointer"
            >
              ถัดไป
            </button>
          )}
        </div>
      </div>
      {/* Submitting Loading Overlay - Prevents double submit and clarifies status */}
      {isSubmitting && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md text-center shadow-2xl border border-blue-200 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner animate-pulse">
              <Loader2 size={40} className="animate-spin text-blue-600" />
            </div>
            <h3 className="text-2xl font-bold mb-2 text-slate-800">กำลังส่งข้อสอบเข้าสู่ระบบ</h3>
            <p className="text-slate-600 font-medium mb-4">
              ระบบกำลังเข้ารหัสคำตอบและเชื่อมต่อไปยังฐานข้อมูลกลาง (Cloud Server)...
            </p>
            <div className="bg-amber-50 text-amber-800 p-3 rounded-xl text-sm border border-amber-200">
              ⚠️ กรุณารอสักครู่ อย่าเพิ่งปิดหน้าต่างหรือรีเฟรชหน้าจอ
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmSubmit && !isSubmitting && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-3xl p-8 w-full max-w-md text-center shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
              <CheckSquare size={40} />
            </div>
            <h3 className="text-2xl font-bold mb-2 text-slate-800">ยืนยันการส่งข้อสอบ</h3>
            <p className="mb-6 text-slate-600 font-medium text-base">
              คุณต้องการส่งข้อสอบใช่หรือไม่?<br/>
              <span className="text-slate-500 text-xs block mt-2">
                {shuffledMcqs.length > 0 && `ปรนัยตอบแล้ว ${Object.keys(mcqAnswers).length}/${shuffledMcqs.length} ข้อ `}
                {subjs.length > 0 && `อัตนัยตอบแล้ว ${Object.values(subjAnswers).filter(v => v && v.trim()).length}/${subjs.length} ข้อ`}
              </span>
              <span className="text-red-500 text-sm mt-3 block font-bold">เมื่อส่งแล้วจะไม่สามารถกลับมาแก้ไขได้อีก</span>
            </p>
            <div className="flex justify-center gap-4">
              <button onClick={() => setConfirmSubmit(false)} className="flex-1 py-3 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all hover:border-slate-300 cursor-pointer">
                กลับไปตรวจทาน
              </button>
              <button 
                onClick={() => {
                  setConfirmSubmit(false);
                  void forceSubmit(cheatCount);
                }} 
                className="flex-1 py-3 bg-red-600 text-white font-bold rounded-xl shadow-md hover:bg-red-700 hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
              >
                <CheckCircle2 size={20} /> ยืนยันส่งจริง
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
function ResultView({ 
  student, 
  submission, 
  mcqs, 
  subjs, 
  onLogout,
  syncStatus,
  onRetrySync
}: { 
  student: Student; 
  submission: Submission; 
  mcqs: MCQ[]; 
  subjs: Subjective[]; 
  onLogout: () => void;
  syncStatus?: 'pending' | 'synced' | 'local_only';
  onRetrySync?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const mins = Math.floor(submission.timeTakenMs / 60000);
  const secs = Math.floor((submission.timeTakenMs % 60000) / 1000);

  const receiptCode = submission.confirmationCode || `CONF-${(student.class || 'ALL').replace('/', '')}-${student.id}-${submission.id.slice(-6).toUpperCase()}`;

  const handleCopyCode = () => {
    try {
      navigator.clipboard.writeText(receiptCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      alert(`รหัสยืนยันการส่งของคุณคือ: ${receiptCode}`);
    }
  };

  const handlePrintReceipt = () => {
    window.print();
  };

  const handleRetry = async () => {
    if (!onRetrySync || isRetrying) return;
    setIsRetrying(true);
    try {
      await onRetrySync();
    } finally {
      setIsRetrying(false);
    }
  };

  const studentSubjs = subjs.filter(s => 
    submission.assignedSubjIds && submission.assignedSubjIds.length > 0
      ? submission.assignedSubjIds.includes(s.id)
      : (submission.subjAnswers && submission.subjAnswers[s.id] !== undefined
          ? true 
          : (Object.keys(submission.subjAnswers || {}).length === 0 && matchesClassGroup(s.classGroup, student.class)))
  );
  const hasMcqs = Boolean(submission.totalMcqCount && submission.totalMcqCount > 0) || Object.keys(submission.mcqAnswers || {}).length > 0 || mcqs.length > 0;
  const hasSubjs = studentSubjs.length > 0 || Object.keys(submission.subjAnswers || {}).length > 0;

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-100 p-4 font-sans">
      <div className="w-full max-w-3xl bg-white rounded-3xl shadow-2xl overflow-hidden border border-slate-200">
        {/* Certificate Header Banner */}
        <div className="bg-gradient-to-r from-emerald-600 via-green-600 to-teal-700 p-8 text-center text-white relative">
          <div className="w-24 h-24 mx-auto mb-4 bg-white text-emerald-600 rounded-full p-2 shadow-xl flex items-center justify-center overflow-hidden">
            <CheckCircle2 size={56} className="drop-shadow-sm" />
          </div>
          <h2 className="text-3xl font-bold mb-2 drop-shadow-md">ส่งข้อสอบสำเร็จแล้ว 100%</h2>
          <p className="text-emerald-100 text-lg font-medium">ระบบได้บันทึกคำตอบและออกหลักฐานการส่งสอบให้เรียบร้อยแล้ว</p>
        </div>

        <div className="p-6 sm:p-8">
          {/* Official Confirmation Receipt Code Box */}
          <div className="bg-slate-900 text-white p-6 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 mb-6 shadow-lg border border-slate-700">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold text-blue-300 uppercase tracking-wider mb-1">
                <FileCheck size={16} /> รหัสยืนยันการส่งข้อสอบ (Official Receipt ID)
              </div>
              <div className="text-2xl sm:text-3xl font-mono font-bold text-amber-400 tracking-wider">
                {receiptCode}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                * แคปหน้าจอนี้ หรือคัดลอกรหัสนี้ไว้เพื่อเป็นหลักฐานยืนยันกับคุณครูผู้สอน
              </div>
            </div>
            <button
              onClick={handleCopyCode}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold text-sm shadow-md transition-all cursor-pointer shrink-0"
            >
              {copied ? <Check size={18} className="text-green-300" /> : <Copy size={18} />}
              {copied ? 'คัดลอกรหัสสำเร็จ!' : 'คัดลอกรหัสยืนยัน'}
            </button>
          </div>

          {/* Cloud Database Connection Status Indicator */}
          {syncStatus === 'synced' ? (
            <div className="bg-emerald-50 border-2 border-emerald-200 text-emerald-800 p-4 rounded-2xl flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
                  <CheckCircle2 size={24} />
                </div>
                <div>
                  <div className="font-bold text-base text-emerald-900">บันทึกเข้าสู่ฐานข้อมูลกลาง (Cloud Server) สำเร็จเรียบร้อย</div>
                  <div className="text-xs text-emerald-700">ข้อมูลของคุณถูกซิงค์เข้าระบบเรียบร้อยแล้ว ครูผู้สอนสามารถดูผลคะแนนและคำตอบได้ทันที</div>
                </div>
              </div>
              <span className="hidden sm:inline-block px-3 py-1 bg-emerald-600 text-white text-xs font-bold rounded-full shrink-0">
                ออนไลน์สมบูรณ์
              </span>
            </div>
          ) : syncStatus === 'local_only' ? (
            <div className="bg-amber-50 border-2 border-amber-300 text-amber-900 p-4 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600 shrink-0">
                  <AlertCircle size={24} />
                </div>
                <div>
                  <div className="font-bold text-base text-amber-950">คำตอบถูกบันทึกไว้ในเครื่องเรียบร้อยแล้ว (ไม่สูญหายแน่นอน)</div>
                  <div className="text-xs text-amber-800">เนื่องจากสัญญาณเน็ตอาจสะดุด ระบบกำลังรอส่งขึ้นคลาวด์ หรือท่านสามารถกดส่งซ้ำได้</div>
                </div>
              </div>
              <button
                onClick={handleRetry}
                disabled={isRetrying}
                className="flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-xs shadow transition-all shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={14} className={isRetrying ? 'animate-spin' : ''} />
                {isRetrying ? 'กำลังส่ง...' : 'กดส่งซ้ำขึ้นคลาวด์'}
              </button>
            </div>
          ) : (
            <div className="bg-blue-50 border border-blue-200 text-blue-800 p-4 rounded-2xl flex items-center gap-3 mb-6">
              <Loader2 size={20} className="animate-spin text-blue-600 shrink-0" />
              <div className="text-sm font-medium">กำลังยืนยันสถานะการเชื่อมต่อกับเซิร์ฟเวอร์กลาง...</div>
            </div>
          )}

          {/* Student & Examination Summary Information */}
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-left space-y-4 mb-6 shadow-inner">
            <div className="grid grid-cols-2 gap-4 text-base sm:text-lg">
              <div className="text-slate-500 font-bold">รหัสนักเรียน</div>
              <div className="font-bold text-right text-slate-800">{student.id}</div>

              <div className="text-slate-500 font-bold">ชื่อ - นามสกุล</div>
              <div className="font-bold text-right text-slate-800">{student.name}</div>

              <div className="text-slate-500 font-bold">ชั้น / เลขที่</div>
              <div className="font-bold text-right text-slate-800">ม.{student.class} / เลขที่ {student.number}</div>

              <div className="col-span-2 border-t border-slate-200 my-1"></div>

              <div className="text-slate-500 font-bold">วันที่และเวลาที่ส่ง</div>
              <div className="font-bold text-right text-slate-800 text-sm sm:text-base">
                {new Date(submission.submittedAt).toLocaleString('th-TH')}
              </div>

              <div className="text-slate-500 font-bold flex items-center gap-2">
                <Clock size={18} /> เวลาที่ใช้สอบ
              </div>
              <div className="font-bold text-right text-blue-600">{mins} นาที {secs} วินาที</div>

              {hasMcqs && (
                <>
                  <div className="text-slate-500 font-bold">คะแนนปรนัยเบื้องต้น</div>
                  <div className="font-bold text-right text-emerald-600 text-xl">
                    {submission.mcqScore} / {submission.totalMcqCount || (Object.keys(submission.mcqAnswers || {}).length > 0 ? Object.keys(submission.mcqAnswers).length : mcqs.length)} คะแนน
                  </div>
                </>
              )}

              {hasSubjs && (
                <>
                  <div className="text-slate-500 font-bold">สถานะข้อสอบอัตนัย</div>
                  <div className="font-bold text-right text-blue-700">ส่งคำตอบแล้ว (รอคุณครูตรวจให้คะแนน)</div>
                </>
              )}

              <div className="text-slate-500 font-bold flex items-center gap-2">
                <ShieldAlert size={18} className={submission.cheatCount > 0 ? 'text-red-500' : 'text-slate-400'}/> คำเตือนสลับหน้าจอ
              </div>
              <div className={`font-bold text-right ${submission.cheatCount > 0 ? 'text-red-500' : 'text-slate-400'}`}>
                {submission.cheatCount > 0 ? `พบ ${submission.cheatCount} ครั้ง` : 'ปกติ (0 ครั้ง)'}
              </div>
            </div>
          </div>

          {/* Subjective Answers Review (Reassurance that answers are preserved) */}
          {hasSubjs && (
            <div className="text-left mb-8">
              <h3 className="font-bold text-xl mb-3 text-slate-800 border-l-4 border-blue-600 pl-3">
                บันทึกคำตอบอัตนัยที่ส่งเข้าระบบ
              </h3>
              <p className="text-xs text-slate-500 mb-4">
                คุณครูจะได้รับคำตอบตามที่นักเรียนได้บันทึกไว้ด้านล่างนี้:
              </p>
              <div className="space-y-4">
                {studentSubjs.map((s, i) => (
                  <div key={s.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-slate-800 font-bold mb-2 flex items-start gap-2">
                      <span className="text-blue-900 shrink-0">{i+1}.</span>
                      <div className="flex-1 font-bold">
                        <FormattedText text={s.text} />
                      </div>
                    </div>
                    <div className="text-slate-700 bg-slate-50 p-4 rounded-lg whitespace-pre-wrap border border-slate-200 font-medium text-base">
                      {submission.subjAnswers[s.id] || <span className="text-slate-400 italic">ไม่ได้ระบุคำตอบ</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3">
            <button 
              onClick={handlePrintReceipt}
              className="flex-1 py-3.5 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-xl font-bold text-base flex items-center justify-center gap-2 transition-all cursor-pointer"
            >
              <Printer size={18} /> พิมพ์ / บันทึกใบเสร็จหลักฐาน
            </button>
            <button 
              onClick={onLogout}
              className="flex-1 py-3.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl font-bold text-base flex items-center justify-center gap-2 shadow-md transition-all cursor-pointer"
            >
              <LogOut size={18} /> ออกจากระบบและกลับหน้าแรก
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminView({ 
  students, 
  setStudents, 
  mcqs, 
  setMcqs, 
  submissions, 
  setSubmissions, 
  subjs, 
  setSubjs, 
  onLogout, 
  databaseStatus, 
  settings, 
  saveSettings, 
  onSyncAllToCloud, 
  isSyncingAll,
  onDeleteSubmission,
  onDeleteMultipleSubmissions,
  onClearAllSubmissions,
  onToggleArchiveSubmission,
  onBulkArchiveSubmissions,
  onDownloadArchiveJSON
}: any) {
  const [tab, setTab] = useState<'students' | 'mcqs' | 'subjs' | 'grading' | 'settings'>('settings');
  const [isImporting, setIsImporting] = useState(false);

  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [newStudent, setNewStudent] = useState({ id: '', prefix: '', firstName: '', lastName: '', class: '', number: '' });
  
  const [studentClassFilter, setStudentClassFilter] = useState('all');
  const [subClassFilter, setSubClassFilter] = useState('all');
  const [selectedMcqs, setSelectedMcqs] = useState<Set<string>>(new Set());
  const [selectedSubjs, setSelectedSubjs] = useState<Set<string>>(new Set());
  const [selectedSubmissions, setSelectedSubmissions] = useState<Set<string>>(new Set());

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

  const [submissionToDelete, setSubmissionToDelete] = useState<Submission | null>(null);
  const [submissionsToDelete, setSubmissionsToDelete] = useState<Submission[] | null>(null);
  const [confirmClearAllSubmissions, setConfirmClearAllSubmissions] = useState(false);
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [isDeletingSubmission, setIsDeletingSubmission] = useState(false);
  const [isDeletingMultiple, setIsDeletingMultiple] = useState(false);
  const [isClearingAllSubmissions, setIsClearingAllSubmissions] = useState(false);

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
    const headers = ["วันที่ส่ง", "รหัสยืนยันการส่ง", "รหัสนักเรียน", "ชื่อ-สกุล", "ชั้น", "เลขที่", "คะแนนปรนัย", "จำนวนข้อปรนัย", "คะแนนอัตนัย", "จำนวนข้ออัตนัย", "คะแนนรวม", "เวลาที่ใช้ (นาที)", "แจ้งเตือนทุจริต", "สถานะการจัดเก็บ"];
    const rows = submissions.map((s: Submission) => {
       const student = students.find((st: Student) => st.id === s.studentId);
       const subjTotal = Object.values(s.subjScores || {}).reduce((a: number, b: number) => a + b, 0);
       const mcqTotal = s.totalMcqCount || (s.assignedMcqIds ? s.assignedMcqIds.length : Object.keys(s.mcqAnswers || {}).length);
       const subjQuestionsTotal = s.totalSubjCount || (s.assignedSubjIds ? s.assignedSubjIds.length : Object.keys(s.subjAnswers || {}).length);
       return [
         `"${new Date(s.submittedAt).toLocaleString('th-TH')}"`,
         `"${s.confirmationCode || '-'}"`,
         `"${s.studentId}"`,
         `"${student?.name || 'Unknown'}"`,
         `"${student?.class || '-'}"`,
         `"${student?.number || '-'}"`,
         s.mcqScore,
         mcqTotal,
         subjTotal,
         subjQuestionsTotal,
         s.mcqScore + subjTotal,
         (s.timeTakenMs / 60000).toFixed(2),
         s.cheatCount,
         s.isArchived ? '"จัดเก็บเข้ากรุแล้ว"' : '"ผลสอบปัจจุบัน"'
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
        } else if (line.match(optRegex) && currentMcq) {
          currentMcq.options.push(line.replace(/^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]+/i, ''));
        } else if (currentMcq) {
          if (currentMcq.options.length === 0) {
            currentMcq.text = (currentMcq.text ? currentMcq.text + '\n' : '') + line;
          } else {
            const lastIdx = currentMcq.options.length - 1;
            currentMcq.options[lastIdx] = (currentMcq.options[lastIdx] ? currentMcq.options[lastIdx] + '\n' : '') + line;
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
          } else if (line.match(optRegex) && currentMcq) {
            currentMcq.options.push(line.replace(/^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]+/i, ''));
          } else if (currentMcq) {
            if (currentMcq.options.length === 0) {
              currentMcq.text = (currentMcq.text ? currentMcq.text + '\n' : '') + line;
            } else {
              const lastIdx = currentMcq.options.length - 1;
              currentMcq.options[lastIdx] = (currentMcq.options[lastIdx] ? currentMcq.options[lastIdx] + '\n' : '') + line;
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
                <h4 className="font-bold text-lg text-blue-900 mb-2">รูปแบบข้อสอบของนักเรียน</h4>
                <p className="text-sm text-slate-500 mb-4">
                  เลือกกำหนดให้นักเรียนทำเฉพาะข้อสอบปรนัย (ช้อยส์), เฉพาะข้อสอบอัตนัย (ข้อเขียน), หรือทำทั้งสองแบบ
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl">
                  <button
                    type="button"
                    onClick={() => saveSettings({ ...settings, examFormat: 'both' })}
                    className={`p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${(!settings.examFormat || settings.examFormat === 'both') ? 'border-blue-600 bg-blue-50/80 text-blue-950 font-bold shadow-sm ring-2 ring-blue-200' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 size={20} className={(!settings.examFormat || settings.examFormat === 'both') ? 'text-blue-600' : 'text-slate-300'} />
                      <span className="text-base font-bold">ทั้งปรนัยและอัตนัย</span>
                    </div>
                    <p className="text-xs text-slate-500 font-normal mt-1">
                      ตอนที่ 1 ปรนัย (กขคง) และตอนที่ 2 อัตนัย (ข้อเขียน)
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => saveSettings({ ...settings, examFormat: 'mcq_only' })}
                    className={`p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${settings.examFormat === 'mcq_only' ? 'border-blue-600 bg-blue-50/80 text-blue-950 font-bold shadow-sm ring-2 ring-blue-200' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 size={20} className={settings.examFormat === 'mcq_only' ? 'text-blue-600' : 'text-slate-300'} />
                      <span className="text-base font-bold">เฉพาะข้อสอบปรนัย</span>
                    </div>
                    <p className="text-xs text-slate-500 font-normal mt-1">
                      ทำเฉพาะข้อสอบปรนัย (ช้อยส์) เท่านั้น ไม่แสดงข้อสอบอัตนัย
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => saveSettings({ ...settings, examFormat: 'subj_only' })}
                    className={`p-4 rounded-2xl border-2 text-left transition-all cursor-pointer ${settings.examFormat === 'subj_only' ? 'border-blue-600 bg-blue-50/80 text-blue-950 font-bold shadow-sm ring-2 ring-blue-200' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 size={20} className={settings.examFormat === 'subj_only' ? 'text-blue-600' : 'text-slate-300'} />
                      <span className="text-base font-bold">เฉพาะข้อสอบอัตนัย</span>
                    </div>
                    <p className="text-xs text-slate-500 font-normal mt-1">
                      ทำเฉพาะข้อสอบอัตนัย (ข้อเขียน) เท่านั้น ไม่แสดงข้อสอบปรนัย
                    </p>
                  </button>
                </div>
              </div>

              <div className="border-t border-blue-100 pt-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                  <div>
                    <h4 className="font-bold text-lg text-blue-900 flex items-center gap-2">
                      <CheckSquare size={20} className="text-blue-600" />
                      การกำหนดจำนวนข้อสอบที่ให้นักเรียนทำ (ทั้งปรนัยและอัตนัย)
                    </h4>
                    <p className="text-sm text-slate-500">
                      เช่น ในคลังมีข้อสอบ 60 ข้อ แต่ต้องการให้เด็กสอบเพียง 45 ข้อ สามารถระบุจำนวนข้อที่ต้องการคัดเลือกได้
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
                  {/* MCQ Limit Card */}
                  <div className="p-5 rounded-2xl border-2 border-blue-200 bg-white shadow-xs">
                    <div className="flex items-center justify-between mb-2">
                      <label className="font-bold text-slate-800 text-base flex items-center gap-2">
                        📝 จำนวนข้อสอบปรนัย (MCQ)
                      </label>
                      <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200">
                        ในคลังมี {mcqs.length} ข้อ
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mb-3">
                      ระบุจำนวนข้อที่ต้องการให้นักเรียนทำ (กรอก 0 หรือเว้นว่างหากต้องการให้นักเรียนทำทั้งหมด)
                    </p>
                    
                    <div className="flex items-center gap-3 mb-3">
                      <input 
                        type="number"
                        min={0}
                        max={mcqs.length || 1000}
                        placeholder="ทั้งหมดในคลัง"
                        value={settings.maxMcqCount || ''}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          saveSettings({ ...settings, maxMcqCount: isNaN(val) || val <= 0 ? 0 : val });
                        }}
                        className="w-36 p-2.5 border-2 border-blue-200 rounded-xl font-bold text-lg text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-blue-50/30"
                      />
                      <span className="text-sm font-bold text-slate-600">ข้อ</span>
                      <button
                        type="button"
                        onClick={() => saveSettings({ ...settings, maxMcqCount: 0 })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          !settings.maxMcqCount || settings.maxMcqCount === 0 
                            ? 'bg-blue-600 text-white shadow-xs' 
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-300'
                        }`}
                      >
                        สอบทั้งหมด ({mcqs.length})
                      </button>
                    </div>

                    {/* Preset shortcuts */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
                      <span className="text-[11px] font-bold text-slate-400">ปุ่มลัดเลือกจำนวน:</span>
                      {[20, 30, 40, 45, 50, 60].map(cnt => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() => saveSettings({ ...settings, maxMcqCount: cnt })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                            settings.maxMcqCount === cnt 
                              ? 'bg-blue-600 text-white shadow-xs' 
                              : 'bg-slate-50 hover:bg-blue-50 text-slate-700 border border-slate-200'
                          }`}
                        >
                          {cnt} ข้อ
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                      📌 สถานะ: นักเรียนจะได้รับข้อสอบปรนัย <strong className="text-blue-700">{settings.maxMcqCount && settings.maxMcqCount > 0 ? `${Math.min(settings.maxMcqCount, mcqs.length)} ข้อ` : `ทั้งหมด (${mcqs.length} ข้อ)`}</strong>
                    </div>
                  </div>

                  {/* Subjective Limit Card */}
                  <div className="p-5 rounded-2xl border-2 border-blue-200 bg-white shadow-xs">
                    <div className="flex items-center justify-between mb-2">
                      <label className="font-bold text-slate-800 text-base flex items-center gap-2">
                        ✍️ จำนวนข้อสอบอัตนัย (Subjective)
                      </label>
                      <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200">
                        ในคลังมี {subjs.length} ข้อ
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mb-3">
                      ระบุจำนวนข้อเขียนที่ต้องการให้นักเรียนตอบ (กรอก 0 หรือเว้นว่างหากต้องการให้นักเรียนทำทั้งหมด)
                    </p>
                    
                    <div className="flex items-center gap-3 mb-3">
                      <input 
                        type="number"
                        min={0}
                        max={subjs.length || 1000}
                        placeholder="ทั้งหมดในคลัง"
                        value={settings.maxSubjCount || ''}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          saveSettings({ ...settings, maxSubjCount: isNaN(val) || val <= 0 ? 0 : val });
                        }}
                        className="w-36 p-2.5 border-2 border-blue-200 rounded-xl font-bold text-lg text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-blue-50/30"
                      />
                      <span className="text-sm font-bold text-slate-600">ข้อ</span>
                      <button
                        type="button"
                        onClick={() => saveSettings({ ...settings, maxSubjCount: 0 })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          !settings.maxSubjCount || settings.maxSubjCount === 0 
                            ? 'bg-blue-600 text-white shadow-xs' 
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-300'
                        }`}
                      >
                        สอบทั้งหมด ({subjs.length})
                      </button>
                    </div>

                    {/* Preset shortcuts */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
                      <span className="text-[11px] font-bold text-slate-400">ปุ่มลัดเลือกจำนวน:</span>
                      {[1, 2, 3, 5, 10].map(cnt => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() => saveSettings({ ...settings, maxSubjCount: cnt })}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                            settings.maxSubjCount === cnt 
                              ? 'bg-blue-600 text-white shadow-xs' 
                              : 'bg-slate-50 hover:bg-blue-50 text-slate-700 border border-slate-200'
                          }`}
                        >
                          {cnt} ข้อ
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                      📌 สถานะ: นักเรียนจะได้รับข้อสอบอัตนัย <strong className="text-blue-700">{settings.maxSubjCount && settings.maxSubjCount > 0 ? `${Math.min(settings.maxSubjCount, subjs.length)} ข้อ` : `ทั้งหมด (${subjs.length} ข้อ)`}</strong>
                    </div>
                  </div>
                </div>

                {/* Selection Mode Selector */}
                <div className="mt-4 p-5 rounded-2xl bg-blue-50/50 border border-blue-200">
                  <h5 className="font-bold text-sm text-blue-900 mb-2">วิธีการคัดเลือกข้อสอบจากคลัง:</h5>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => saveSettings({ ...settings, questionSelectionMode: 'random' })}
                      className={`p-3.5 rounded-xl border-2 text-left transition-all cursor-pointer ${
                        (!settings.questionSelectionMode || settings.questionSelectionMode === 'random')
                          ? 'border-blue-600 bg-white text-blue-950 font-bold shadow-xs'
                          : 'border-slate-200 bg-white/60 text-slate-600 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <CheckCircle2 size={18} className={(!settings.questionSelectionMode || settings.questionSelectionMode === 'random') ? 'text-blue-600' : 'text-slate-300'} />
                        <span className="font-bold text-sm">🎲 สุ่มเลือกข้อสอบ (Random Selection)</span>
                      </div>
                      <p className="text-xs text-slate-500 font-normal pl-6">
                        ระบบจะสุ่มดึงข้อสอบตามจำนวนที่กำหนด เช่น สุ่ม 45 ข้อจาก 60 ข้อ โดยแต่ละคนจะได้ข้อสอบคละสุ่มอย่างยุติธรรม
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => saveSettings({ ...settings, questionSelectionMode: 'order' })}
                      className={`p-3.5 rounded-xl border-2 text-left transition-all cursor-pointer ${
                        settings.questionSelectionMode === 'order'
                          ? 'border-blue-600 bg-white text-blue-950 font-bold shadow-xs'
                          : 'border-slate-200 bg-white/60 text-slate-600 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <CheckCircle2 size={18} className={settings.questionSelectionMode === 'order' ? 'text-blue-600' : 'text-slate-300'} />
                        <span className="font-bold text-sm">🔢 เลือกตามลำดับในคลัง (First N in Order)</span>
                      </div>
                      <p className="text-xs text-slate-500 font-normal pl-6">
                        ระบบจะเลือกข้อสอบเรียงตามลำดับข้อที่ 1 ถึงข้อที่กำหนดจากคลังข้อสอบโดยตรง ทุกคนจะได้ข้อสอบเหมือนกัน
                      </p>
                    </button>
                  </div>
                </div>
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
                <h3 className="text-2xl font-bold text-slate-800">คลังข้อสอบ (ปรนัย)</h3>
                <div className="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                  <span>ทั้งหมด {mcqs.length} ข้อ | เลือก {selectedMcqs.size} ข้อ</span>
                  {settings.maxMcqCount && settings.maxMcqCount > 0 ? (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                      🎯 ตั้งค่าให้นักเรียนทำ: {settings.maxMcqCount} ข้อ ({settings.questionSelectionMode === 'order' ? 'ตามลำดับ' : 'สุ่มคัดเลือก'})
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                      ให้นักเรียนทำ: ทั้งหมดในคลัง
                    </span>
                  )}
                </div>
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
                  <div className="font-medium mb-4 text-slate-800">
                    <FormattedText text={m.text} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm text-slate-500">
                    {(m.options || []).map((opt, idx) => (
                      <div key={idx} className={idx === m.correctIndex ? 'text-green-700 font-bold bg-green-50 p-2.5 rounded-lg border border-green-200' : 'p-2'}>
                        <div className="flex items-start gap-1.5">
                          <span className="shrink-0 font-bold select-none">-</span>
                          <FormattedText text={opt} className="flex-1" />
                        </div>
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
                <h3 className="text-2xl font-bold text-slate-800">คลังข้อสอบ (อัตนัย)</h3>
                <div className="text-sm text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                  <span>ทั้งหมด {subjs.length} ข้อ | เลือก {selectedSubjs.size} ข้อ</span>
                  {settings.maxSubjCount && settings.maxSubjCount > 0 ? (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300">
                      🎯 ตั้งค่าให้นักเรียนทำ: {settings.maxSubjCount} ข้อ ({settings.questionSelectionMode === 'order' ? 'ตามลำดับ' : 'สุ่มคัดเลือก'})
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                      ให้นักเรียนทำ: ทั้งหมดในคลัง
                    </span>
                  )}
                </div>
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
                  <div className="font-medium mb-4 text-slate-800">
                    <FormattedText text={s.text} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'grading' && (() => {
          const visibleSubmissions = submissions
            .filter((s: Submission) => {
              const student = students.find((st: Student) => st.id === s.studentId);
              const matchesClass = subClassFilter === 'all' || (student && student.class === subClassFilter) || s.classGroup === subClassFilter;
              const matchesArchive = archiveFilter === 'all' 
                ? true 
                : archiveFilter === 'archived' 
                  ? !!s.isArchived 
                  : !s.isArchived;
              return matchesClass && matchesArchive;
            })
            .sort((a: Submission, b: Submission) => {
              const sA = students.find((st: Student) => st.id === a.studentId);
              const sB = students.find((st: Student) => st.id === b.studentId);
              return (sA?.number || 0) - (sB?.number || 0);
            });

          const isAllVisibleSelected = visibleSubmissions.length > 0 && visibleSubmissions.every(s => selectedSubmissions.has(s.id));

          return (
            <div>
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-6">
                <div>
                  <h3 className="text-2xl font-bold text-slate-800">ผลการสอบและการตรวจให้คะแนน</h3>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs font-medium">
                    <span className="text-slate-500">ทั้งหมด {submissions.length} คน</span>
                    <span className="text-slate-300">•</span>
                    <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                      ผลสอบปัจจุบัน {submissions.filter((s: Submission) => !s.isArchived).length} คน
                    </span>
                    <span className="text-slate-300">•</span>
                    <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                      จัดเก็บเข้ากรุแล้ว {submissions.filter((s: Submission) => s.isArchived).length} คน
                    </span>
                  </div>
                </div>

                {/* Filters & Actions */}
                <div className="flex flex-wrap items-center gap-2.5">
                  <select 
                    className="border border-blue-200 p-2 rounded-xl bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                    value={subClassFilter}
                    onChange={(e) => setSubClassFilter(e.target.value)}
                  >
                    <option value="all">ทุกห้องเรียน</option>
                    {Array.from(new Set(students.map((s: Student) => s.class))).sort().map(c => (
                      <option key={c as string} value={c as string}>ห้อง {c as string}</option>
                    ))}
                  </select>

                  <select 
                    className="border border-blue-200 p-2 rounded-xl bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 font-medium"
                    value={archiveFilter}
                    onChange={(e) => setArchiveFilter(e.target.value as any)}
                  >
                    <option value="active">📁 ผลสอบปัจจุบัน (Active)</option>
                    <option value="archived">📦 ที่จัดเก็บเข้ากรุแล้ว (Archived)</option>
                    <option value="all">🌐 แสดงทั้งหมด (All)</option>
                  </select>

                  <button 
                    onClick={onDownloadArchiveJSON} 
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-700 hover:bg-slate-800 text-white rounded-xl text-sm font-medium shadow-sm transition-all cursor-pointer"
                    title="ดาวน์โหลดไฟล์สำรองข้อมูลผลสอบทั้งหมด (JSON) เพื่อเก็บประวัติไว้ในคอมพิวเตอร์"
                  >
                    <FileDown size={16} /> สำรองข้อมูล (JSON)
                  </button>

                  <button 
                    onClick={handleExportCSV} 
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all cursor-pointer"
                    title="ส่งออกผลคะแนนเป็นไฟล์ Excel / CSV"
                  >
                    <Download size={16} /> ส่งออก CSV
                  </button>

                  <button 
                    onClick={() => setConfirmClearAllSubmissions(true)} 
                    disabled={submissions.length === 0}
                    className="flex items-center gap-1.5 px-3.5 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-medium shadow-sm transition-all disabled:opacity-40 cursor-pointer"
                    title="ล้างข้อมูลผลการสอบของนักเรียนทั้งหมดออกจากฐานข้อมูลเพื่อเริ่มสอบรอบใหม่"
                  >
                    <Trash2 size={16} /> ล้างข้อมูลผลสอบทั้งหมด
                  </button>
                </div>
              </div>

              {/* Batch Actions Bar */}
              {selectedSubmissions.size > 0 && (
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-2xl p-3.5 mb-4 flex flex-wrap items-center justify-between gap-3 shadow-sm animate-in fade-in slide-in-from-top-2 duration-150">
                  <div className="flex items-center gap-2.5 text-sm font-bold text-blue-900">
                    <CheckSquare size={20} className="text-blue-600" />
                    <span>เลือกไว้ {selectedSubmissions.size} คน (จาก {visibleSubmissions.length} คนในตาราง)</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        onBulkArchiveSubmissions(Array.from(selectedSubmissions), true);
                        setSelectedSubmissions(new Set());
                      }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer"
                      title="จัดเก็บผลสอบของนักเรียนที่เลือกเข้ากรุ (ซ่อนจากตารางปัจจุบัน)"
                    >
                      <Archive size={14} /> จัดเก็บที่เลือก ({selectedSubmissions.size})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onBulkArchiveSubmissions(Array.from(selectedSubmissions), false);
                        setSelectedSubmissions(new Set());
                      }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer"
                      title="กู้คืนผลสอบของนักเรียนที่เลือกกลับมาหน้าปัจจุบัน"
                    >
                      <ArchiveRestore size={14} /> กู้คืนที่เลือก ({selectedSubmissions.size})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const toDel = submissions.filter(s => selectedSubmissions.has(s.id));
                        setSubmissionsToDelete(toDel);
                      }}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold transition-all shadow-xs cursor-pointer"
                      title="ลบผลสอบของนักเรียนที่เลือกออกจากระบบ เพื่อให้นักเรียนเข้าสอบใหม่ได้"
                    >
                      <Trash2 size={14} /> ลบผลสอบที่เลือก ({selectedSubmissions.size})
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedSubmissions(new Set())}
                      className="px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-white rounded-xl text-xs font-semibold transition-all cursor-pointer"
                    >
                      ยกเลิกการเลือก
                    </button>
                  </div>
                </div>
              )}
              
              <div className="bg-white rounded-2xl border border-blue-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-blue-50">
                    <tr>
                      <th className="p-4 w-12 text-center">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                          checked={isAllVisibleSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedSubmissions(new Set([...selectedSubmissions, ...visibleSubmissions.map(s => s.id)]));
                            } else {
                              const next = new Set(selectedSubmissions);
                              visibleSubmissions.forEach(s => next.delete(s.id));
                              setSelectedSubmissions(next);
                            }
                          }}
                          title={isAllVisibleSelected ? 'ยกเลิกเลือกทั้งหมด' : 'เลือกทั้งหมดในหน้านี้'}
                        />
                      </th>
                      <th className="p-4 font-medium text-blue-900">วันที่/เวลาส่ง</th>
                      <th className="p-4 font-medium text-blue-900">รหัส นร.</th>
                      <th className="p-4 font-medium text-blue-900">ชื่อ-สกุล</th>
                      <th className="p-4 font-medium text-blue-900">ชั้น/เลขที่</th>
                      <th className="p-4 font-medium text-blue-900">คะแนน (ปรนัย+อัตนัย)</th>
                      <th className="p-4 font-medium text-blue-900">เวลาที่ใช้</th>
                      <th className="p-4 font-medium text-blue-900">สถานะทุจริต</th>
                      <th className="p-4 font-medium text-blue-900">สถานะ</th>
                      <th className="p-4 font-medium text-blue-900">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {visibleSubmissions.map((s: Submission) => {
                      const student = students.find((st: Student) => st.id === s.studentId);
                      const subjScoreTotal = Object.values(s.subjScores || {}).reduce((acc: number, val: number) => acc + val, 0);
                      const isSelected = selectedSubmissions.has(s.id);
                      return (
                      <tr key={s.id} className={`hover:bg-slate-50 transition-colors ${isSelected ? 'bg-blue-50/40' : ''}`}>
                        <td className="p-4 w-12 text-center">
                          <input 
                            type="checkbox" 
                            className="w-4 h-4 rounded border-blue-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                            checked={isSelected}
                            onChange={(e) => {
                              const next = new Set(selectedSubmissions);
                              if (e.target.checked) next.add(s.id);
                              else next.delete(s.id);
                              setSelectedSubmissions(next);
                            }}
                          />
                        </td>
                        <td className="p-4 text-xs text-slate-700">{new Date(s.submittedAt).toLocaleString('th-TH')}</td>
                        <td className="p-4">
                          <div className="font-bold text-slate-800">{s.studentId}</div>
                          {s.confirmationCode && (
                            <div className="text-[11px] font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200 mt-1 inline-block" title="รหัสยืนยันการส่งข้อสอบ">
                              {s.confirmationCode}
                            </div>
                          )}
                        </td>
                        <td className="p-4 font-medium text-slate-800">{student?.name || s.studentName || '-'}</td>
                        <td className="p-4 text-slate-600">{student?.class || s.studentClass || s.classGroup || '-'}/{student?.number || s.studentNumber || '-'}</td>
                        <td className="p-4 font-bold text-emerald-600">
                          <div>{s.mcqScore} + {subjScoreTotal} = <span className="text-base text-emerald-700">{s.mcqScore + subjScoreTotal}</span></div>
                          {s.totalMcqCount ? (
                            <div className="text-[11px] font-normal text-slate-500">
                              (ปรนัย {s.mcqScore}/{s.totalMcqCount})
                            </div>
                          ) : null}
                        </td>
                        <td className="p-4 text-slate-600">{Math.floor(s.timeTakenMs/60000)} น.</td>
                        <td className="p-4">
                          {s.cheatCount > 0 ? (
                            <span className="inline-flex items-center gap-1 text-red-600 font-bold bg-red-50 border border-red-200 px-2.5 py-0.5 rounded-full text-xs">
                              <ShieldAlert size={12} /> พบ ({s.cheatCount})
                            </span>
                          ) : (
                            <span className="text-emerald-600 font-medium text-xs bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">ปกติ</span>
                          )}
                        </td>
                        <td className="p-4">
                          {s.isArchived ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                              <Archive size={12} /> จัดเก็บแล้ว
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200">
                              <CheckCircle2 size={12} /> ผลสอบปัจจุบัน
                            </span>
                          )}
                        </td>
                        <td className="p-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button 
                              onClick={() => { setGradingSub(s); setTempScores(s.subjScores || {}); }} 
                              className="px-2.5 py-1.5 text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg border border-blue-200 transition-all cursor-pointer shrink-0"
                              title="ตรวจและดูคำตอบอัตนัย"
                            >
                              ตรวจคำตอบ
                            </button>
                            
                            <button 
                              onClick={() => onToggleArchiveSubmission(s.id)}
                              className={`px-2.5 py-1.5 text-xs font-bold rounded-lg border flex items-center gap-1 transition-all cursor-pointer shrink-0 ${
                                s.isArchived 
                                  ? 'bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200' 
                                  : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
                              }`}
                              title={s.isArchived ? 'กู้คืนผลสอบกลับมาแสดงในหน้าปัจจุบัน' : 'จัดเก็บข้อมูลนักเรียนคนนี้เข้ากรุ (ซ่อนจากตารางปัจจุบัน)'}
                            >
                              {s.isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                              <span>{s.isArchived ? 'กู้คืน' : 'จัดเก็บ'}</span>
                            </button>

                            <button 
                              onClick={() => setSubmissionToDelete(s)}
                              className="px-2.5 py-1.5 text-xs font-bold rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 hover:text-red-800 flex items-center gap-1 transition-all cursor-pointer shrink-0"
                              title="ลบผลการสอบของนักเรียนคนนี้ เพื่อให้นักเรียนเข้าสอบใหม่ได้"
                            >
                              <Trash2 size={13} />
                              <span>ลบผลสอบ</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    )})}
                    {submissions.length === 0 && (
                      <tr>
                        <td colSpan={10} className="p-12 text-center text-slate-500">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <AlertCircle size={32} className="text-slate-400" />
                            <span className="font-bold text-base">ยังไม่มีข้อมูลการส่งข้อสอบในระบบ</span>
                            <span className="text-xs text-slate-400">เมื่อนักเรียนส่งข้อสอบ ข้อมูลจะแสดงที่นี่แบบเรียลไทม์</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {submissions.length > 0 && visibleSubmissions.length === 0 && (
                      <tr>
                        <td colSpan={10} className="p-12 text-center text-slate-500">
                          <div className="flex flex-col items-center justify-center gap-2">
                            <AlertCircle size={32} className="text-slate-400" />
                            <span className="font-bold text-base">
                              {archiveFilter === 'archived' ? 'ไม่มีข้อมูลผลสอบที่จัดเก็บเข้ากรุไว้' : 'ไม่พบข้อมูลผลสอบตามเงื่อนไขที่เลือก'}
                            </span>
                            <span className="text-xs text-slate-400">ลองเปลี่ยนตัวกรองห้องเรียนหรือสถานะการจัดเก็บ</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
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
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold mb-4 text-blue-900">เพิ่มข้อสอบใหม่ (ปรนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={newMcq.classGroup} onChange={e=>setNewMcq({...newMcq, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={newMcq.examType || 'general'} onChange={e=>setNewMcq({...newMcq, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <FormattedQuestionTextarea 
                value={newMcq.text}
                onChange={val => setNewMcq({ ...newMcq, text: val })}
                placeholder="พิมพ์คำถาม... เช่น อ่านบทความต่อไปนี้:\n[box]สิทธิเสรีภาพของปวงชนชาวไทย[/box]\nข้อใดคือความหมายของ ==ประชาธิปไตย==?"
              />
              {(newMcq.options || []).map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={opt} onChange={e => {
                      const newOpts = [...newMcq.options];
                      newOpts[idx] = e.target.value;
                      setNewMcq({...newMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setNewMcq({...newMcq, correctIndex: idx})} className={`px-4 rounded-xl font-bold border transition-colors ${newMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-slate-50 border-blue-200 text-slate-500'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setIsAddingMcq(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setMcqs([...mcqs, { ...newMcq, id: Date.now().toString() }]);
                  setIsAddingMcq(false);
                  setNewMcq({ id: '', text: '', options: ['', '', '', '', ''], correctIndex: 0, classGroup: '6/3' });
                }} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm">เพิ่มข้อสอบ</button>
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
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold mb-4 text-blue-900">แก้ไขข้อสอบ (ปรนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={editingMcq.classGroup} onChange={e=>setEditingMcq({...editingMcq, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={editingMcq.examType || 'general'} onChange={e=>setEditingMcq({...editingMcq, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <FormattedQuestionTextarea 
                value={editingMcq.text}
                onChange={val => setEditingMcq({ ...editingMcq, text: val })}
                placeholder="พิมพ์ข้อความคำถาม..."
              />
              {(editingMcq.options || []).map((opt, idx) => (
                <div key={idx}>
                  <label className="block text-sm font-medium mb-1">ตัวเลือกที่ {idx + 1}</label>
                  <div className="flex gap-2">
                    <input className="flex-1 border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={opt} onChange={e => {
                      const newOpts = [...editingMcq.options];
                      newOpts[idx] = e.target.value;
                      setEditingMcq({...editingMcq, options: newOpts});
                    }} />
                    <button onClick={()=>setEditingMcq({...editingMcq, correctIndex: idx})} className={`px-4 rounded-xl font-bold border transition-colors ${editingMcq.correctIndex === idx ? 'bg-green-500 text-white border-green-600' : 'bg-slate-50 border-blue-200 text-slate-500'}`}>ถูก</button>
                  </div>
                </div>
              ))}
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={()=>setEditingMcq(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={handleSaveMcq} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm">บันทึก</button>
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
                <div className="text-sm text-slate-500 mt-1">
                  รหัสนักเรียน: <span className="font-medium text-blue-900">{gradingSub.studentId}</span> | คะแนนปรนัย: <span className="font-bold text-emerald-600">{gradingSub.mcqScore} / {gradingSub.totalMcqCount || (gradingSub.assignedMcqIds?.length || Object.keys(gradingSub.mcqAnswers || {}).length || mcqs.length)} คะแนน</span>
                </div>
              </div>
              <button onClick={()=>setGradingSub(null)} className="text-slate-500 hover:text-blue-900"><X size={24} /></button>
            </div>
            
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-50">
              {(() => {
                const assignedMcqList: MCQ[] = gradingSub.assignedMcqIds && gradingSub.assignedMcqIds.length > 0
                  ? gradingSub.assignedMcqIds.map((id: string) => mcqs.find((m: any) => m.id === id)).filter(Boolean)
                  : mcqs.filter((m: any) => gradingSub.mcqAnswers && gradingSub.mcqAnswers[m.id] !== undefined);

                return assignedMcqList.length > 0 && (
                  <div className="mb-8">
                    <div className="flex items-center justify-between border-b pb-2 mb-4">
                      <h4 className="font-bold text-blue-900 text-lg">
                        ผลการสอบปรนัย (คะแนนรวม: {gradingSub.mcqScore} / {gradingSub.totalMcqCount || assignedMcqList.length})
                      </h4>
                      <span className="text-xs text-slate-500 font-medium">
                        ชุดข้อสอบ {assignedMcqList.length} ข้อ
                      </span>
                    </div>
                    <div className="space-y-4">
                      {assignedMcqList.map((mcq: any, i: number) => {
                        const studentAnswer = gradingSub.mcqAnswers ? gradingSub.mcqAnswers[mcq.id] : undefined;
                        const isAnswered = studentAnswer !== undefined && studentAnswer !== '';
                        const isCorrect = isAnswered && studentAnswer === mcq.options[mcq.correctIndex];
                        return (
                          <div key={mcq.id} className={`border p-4 rounded-xl bg-white shadow-xs ${isCorrect ? 'border-green-200' : !isAnswered ? 'border-amber-200 bg-amber-50/20' : 'border-red-200'}`}>
                            <div className="font-bold text-blue-900 mb-2 flex items-start gap-2">
                              <span className="shrink-0">ข้อ {i+1}:</span>
                              <FormattedText text={mcq.text} className="flex-1 font-bold" />
                            </div>
                            <div className={`p-3 rounded-lg text-sm ${isCorrect ? 'bg-green-50 text-green-700 border border-green-200' : !isAnswered ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                              <div className="font-semibold flex items-start gap-1.5 flex-wrap">
                                <span className="shrink-0">คำตอบที่เลือก:</span>
                                <FormattedText text={studentAnswer || "- ไม่ได้ตอบข้อนี้ -"} className="inline" />
                                <span className="shrink-0 ml-1">{isCorrect ? '✅ ถูกต้อง (+1)' : !isAnswered ? '⚠️ ไม่ได้ตอบ (0)' : '❌ ผิด (0)'}</span>
                              </div>
                              {!isCorrect && (
                                <div className="mt-1 text-slate-600 flex items-start gap-1.5 pt-1 border-t border-slate-100">
                                  <span className="shrink-0 font-medium">เฉลยที่ถูกต้อง:</span>
                                  <FormattedText text={mcq.options[mcq.correctIndex]} className="inline font-bold text-emerald-700" />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              
              {(() => {
                const assignedSubjList: Subjective[] = gradingSub.assignedSubjIds && gradingSub.assignedSubjIds.length > 0
                  ? gradingSub.assignedSubjIds.map((id: string) => subjs.find((s: any) => s.id === id)).filter(Boolean)
                  : (Object.keys(gradingSub.subjAnswers || {}).length > 0
                      ? subjs.filter((s: any) => gradingSub.subjAnswers && gradingSub.subjAnswers[s.id] !== undefined)
                      : subjs.filter((s: any) => matchesClassGroup(s.classGroup, gradingSub.classGroup)));

                return (
                  <div>
                    <div className="flex items-center justify-between border-b pb-2 mb-4">
                      <h4 className="font-bold text-blue-900 text-lg">ผลการสอบอัตนัย (ข้อเขียน)</h4>
                      <span className="text-xs text-slate-500 font-medium">
                        ชุดข้อสอบ {assignedSubjList.length} ข้อ
                      </span>
                    </div>
                    {assignedSubjList.length === 0 ? (
                      <p className="text-sm text-slate-400 italic py-4 text-center">ไม่มีข้อสอบอัตนัยในชุดนี้</p>
                    ) : (
                      assignedSubjList.map((subj: any, i: number) => (
                        <div key={subj.id} className="border border-blue-200 p-5 rounded-xl bg-white shadow-sm mb-4">
                          <div className="font-bold text-blue-900 mb-3 flex items-start gap-2">
                            <span className="shrink-0">ข้อ {i+1}:</span>
                            <FormattedText text={subj.text} className="flex-1 font-bold" />
                          </div>
                          <div className="bg-slate-50 border border-blue-100 p-4 rounded-lg mb-4 min-h-[80px] whitespace-pre-wrap text-slate-700 text-base">
                            {gradingSub.subjAnswers && gradingSub.subjAnswers[subj.id] 
                              ? gradingSub.subjAnswers[subj.id] 
                              : <span className="text-slate-400 italic">- ไม่ได้ตอบข้อนี้ -</span>}
                          </div>
                          <div className="flex items-center gap-3 bg-blue-50 p-3 rounded-lg w-max">
                            <label className="font-medium text-sm text-blue-900">ให้คะแนนข้อนี้:</label>
                            <input 
                              type="number" 
                              min="0"
                              className="border border-blue-200 p-2 rounded w-24 text-center font-bold text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white"
                              value={tempScores[subj.id] ?? 0}
                              onChange={e => setTempScores({...tempScores, [subj.id]: parseInt(e.target.value) || 0})}
                            />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
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
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold mb-4 text-blue-900">เพิ่มข้อสอบใหม่ (อัตนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={newSubj.classGroup} onChange={e=>setNewSubj({...newSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={newSubj.examType || 'general'} onChange={e=>setNewSubj({...newSubj, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <FormattedQuestionTextarea 
                value={newSubj.text}
                onChange={val => setNewSubj({ ...newSubj, text: val })}
                placeholder="พิมพ์คำถามอัตนัย... เช่น ให้นักเรียนวิเคราะห์สถานการณ์ต่อไปนี้:\n[box]การปฏิบัติตนตามหลักธรรมาภิบาลในสังคม[/box]\nและยกตัวอย่างการประยุกต์ใช้ในชีวิตประจำวัน"
              />
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setIsAddingSubj(false)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setSubjs([...subjs, { ...newSubj, id: Date.now().toString() }]);
                  setIsAddingSubj(false);
                  setNewSubj({ id: '', text: '', classGroup: '6/3' });
                }} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm">เพิ่มข้อสอบ</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingSubj && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
            <h3 className="text-xl font-bold mb-4 text-blue-900">แก้ไขข้อสอบ (อัตนัย)</h3>
            <div className="space-y-4 text-slate-700">
              <div>
                <label className="block text-sm font-bold mb-1">ระดับชั้น (เช่น 6/3, หรือ 6/3, 6/8 หรือ ทั้งหมด)</label>
                <input placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด" className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={editingSubj.classGroup} onChange={e=>setEditingSubj({...editingSubj, classGroup: e.target.value})} />
              </div>
              <div>
                <label className="block text-sm font-bold mb-1">ประเภทข้อสอบ</label>
                <select className="w-full border border-blue-200 p-2.5 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300" value={editingSubj.examType || 'general'} onChange={e=>setEditingSubj({...editingSubj, examType: e.target.value as any})}>
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
              </div>
              <FormattedQuestionTextarea 
                value={editingSubj.text}
                onChange={val => setEditingSubj({ ...editingSubj, text: val })}
                placeholder="พิมพ์ข้อความคำถามอัตนัย..."
              />
              <div className="flex justify-end gap-2 mt-6">
                <button onClick={() => setEditingSubj(null)} className="px-4 py-2 border border-blue-200 text-slate-500 rounded-xl hover:bg-slate-50">ยกเลิก</button>
                <button onClick={() => {
                  setSubjs(subjs.map((s: Subjective) => s.id === editingSubj.id ? editingSubj : s));
                  setEditingSubj(null);
                }} className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm">บันทึก</button>
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

      {/* Delete Single Submission Modal */}
      {submissionToDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-red-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-14 h-14 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 size={28} />
            </div>
            <h3 className="text-xl font-bold text-center text-slate-900 mb-2">ลบผลการสอบของนักเรียน</h3>
            <p className="text-sm text-slate-600 text-center mb-5">
              คุณต้องการลบผลการสอบของนักเรียนคนนี้ออกจากระบบใช่หรือไม่?
            </p>

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-sm space-y-2 mb-5">
              <div className="flex justify-between">
                <span className="text-slate-500">ชื่อ-นามสกุล:</span>
                <span className="font-bold text-slate-800">
                  {students.find((st: Student) => st.id === submissionToDelete.studentId)?.name || submissionToDelete.studentName || 'ไม่ระบุชื่อ'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">รหัสนักเรียน:</span>
                <span className="font-mono font-bold text-slate-800">{submissionToDelete.studentId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">ชั้น / เลขที่:</span>
                <span className="font-bold text-slate-800">
                  ม.{submissionToDelete.studentClass || submissionToDelete.classGroup} / เลขที่ {submissionToDelete.studentNumber || '-'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">คะแนนปรนัย:</span>
                <span className="font-bold text-emerald-600">{submissionToDelete.mcqScore} คะแนน</span>
              </div>
              {submissionToDelete.confirmationCode && (
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">รหัสยืนยัน:</span>
                  <span className="font-mono text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                    {submissionToDelete.confirmationCode}
                  </span>
                </div>
              )}
            </div>

            <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded-xl text-xs mb-6">
              💡 <strong>คำแนะนำ:</strong> เมื่อลบแล้ว คำตอบและคะแนนเดิมจะถูกล้างออกจากฐานข้อมูล และนักเรียนคนนี้จะสามารถล็อกอินเพื่อ<strong>เข้าสอบใหม่</strong>ได้ทันที
            </div>

            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setSubmissionToDelete(null)} 
                disabled={isDeletingSubmission}
                className="flex-1 py-2.5 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={async () => {
                  setIsDeletingSubmission(true);
                  try {
                    await onDeleteSubmission(submissionToDelete.id);
                    setSubmissionToDelete(null);
                  } finally {
                    setIsDeletingSubmission(false);
                  }
                }} 
                disabled={isDeletingSubmission}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isDeletingSubmission ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {isDeletingSubmission ? 'กำลังลบ...' : 'ยืนยันลบผลสอบ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Multiple Submissions Modal */}
      {submissionsToDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl border border-red-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-14 h-14 bg-red-50 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 size={28} />
            </div>
            <h3 className="text-xl font-bold text-center text-slate-900 mb-2">ลบผลสอบของนักเรียนที่เลือก</h3>
            <p className="text-sm text-slate-600 text-center mb-5">
              คุณต้องการลบผลการสอบของนักเรียนจำนวน{' '}
              <span className="font-bold text-red-600 text-base">{submissionsToDelete.length} คน</span>{' '}
              ออกจากระบบใช่หรือไม่?
            </p>

            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-xs max-h-36 overflow-y-auto mb-4 space-y-1 divide-y divide-slate-100">
              {submissionsToDelete.map(sub => {
                const st = students.find((s: Student) => s.id === sub.studentId);
                return (
                  <div key={sub.id} className="pt-1 first:pt-0 flex justify-between items-center text-slate-700">
                    <div>
                      <span className="font-bold text-slate-800">{st?.name || sub.studentName || sub.studentId}</span>
                      <span className="text-[11px] text-slate-500 ml-1.5">({sub.studentId})</span>
                    </div>
                    <span className="font-bold text-emerald-600">{sub.mcqScore} คะแนน</span>
                  </div>
                );
              })}
            </div>

            <div className="bg-amber-50 border border-amber-200 text-amber-900 p-3 rounded-xl text-xs mb-6">
              💡 <strong>คำแนะนำ:</strong> เมื่อลบแล้ว คำตอบและคะแนนเดิมจะถูกล้างออกจากฐานข้อมูล และนักเรียนกลุ่มนี้จะสามารถล็อกอินเพื่อ<strong>เข้าสอบใหม่</strong>ได้ทันที
            </div>

            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setSubmissionsToDelete(null)} 
                disabled={isDeletingMultiple}
                className="flex-1 py-2.5 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={async () => {
                  setIsDeletingMultiple(true);
                  try {
                    await onDeleteMultipleSubmissions(submissionsToDelete.map(s => s.id));
                    setSubmissionsToDelete(null);
                    setSelectedSubmissions(new Set());
                  } finally {
                    setIsDeletingMultiple(false);
                  }
                }} 
                disabled={isDeletingMultiple}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isDeletingMultiple ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {isDeletingMultiple ? 'กำลังลบ...' : `ยืนยันลบ (${submissionsToDelete.length} คน)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Submissions Modal */}
      {confirmClearAllSubmissions && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 font-sans">
          <div className="bg-white rounded-3xl p-6 sm:p-8 w-full max-w-lg shadow-2xl border border-red-300 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
              <AlertCircle size={36} />
            </div>
            <h3 className="text-2xl font-bold text-center text-slate-900 mb-2">ล้างข้อมูลการสอบของนักเรียนทั้งหมด</h3>
            <p className="text-slate-600 text-center mb-6 text-sm">
              คุณกำลังจะล้างข้อมูลผลการสอบของนักเรียนทั้งหมดจำนวน{' '}
              <span className="font-bold text-red-600 text-base">{submissions.length} รายการ</span>{' '}
              ออกจากฐานข้อมูลกลาง (Cloud Firestore)
            </p>

            <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-xl text-xs text-red-900 space-y-2 mb-6">
              <p className="font-bold text-sm text-red-800">⚠️ ข้อควรระวังอย่างยิ่ง:</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>คะแนน คำตอบอัตนัย และประวัติการทำข้อสอบทั้งหมดจะถูกลบอย่างถาวร</li>
                <li>นักเรียนทุกคนจะสามารถกลับมาเริ่มทำข้อสอบรอบใหม่ได้</li>
                <li>ไม่สามารถเรียกคืนข้อมูลได้ หากยังไม่ได้ดาวน์โหลดไฟล์สำรองข้อมูล</li>
              </ul>
            </div>

            <div className="mb-6">
              <button
                type="button"
                onClick={onDownloadArchiveJSON}
                className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold rounded-xl border border-slate-300 text-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <FileDown size={18} className="text-blue-600" /> แนะนำ: ดาวน์โหลดไฟล์สำรองข้อมูล (JSON) เก็บไว้ก่อน
              </button>
            </div>

            <div className="flex gap-3">
              <button 
                onClick={() => setConfirmClearAllSubmissions(false)} 
                disabled={isClearingAllSubmissions}
                className="flex-1 py-3 border-2 border-slate-200 text-slate-600 font-bold rounded-xl hover:bg-slate-50 transition-all cursor-pointer"
              >
                ยกเลิก
              </button>
              <button 
                onClick={async () => {
                  setIsClearingAllSubmissions(true);
                  try {
                    await onClearAllSubmissions();
                    setConfirmClearAllSubmissions(false);
                    alert('ล้างข้อมูลผลการสอบทั้งหมดเรียบร้อยแล้ว ระบบพร้อมสำหรับการสอบรอบใหม่');
                  } finally {
                    setIsClearingAllSubmissions(false);
                  }
                }} 
                disabled={isClearingAllSubmissions}
                className="flex-1 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isClearingAllSubmissions ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {isClearingAllSubmissions ? 'กำลังล้างข้อมูล...' : 'ยืนยันล้างทั้งหมด'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
