import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  FileSpreadsheet,
  FileText,
  Sparkles,
  Download,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  Plus,
  Loader2,
  ArrowLeft,
  Check,
  AlertCircle,
} from 'lucide-react';
import {
  computeMcqWarnings,
  computeSubjWarnings,
  downloadExamExcelTemplate,
  extractStructuredLinesFromDocx,
  finalizeMcqDrafts,
  finalizeSubjDrafts,
  parseMcqExcelToDrafts,
  parseMcqTextToDrafts,
  parseSubjExcelToDrafts,
  parseSubjTextToDrafts,
  type ExamTypeValue,
  type ParsedMcqDraft,
  type ParsedSubjDraft,
} from '../utils/examImport';
import type { MCQ, Subjective } from '../types';

const THAI_CHOICES = ['ก', 'ข', 'ค', 'ง', 'จ'];

export function ExamImportModal({
  mode,
  courseId,
  courseName,
  defaultClassGroup,
  defaultExamType = 'general',
  initialSource = 'word',
  onClose,
  onConfirmImportMcqs,
  onConfirmImportSubjs,
}: {
  mode: 'mcq' | 'subj';
  courseId: string;
  courseName: string;
  defaultClassGroup: string;
  defaultExamType?: ExamTypeValue;
  initialSource?: 'word' | 'excel' | 'text';
  onClose: () => void;
  onConfirmImportMcqs?: (items: MCQ[]) => void;
  onConfirmImportSubjs?: (items: Subjective[]) => void;
}) {
  const [sourceTab, setSourceTab] = useState<'word' | 'excel' | 'text'>(initialSource);
  const [step, setStep] = useState<'upload' | 'preview'>('upload');

  const [classGroup, setClassGroup] = useState(defaultClassGroup || 'ทั้งหมด');
  const [examType, setExamType] = useState<ExamTypeValue>(defaultExamType);
  const [pasteText, setPasteText] = useState('');

  // Extracted Word content kept in state so user can switch between standard & AI parsing without re-uploading
  const [selectedWordFileName, setSelectedWordFileName] = useState('');
  const [wordStructuredText, setWordStructuredText] = useState('');
  const [wordAiText, setWordAiText] = useState('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState('');
  const [parseError, setParseError] = useState('');
  const [parseSourceNote, setParseSourceNote] = useState('');

  const [mcqDrafts, setMcqDrafts] = useState<ParsedMcqDraft[]>([]);
  const [subjDrafts, setSubjDrafts] = useState<ParsedSubjDraft[]>([]);
  const [showOnlyWarnings, setShowOnlyWarnings] = useState(false);

  const wordInputRef = useRef<HTMLInputElement | null>(null);
  const excelInputRef = useRef<HTMLInputElement | null>(null);

  const callAiParser = async (content: string, sourceLabel: string) => {
    setParseError('');
    setIsProcessing(true);
    setProcessingLabel('AI กำลังวิเคราะห์และจัดระเบียบข้อสอบ + เฉลย...');
    try {
      // Chunk very long content if > 28,000 chars on paragraph boundaries
      const MAX_CHUNK = 28000;
      const chunks: string[] = [];
      if (content.length <= MAX_CHUNK) {
        chunks.push(content);
      } else {
        const lines = content.split('\n');
        let buf = '';
        for (const line of lines) {
          if (buf.length + line.length + 1 > MAX_CHUNK && buf.trim()) {
            chunks.push(buf);
            buf = line;
          } else {
            buf = buf ? `${buf}\n${line}` : line;
          }
        }
        if (buf.trim()) chunks.push(buf);
      }

      const allParsedMcqs: ParsedMcqDraft[] = [];
      const allParsedSubjs: ParsedSubjDraft[] = [];

      for (let i = 0; i < chunks.length; i++) {
        if (chunks.length > 1) {
          setProcessingLabel(`AI กำลังวิเคราะห์ไฟล์ส่วนที่ ${i + 1}/${chunks.length}...`);
        }
        const resp = await fetch('/api/parse-exam', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunks[i], mode }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(data?.error || `เกิดข้อผิดพลาดจากเซิร์ฟเวอร์ (${resp.status})`);
        }
        const items = Array.isArray(data?.questions) ? data.questions : [];
        if (mode === 'mcq') {
          items.forEach((q: any, idx: number) => {
            const opts = Array.isArray(q.options) ? q.options.map(String) : [];
            const cIdx = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
            const detected = Boolean(q.answerDetected);
            allParsedMcqs.push({
              tempId: `ai_mcq_${Date.now()}_${i}_${idx}`,
              text: String(q.text || '').trim(),
              options: opts,
              correctIndex: cIdx,
              answerDetected: detected,
              classGroup: classGroup || 'ทั้งหมด',
              examType,
              warnings: computeMcqWarnings(String(q.text || ''), opts, cIdx, detected),
            });
          });
        } else {
          items.forEach((q: any, idx: number) => {
            const txt = String(q.text || '').trim();
            allParsedSubjs.push({
              tempId: `ai_subj_${Date.now()}_${i}_${idx}`,
              text: txt,
              classGroup: classGroup || 'ทั้งหมด',
              examType,
              warnings: computeSubjWarnings(txt),
            });
          });
        }
      }

      if (mode === 'mcq') {
        if (allParsedMcqs.length === 0) {
          setParseError('AI ไม่พบข้อสอบปรนัยในเอกสารนี้ กรุณาตรวจสอบไฟล์อีกครั้ง');
          return;
        }
        setMcqDrafts(allParsedMcqs);
      } else {
        if (allParsedSubjs.length === 0) {
          setParseError('AI ไม่พบข้อสอบอัตนัยในเอกสารนี้ กรุณาตรวจสอบไฟล์อีกครั้ง');
          return;
        }
        setSubjDrafts(allParsedSubjs);
      }
      setParseSourceNote(`แกะข้อสอบด้วย AI (${sourceLabel})`);
      setShowOnlyWarnings(false);
      setStep('preview');
    } catch (err: any) {
      setParseError(err?.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ AI');
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
    }
  };

  const handleWordFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError('');
    setIsProcessing(true);
    setProcessingLabel('กำลังอ่านโครงสร้างไฟล์ Word (.docx)...');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const { structuredText, aiText } = await extractStructuredLinesFromDocx(arrayBuffer);
      setSelectedWordFileName(file.name);
      setWordStructuredText(structuredText);
      setWordAiText(aiText);

      if (!structuredText.trim()) {
        setParseError('ไฟล์ Word นี้ไม่มีข้อความ (อาจเป็นไฟล์ที่สแกนเป็นรูปภาพทั้งหมด)');
        return;
      }
    } catch (err: any) {
      setParseError(`ไม่สามารถเปิดไฟล์ Word ได้: ${err?.message || 'กรุณาตรวจสอบว่าเป็นไฟล์ .docx ที่ถูกต้อง'}`);
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      e.target.value = '';
    }
  };

  const handleParseWordLocal = () => {
    if (!wordStructuredText.trim()) {
      setParseError('กรุณาเลือกไฟล์ Word (.docx) ก่อน');
      return;
    }
    setParseError('');
    if (mode === 'mcq') {
      const drafts = parseMcqTextToDrafts(wordStructuredText, classGroup, examType);
      if (drafts.length === 0) {
        setParseError(
          'ตัวอ่านปกติไม่พบโครงสร้างข้อสอบในไฟล์นี้ — แนะนำให้กดปุ่ม "✨ ให้ AI ช่วยแกะไฟล์ Word นี้" ด้านขวาแทนครับ',
        );
        return;
      }
      setMcqDrafts(drafts);
    } else {
      const drafts = parseSubjTextToDrafts(wordStructuredText, classGroup, examType);
      if (drafts.length === 0) {
        setParseError('ไม่พบคำถามอัตนัยในไฟล์นี้ ลองกดปุ่ม "✨ ให้ AI ช่วยแกะไฟล์ Word นี้" แทนครับ');
        return;
      }
      setSubjDrafts(drafts);
    }
    setParseSourceNote(`อ่านจากไฟล์ Word: ${selectedWordFileName}`);
    setShowOnlyWarnings(false);
    setStep('preview');
  };

  const handleExcelFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError('');
    setIsProcessing(true);
    setProcessingLabel('กำลังอ่านข้อมูลจากไฟล์ Excel / CSV...');
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (mode === 'mcq') {
        const drafts = parseMcqExcelToDrafts(arrayBuffer, classGroup, examType);
        if (drafts.length === 0) {
          setParseError('ไม่พบแถวข้อสอบในไฟล์ Excel กรุณาใช้หัวคอลัมน์ตามไฟล์แม่แบบ (คำถาม, ตัวเลือก ก-ง, เฉลย)');
          return;
        }
        setMcqDrafts(drafts);
      } else {
        const drafts = parseSubjExcelToDrafts(arrayBuffer, classGroup, examType);
        if (drafts.length === 0) {
          setParseError('ไม่พบแถวคำถามอัตนัยในไฟล์ Excel กรุณาใช้หัวคอลัมน์ "คำถามอัตนัย" ตามไฟล์แม่แบบ');
          return;
        }
        setSubjDrafts(drafts);
      }
      setParseSourceNote(`อ่านจากไฟล์ Excel: ${file.name}`);
      setShowOnlyWarnings(false);
      setStep('preview');
    } catch (err: any) {
      setParseError(`อ่านไฟล์ Excel ไม่สำเร็จ: ${err?.message || 'กรุณาตรวจสอบรูปแบบไฟล์'}`);
    } finally {
      setIsProcessing(false);
      setProcessingLabel('');
      e.target.value = '';
    }
  };

  const handleParsePasteLocal = () => {
    if (!pasteText.trim()) {
      setParseError('กรุณาวางข้อความข้อสอบก่อน');
      return;
    }
    setParseError('');
    if (mode === 'mcq') {
      const drafts = parseMcqTextToDrafts(pasteText, classGroup, examType);
      if (drafts.length === 0) {
        setParseError(
          'ตัวอ่านปกติไม่พบรูปแบบข้อสอบที่ชัดเจน — ลองกดปุ่ม "✨ ให้ AI ช่วยแกะข้อความนี้" แทนได้ครับ',
        );
        return;
      }
      setMcqDrafts(drafts);
    } else {
      const drafts = parseSubjTextToDrafts(pasteText, classGroup, examType);
      if (drafts.length === 0) {
        setParseError('ไม่พบคำถามอัตนัยในข้อความที่วาง');
        return;
      }
      setSubjDrafts(drafts);
    }
    setParseSourceNote('แปลงจากข้อความที่วาง');
    setShowOnlyWarnings(false);
    setStep('preview');
  };

  // --- PREVIEW EDITING HELPERS ---
  const updateMcqDraft = (tempId: string, updater: (d: ParsedMcqDraft) => ParsedMcqDraft) => {
    setMcqDrafts((prev) =>
      prev.map((d) => {
        if (d.tempId !== tempId) return d;
        const next = updater(d);
        return {
          ...next,
          warnings: computeMcqWarnings(next.text, next.options, next.correctIndex, next.answerDetected),
        };
      }),
    );
  };

  const updateSubjDraft = (tempId: string, updater: (d: ParsedSubjDraft) => ParsedSubjDraft) => {
    setSubjDrafts((prev) =>
      prev.map((d) => {
        if (d.tempId !== tempId) return d;
        const next = updater(d);
        return {
          ...next,
          warnings: computeSubjWarnings(next.text),
        };
      }),
    );
  };

  const applyBatchMetaToPreview = (newClass: string, newType: ExamTypeValue) => {
    setClassGroup(newClass);
    setExamType(newType);
    if (mode === 'mcq') {
      setMcqDrafts((prev) => prev.map((d) => ({ ...d, classGroup: newClass || 'ทั้งหมด', examType: newType })));
    } else {
      setSubjDrafts((prev) => prev.map((d) => ({ ...d, classGroup: newClass || 'ทั้งหมด', examType: newType })));
    }
  };

  const handleConfirmSave = () => {
    if (mode === 'mcq' && onConfirmImportMcqs) {
      const finalItems = finalizeMcqDrafts(mcqDrafts, courseId);
      if (finalItems.length === 0) return;
      onConfirmImportMcqs(finalItems);
      onClose();
    } else if (mode === 'subj' && onConfirmImportSubjs) {
      const finalItems = finalizeSubjDrafts(subjDrafts, courseId);
      if (finalItems.length === 0) return;
      onConfirmImportSubjs(finalItems);
      onClose();
    }
  };

  const totalCount = mode === 'mcq' ? mcqDrafts.length : subjDrafts.length;
  const warningCount =
    mode === 'mcq'
      ? mcqDrafts.filter((d) => d.warnings.length > 0).length
      : subjDrafts.filter((d) => d.warnings.length > 0).length;
  const readyCount = totalCount - warningCount;

  const visibleMcqs = showOnlyWarnings ? mcqDrafts.filter((d) => d.warnings.length > 0) : mcqDrafts;
  const visibleSubjs = showOnlyWarnings ? subjDrafts.filter((d) => d.warnings.length > 0) : subjDrafts;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 font-sans">
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl border border-blue-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-blue-900 to-indigo-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-lg sm:text-xl font-bold flex items-center gap-2">
              <Upload size={20} />
              นำเข้าข้อสอบ{mode === 'mcq' ? 'ปรนัย (ช้อยส์)' : 'อัตนัย (ข้อเขียน)'} — วิชา {courseName}
            </h3>
            <p className="text-xs text-blue-100 mt-0.5">
              {step === 'upload'
                ? 'รองรับไฟล์ Word (.docx), Excel แม่แบบ (.xlsx), วางข้อความ และ AI ช่วยแกะไฟล์ พร้อมหน้าตรวจสอบก่อนบันทึก'
                : `${parseSourceNote} • ตรวจสอบและแก้ไขได้ทุกข้อก่อนกดยืนยันบันทึกเข้าคลัง`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-blue-100 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X size={20} />
          </button>
        </div>

        {/* Step 1: Upload / Source Selection */}
        {step === 'upload' && (
          <div className="p-6 overflow-y-auto space-y-5 flex-1">
            {/* Method Tabs */}
            <div className="grid grid-cols-3 gap-2.5 bg-slate-100 p-1.5 rounded-2xl">
              <button
                type="button"
                onClick={() => {
                  setSourceTab('word');
                  setParseError('');
                }}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  sourceTab === 'word'
                    ? 'bg-white text-blue-900 shadow-sm border border-blue-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileText size={16} className="text-blue-600 shrink-0" />
                <span>ไฟล์ Word (.docx)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSourceTab('excel');
                  setParseError('');
                }}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  sourceTab === 'excel'
                    ? 'bg-white text-emerald-900 shadow-sm border border-emerald-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileSpreadsheet size={16} className="text-emerald-600 shrink-0" />
                <span>Excel แม่แบบ (100%)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSourceTab('text');
                  setParseError('');
                }}
                className={`py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  sourceTab === 'text'
                    ? 'bg-white text-indigo-900 shadow-sm border border-indigo-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Sparkles size={16} className="text-indigo-600 shrink-0" />
                <span>วางข้อความ / AI</span>
              </button>
            </div>

            {/* Common Target Class & Exam Type */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-blue-50/50 border border-blue-100 p-4 rounded-2xl">
              <div>
                <label className="block text-xs font-bold text-blue-900 mb-1">
                  ระดับชั้น / ห้องสำหรับข้อสอบชุดนี้
                </label>
                <input
                  type="text"
                  value={classGroup}
                  onChange={(e) => setClassGroup(e.target.value)}
                  placeholder="เช่น 6/3, 6/8 หรือ ทั้งหมด"
                  className="w-full border border-blue-200 bg-white px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-blue-900 mb-1">
                  ประเภทข้อสอบ
                </label>
                <select
                  value={examType}
                  onChange={(e) => setExamType(e.target.value as ExamTypeValue)}
                  className="w-full border border-blue-200 bg-white px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value="general">ทั่วไป (General)</option>
                  <option value="midterm">กลางภาค (Midterm)</option>
                  <option value="final">ปลายภาค (Final)</option>
                </select>
              </div>
            </div>

            {/* TAB 1: WORD (.docx) */}
            {sourceTab === 'word' && (
              <div className="space-y-4">
                <div
                  onClick={() => wordInputRef.current?.click()}
                  className="border-2 border-dashed border-blue-300 hover:border-blue-500 bg-blue-50/40 hover:bg-blue-50 rounded-2xl p-7 text-center cursor-pointer transition-all"
                >
                  <input
                    ref={wordInputRef}
                    type="file"
                    accept=".docx"
                    className="hidden"
                    onChange={handleWordFileSelected}
                  />
                  <div className="w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center mx-auto mb-3 shadow-sm">
                    <FileText size={24} />
                  </div>
                  <div className="font-bold text-blue-950 text-base">
                    {selectedWordFileName
                      ? `เลือกไฟล์แล้ว: ${selectedWordFileName}`
                      : 'คลิกเพื่อเลือกไฟล์ Word (.docx)'}
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 max-w-xl mx-auto">
                    รองรับเลขข้ออัตโนมัติใน Word, เลขไทย (๑. ๒.), ตัวเลือกหลายคอลัมน์ในบรรทัดเดียวกัน (ก. ... ข. ...),
                    เฉลยแบบตัวหนา/ขีดเส้นใต้/ดอกจัน `*`, ตอบ/เฉลยใต้ข้อ และตารางเฉลยท้ายไฟล์
                  </p>
                </div>

                {selectedWordFileName && wordStructuredText && (
                  <div className="p-4 rounded-2xl bg-emerald-50/70 border border-emerald-200 space-y-3">
                    <div className="flex items-center justify-between gap-2 text-xs text-emerald-900">
                      <span className="font-bold flex items-center gap-1.5">
                        <CheckCircle2 size={16} className="text-emerald-600" />
                        อ่านไฟล์สำเร็จ ({wordStructuredText.length.toLocaleString()} ตัวอักษร) — เลือกวิธีแปลงข้อสอบ:
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={handleParseWordLocal}
                        className="py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:opacity-50"
                      >
                        <FileText size={17} />
                        อ่านข้อสอบอัตโนมัติ (รวดเร็ว)
                      </button>
                      <button
                        type="button"
                        disabled={isProcessing}
                        onClick={() => callAiParser(wordAiText || wordStructuredText, selectedWordFileName)}
                        className="py-3 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-sm cursor-pointer disabled:opacity-50"
                      >
                        <Sparkles size={17} />
                        ให้ AI ช่วยแกะไฟล์ Word นี้ (แม่นยำสูง)
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-600">
                      💡 <strong>คำแนะนำ:</strong> ถ้าไฟล์ Word จัดหน้าปกติกด <strong>"อ่านข้อสอบอัตโนมัติ"</strong> ได้เลย (ฟรีและทันที) แต่ถ้าไฟล์จัดหน้าซับซ้อน มีตาราง หรือเฉลยหลายแบบ กด <strong>"ให้ AI ช่วยแกะไฟล์"</strong> แล้วค่อยตรวจทานในหน้า Preview ครับ
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: EXCEL (.xlsx / .csv) */}
            {sourceTab === 'excel' && (
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-emerald-950 text-sm flex items-center gap-1.5">
                      <CheckCircle2 size={16} className="text-emerald-600" />
                      วิธีที่เสถียรที่สุด 100% — เหมาะสำหรับข้อสอบจำนวนมาก (50–200 ข้อ)
                    </div>
                    <p className="text-xs text-emerald-800 mt-0.5">
                      ดาวน์โหลดไฟล์แม่แบบ Excel กรอกคำถาม–ตัวเลือก–เฉลยตามคอลัมน์ แล้วอัปโหลดกลับมา ไม่มีปัญหาการจัดหน้าเพี้ยนแน่นอน
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => downloadExamExcelTemplate(mode, classGroup)}
                    className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm flex items-center justify-center gap-1.5 shadow-sm cursor-pointer shrink-0"
                  >
                    <Download size={16} />
                    ดาวน์โหลดแม่แบบ (.xlsx)
                  </button>
                </div>

                <div
                  onClick={() => excelInputRef.current?.click()}
                  className="border-2 border-dashed border-emerald-300 hover:border-emerald-500 bg-emerald-50/30 hover:bg-emerald-50/60 rounded-2xl p-8 text-center cursor-pointer transition-all"
                >
                  <input
                    ref={excelInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleExcelFileSelected}
                  />
                  <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white flex items-center justify-center mx-auto mb-3 shadow-sm">
                    <FileSpreadsheet size={24} />
                  </div>
                  <div className="font-bold text-emerald-950 text-base">
                    คลิกเพื่ออัปโหลดไฟล์ Excel (.xlsx / .xls / .csv)
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {mode === 'mcq'
                      ? 'คอลัมน์ที่รองรับ: คำถาม | ตัวเลือก ก | ตัวเลือก ข | ตัวเลือก ค | ตัวเลือก ง | ตัวเลือก จ | เฉลย | ระดับชั้น/ห้อง | ประเภท'
                      : 'คอลัมน์ที่รองรับ: คำถามอัตนัย | ระดับชั้น/ห้อง | ประเภท'}
                  </p>
                </div>
              </div>
            )}

            {/* TAB 3: PASTE TEXT + AI */}
            {sourceTab === 'text' && (
              <div className="space-y-3">
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 p-3 rounded-xl">
                  วางข้อสอบที่คัดลอกมาจาก Word, PDF, Google Docs หรือ LINE ได้เลย (หากข้อความจัดหน้าไม่เป็นระเบียบ ให้กดปุ่ม <strong>"ให้ AI ช่วยแกะข้อความ"</strong>)
                </div>
                <textarea
                  rows={9}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={
                    mode === 'mcq'
                      ? 'ตัวอย่าง:\n1. ข้อใดคือความหมายของประชาธิปไตย?\nก. การปกครองโดยประชาชน   ข. การปกครองโดยบุคคลเดียว\nค. การปกครองโดยไร้กฎหมาย   ง. การปกครองโดยทหาร\nตอบ: ก'
                      : 'ตัวอย่าง:\n1. ให้นักเรียนอธิบายความสำคัญของรัฐธรรมนูญ\n2. ยกตัวอย่างการมีส่วนร่วมทางการเมืองของเยาวชน'
                  }
                  className="w-full border border-blue-200 rounded-xl p-3.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 font-sans"
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={isProcessing || !pasteText.trim()}
                    onClick={handleParsePasteLocal}
                    className="py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
                  >
                    <FileText size={16} /> แปลงข้อความอัตโนมัติ (เร็ว)
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing || !pasteText.trim()}
                    onClick={() => callAiParser(pasteText, 'ข้อความที่วาง')}
                    className="py-2.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-bold text-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
                  >
                    <Sparkles size={16} /> ให้ AI ช่วยแกะข้อความนี้
                  </button>
                </div>
              </div>
            )}

            {/* Loading Indicator */}
            {isProcessing && (
              <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-900 flex items-center justify-center gap-3 text-sm font-bold">
                <Loader2 size={20} className="animate-spin text-indigo-600" />
                <span>{processingLabel || 'กำลังประมวลผล...'}</span>
              </div>
            )}

            {/* Error Alert */}
            {parseError && (
              <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs sm:text-sm flex items-start gap-2.5">
                <AlertCircle size={18} className="shrink-0 mt-0.5 text-red-600" />
                <div className="font-medium leading-relaxed">{parseError}</div>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Interactive Preview & Inline Repair */}
        {step === 'preview' && (
          <>
            {/* Preview Toolbar */}
            <div className="px-6 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('upload')}
                  className="px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 text-xs font-bold flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft size={14} /> กลับไปเลือกไฟล์ใหม่
                </button>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-blue-100 text-blue-900">
                  พบทั้งหมด {totalCount} ข้อ
                </span>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800">
                  ✅ สมบูรณ์ {readyCount} ข้อ
                </span>
                {warningCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowOnlyWarnings((v) => !v)}
                    className={`text-xs font-bold px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
                      showOnlyWarnings
                        ? 'bg-amber-600 text-white border-amber-700'
                        : 'bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200'
                    }`}
                  >
                    ⚠️ ต้องตรวจสอบ {warningCount} ข้อ {showOnlyWarnings ? '(กำลังกรอง)' : '(คลิกเพื่อกรอง)'}
                  </button>
                )}
              </div>

              {/* Quick Batch Meta Update */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  type="text"
                  value={classGroup}
                  onChange={(e) => applyBatchMetaToPreview(e.target.value, examType)}
                  placeholder="ห้องทั้งหมด"
                  title="เปลี่ยนระดับชั้นให้ทุกข้อในรายการ"
                  className="w-28 border border-blue-200 bg-white px-2.5 py-1 rounded-lg font-medium"
                />
                <select
                  value={examType}
                  onChange={(e) => applyBatchMetaToPreview(classGroup, e.target.value as ExamTypeValue)}
                  title="เปลี่ยนประเภทข้อสอบให้ทุกข้อในรายการ"
                  className="border border-blue-200 bg-white px-2.5 py-1 rounded-lg font-medium"
                >
                  <option value="general">ทั่วไป</option>
                  <option value="midterm">กลางภาค</option>
                  <option value="final">ปลายภาค</option>
                </select>
                {sourceTab === 'word' && wordAiText && !parseSourceNote.includes('AI') && (
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => callAiParser(wordAiText, selectedWordFileName)}
                    className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold flex items-center gap-1 cursor-pointer"
                  >
                    <Sparkles size={13} /> ลองให้ AI แกะใหม่
                  </button>
                )}
              </div>
            </div>

            {/* Preview Question Cards */}
            <div className="p-6 overflow-y-auto space-y-4 flex-1 bg-slate-50/70">
              {mode === 'mcq' &&
                visibleMcqs.map((draft) => {
                  const origIdx = mcqDrafts.findIndex((d) => d.tempId === draft.tempId);
                  const hasWarn = draft.warnings.length > 0;
                  return (
                    <div
                      key={draft.tempId}
                      className={`bg-white rounded-2xl p-4 border-2 shadow-2xs space-y-3 ${
                        hasWarn ? 'border-amber-300 bg-amber-50/20' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold px-2.5 py-0.5 rounded-lg bg-blue-100 text-blue-900">
                            ข้อที่ {origIdx + 1}
                          </span>
                          {hasWarn ? (
                            draft.warnings.map((w, wi) => (
                              <span
                                key={wi}
                                className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1"
                              >
                                <AlertTriangle size={12} /> {w}
                              </span>
                            ))
                          ) : (
                            <span className="text-[11px] font-bold text-emerald-700 flex items-center gap-1">
                              <CheckCircle2 size={13} /> พร้อมนำเข้า
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setMcqDrafts((prev) => prev.filter((x) => x.tempId !== draft.tempId))}
                          className="p-1.5 text-slate-400 hover:text-red-600 cursor-pointer"
                          title="ลบข้อนี้ออกจากรายการนำเข้า"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>

                      {/* Question Text */}
                      <textarea
                        rows={2}
                        value={draft.text}
                        onChange={(e) =>
                          updateMcqDraft(draft.tempId, (d) => ({ ...d, text: e.target.value }))
                        }
                        className="w-full border border-slate-200 focus:border-blue-400 rounded-xl p-2.5 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      />

                      {/* Options + Inline Answer Selection */}
                      <div className="space-y-1.5">
                        <div className="text-[11px] font-bold text-slate-500">
                          คลิกปุ่ม ก/ข/ค/ง/จ ด้านซ้ายเพื่อกำหนดเฉลยที่ถูกต้อง:
                        </div>
                        {draft.options.map((opt, oIdx) => {
                          const isCorrect = draft.correctIndex === oIdx;
                          return (
                            <div key={oIdx} className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  updateMcqDraft(draft.tempId, (d) => ({
                                    ...d,
                                    correctIndex: oIdx,
                                    answerDetected: true,
                                  }))
                                }
                                className={`w-9 h-9 rounded-lg font-bold text-xs border flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
                                  isCorrect
                                    ? 'bg-emerald-600 text-white border-emerald-700 shadow-2xs'
                                    : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-emerald-50'
                                }`}
                                title="ตั้งเป็นเฉลยที่ถูกต้อง"
                              >
                                {isCorrect ? <Check size={14} /> : THAI_CHOICES[oIdx] || oIdx + 1}
                              </button>
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) =>
                                  updateMcqDraft(draft.tempId, (d) => {
                                    const nextOpts = [...d.options];
                                    nextOpts[oIdx] = e.target.value;
                                    return { ...d, options: nextOpts };
                                  })
                                }
                                className={`flex-1 border px-3 py-1.5 rounded-lg text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 ${
                                  isCorrect ? 'border-emerald-300 bg-emerald-50/40 font-semibold' : 'border-slate-200'
                                }`}
                              />
                              {draft.options.length > 2 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateMcqDraft(draft.tempId, (d) => {
                                      const nextOpts = d.options.filter((_, idx) => idx !== oIdx);
                                      return {
                                        ...d,
                                        options: nextOpts,
                                        correctIndex: Math.min(d.correctIndex, nextOpts.length - 1),
                                      };
                                    })
                                  }
                                  className="p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                                  title="ลบตัวเลือกนี้"
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                        {draft.options.length < 5 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateMcqDraft(draft.tempId, (d) => ({
                                ...d,
                                options: [...d.options, ''],
                              }))
                            }
                            className="text-xs font-bold text-blue-600 hover:text-blue-800 flex items-center gap-1 pt-1 cursor-pointer"
                          >
                            <Plus size={14} /> เพิ่มตัวเลือก ({THAI_CHOICES[draft.options.length]})
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}

              {mode === 'subj' &&
                visibleSubjs.map((draft) => {
                  const origIdx = subjDrafts.findIndex((d) => d.tempId === draft.tempId);
                  return (
                    <div
                      key={draft.tempId}
                      className="bg-white rounded-2xl p-4 border-2 border-slate-200 shadow-2xs space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold px-2.5 py-0.5 rounded-lg bg-blue-100 text-blue-900">
                          อัตนัยข้อที่ {origIdx + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => setSubjDrafts((prev) => prev.filter((x) => x.tempId !== draft.tempId))}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <textarea
                        rows={3}
                        value={draft.text}
                        onChange={(e) =>
                          updateSubjDraft(draft.tempId, (d) => ({ ...d, text: e.target.value }))
                        }
                        className="w-full border border-slate-200 focus:border-blue-400 rounded-xl p-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
                      />
                    </div>
                  );
                })}

              {totalCount === 0 && (
                <div className="text-center py-12 text-slate-400 text-sm">
                  ไม่มีข้อสอบในรายการนำเข้า กด "กลับไปเลือกไฟล์ใหม่" เพื่อเริ่มต้นใหม่
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="px-6 py-4 bg-white border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="text-xs text-slate-500">
                {warningCount > 0 ? (
                  <span className="text-amber-700 font-bold">
                    ⚠️ มี {warningCount} ข้อที่แจ้งเตือน (สามารถแก้ไขด้านบนหรือกดนำเข้าแล้วค่อยแก้ในคลังได้)
                  </span>
                ) : (
                  <span className="text-emerald-700 font-bold">
                    ✅ ข้อสอบทั้งหมด {totalCount} ข้อสมบูรณ์พร้อมบันทึกเข้าคลัง
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 font-bold text-sm hover:bg-slate-50 cursor-pointer"
                >
                  ยกเลิก
                </button>
                <button
                  type="button"
                  disabled={totalCount === 0}
                  onClick={handleConfirmSave}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer disabled:opacity-40"
                >
                  <CheckCircle2 size={17} />
                  ยืนยันนำเข้า {totalCount} ข้อเข้าคลัง
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
