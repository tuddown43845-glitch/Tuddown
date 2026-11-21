import React, { useMemo, useState } from 'react';
import {
  X,
  CheckCircle2,
  Copy,
  Trash2,
  AlertTriangle,
  Sparkles,
  Check,
  Loader2,
} from 'lucide-react';
import { findDuplicateQuestionGroups } from '../utils/examImport';
import type { MCQ, Subjective } from '../types';

const THAI_CHOICES = ['ก', 'ข', 'ค', 'ง', 'จ'];

export function DuplicateScannerModal({
  mode,
  courseName,
  mcqs = [],
  subjs = [],
  activeExamIdSet,
  onDeleteIds,
  onClose,
}: {
  mode: 'mcq' | 'subj';
  courseName: string;
  mcqs?: MCQ[];
  subjs?: Subjective[];
  activeExamIdSet: Set<string>;
  onDeleteIds: (ids: string[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const [filterMode, setFilterMode] = useState<'all' | 'exact' | 'similar'>('all');
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [isCleaningAll, setIsCleaningAll] = useState(false);

  const mcqGroups = useMemo(
    () => (mode === 'mcq' ? findDuplicateQuestionGroups<MCQ>(mcqs, 0.86) : []),
    [mode, mcqs],
  );

  const subjGroups = useMemo(
    () => (mode === 'subj' ? findDuplicateQuestionGroups<Subjective>(subjs, 0.86) : []),
    [mode, subjs],
  );

  const allGroups = mode === 'mcq' ? mcqGroups : subjGroups;
  const exactGroups = allGroups.filter((g) => g.matchType === 'exact');
  const similarGroups = allGroups.filter((g) => g.matchType === 'similar');

  const visibleGroups =
    filterMode === 'exact'
      ? exactGroups
      : filterMode === 'similar'
        ? similarGroups
        : allGroups;

  // Compute redundant exact duplicate IDs (keep 1 per exact group, preferring one already selected for exam)
  const redundantExactIds = useMemo(() => {
    const idsToDelete: string[] = [];
    exactGroups.forEach((group) => {
      const sorted = [...group.items].sort((a, b) => {
        const aSelected = activeExamIdSet.has(a.item.id) ? 0 : 1;
        const bSelected = activeExamIdSet.has(b.item.id) ? 0 : 1;
        if (aSelected !== bSelected) return aSelected - bSelected;
        return a.bankIndex - b.bankIndex;
      });
      // Keep sorted[0], delete the rest
      sorted.slice(1).forEach((entry) => idsToDelete.push(entry.item.id));
    });
    return idsToDelete;
  }, [exactGroups, activeExamIdSet]);

  const handleDeleteSingle = async (id: string) => {
    setDeletingIds((prev) => new Set(prev).add(id));
    try {
      await onDeleteIds([id]);
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleCleanAllExact = async () => {
    if (redundantExactIds.length === 0) return;
    setIsCleaningAll(true);
    try {
      await onDeleteIds(redundantExactIds);
    } finally {
      setIsCleaningAll(false);
    }
  };

  const examTypeLabel = (t?: string) =>
    t === 'midterm' ? 'กลางภาค' : t === 'final' ? 'ปลายภาค' : 'ทั่วไป';

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 font-sans">
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl border border-purple-200 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-gradient-to-r from-purple-900 via-indigo-900 to-blue-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-lg sm:text-xl font-bold flex items-center gap-2">
              <Copy size={20} />
              ตรวจสอบข้อสอบซ้ำ ({mode === 'mcq' ? 'ปรนัย' : 'อัตนัย'}) — วิชา {courseName}
            </h3>
            <p className="text-xs text-purple-100 mt-0.5">
              สแกนทั้งข้อสอบที่ซ้ำกัน 100% (แม้เว้นวรรคหรือจัดรูปแบบต่างกัน) และข้อที่คล้ายกันมาก (&ge; 86%)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-purple-100 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X size={20} />
          </button>
        </div>

        {/* Summary & Quick Clean Bar */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer transition-colors ${
                filterMode === 'all'
                  ? 'bg-slate-800 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
              }`}
            >
              ทั้งหมด ({allGroups.length} กลุ่ม)
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('exact')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer transition-colors ${
                filterMode === 'exact'
                  ? 'bg-red-600 text-white border-red-700'
                  : 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
              }`}
            >
              🔴 ซ้ำ 100% ({exactGroups.length} กลุ่ม)
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('similar')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border cursor-pointer transition-colors ${
                filterMode === 'similar'
                  ? 'bg-amber-600 text-white border-amber-700'
                  : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
              }`}
            >
              🟡 คล้ายกันมาก ({similarGroups.length} กลุ่ม)
            </button>
          </div>

          {redundantExactIds.length > 0 && (
            <button
              type="button"
              disabled={isCleaningAll}
              onClick={handleCleanAllExact}
              className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs sm:text-sm flex items-center gap-2 shadow-sm cursor-pointer disabled:opacity-50"
            >
              {isCleaningAll ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Trash2 size={15} />
              )}
              ลบข้อที่ซ้ำ 100% ออกทั้งหมด ({redundantExactIds.length} ข้อ — เก็บไว้กลุ่มละ 1 ข้อ)
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-5 bg-slate-50/60">
          {allGroups.length === 0 ? (
            <div className="bg-white rounded-2xl border-2 border-emerald-200 p-10 text-center max-w-lg mx-auto my-6 shadow-xs">
              <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 size={36} />
              </div>
              <h4 className="text-xl font-bold text-emerald-950 mb-1">
                ยอดเยี่ยม! ไม่พบข้อสอบซ้ำในคลังนี้เลย
              </h4>
              <p className="text-sm text-slate-600">
                ข้อสอบทั้งหมด {mode === 'mcq' ? mcqs.length : subjs.length} ข้อในรายวิชา {courseName} ไม่มีข้อความที่ซ้ำกันหรือคล้ายกันจนน่าสงสัยครับ
              </p>
            </div>
          ) : visibleGroups.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">
              ไม่พบรายการในตัวกรองนี้
            </div>
          ) : (
            visibleGroups.map((group, gIdx) => {
              const isExact = group.matchType === 'exact';
              return (
                <div
                  key={group.groupId}
                  className={`bg-white rounded-2xl border-2 overflow-hidden shadow-2xs ${
                    isExact ? 'border-red-200' : 'border-amber-200'
                  }`}
                >
                  <div
                    className={`px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-bold ${
                      isExact
                        ? 'bg-red-50 text-red-900 border-b border-red-200'
                        : 'bg-amber-50 text-amber-900 border-b border-amber-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {isExact ? <AlertTriangle size={15} className="text-red-600" /> : <Sparkles size={15} className="text-amber-600" />}
                      <span>
                        กลุ่มที่ {gIdx + 1}:{' '}
                        {isExact
                          ? `ซ้ำกัน 100% จำนวน ${group.items.length} ข้อ`
                          : `ข้อความคล้ายกันประมาณ ${Math.round(group.similarity * 100)}% (${group.items.length} ข้อ)`}
                      </span>
                    </div>
                    <span className="font-normal opacity-80">
                      แนะนำให้เก็บไว้ 1 ข้อ แล้วลบข้อที่เหลือออก
                    </span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {group.items.map((entry, eIdx) => {
                      const isSelectedInExam = activeExamIdSet.has(entry.item.id);
                      const isDeleting = deletingIds.has(entry.item.id);
                      const mcqItem = mode === 'mcq' ? (entry.item as MCQ) : null;

                      return (
                        <div
                          key={entry.item.id}
                          className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                        >
                          <div className="flex-1 min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                              <span className="font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-900">
                                ข้อที่ {entry.bankIndex + 1} ในคลัง
                              </span>
                              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                                ห้อง: {(entry.item as any).classGroup || 'ทั้งหมด'}
                              </span>
                              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                                {examTypeLabel((entry.item as any).examType)}
                              </span>
                              {isSelectedInExam && (
                                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200 font-bold flex items-center gap-1">
                                  <Check size={12} /> ถูกเลือกออกสอบอยู่
                                </span>
                              )}
                              {eIdx === 0 && (
                                <span className="px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold">
                                  ต้นฉบับแรก
                                </span>
                              )}
                            </div>

                            <div className="text-sm font-medium text-slate-800 whitespace-pre-wrap break-words">
                              {entry.item.text}
                            </div>

                            {mcqItem && Array.isArray(mcqItem.options) && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 pt-1">
                                {mcqItem.options.map((opt, oIdx) => (
                                  <div
                                    key={oIdx}
                                    className={`text-xs px-2.5 py-1 rounded-lg border ${
                                      mcqItem.correctIndex === oIdx
                                        ? 'bg-emerald-50 border-emerald-300 text-emerald-900 font-bold'
                                        : 'bg-slate-50 border-slate-200 text-slate-600'
                                    }`}
                                  >
                                    {THAI_CHOICES[oIdx] || oIdx + 1}. {opt}
                                    {mcqItem.correctIndex === oIdx && ' ✓'}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <button
                            type="button"
                            disabled={isDeleting || isCleaningAll}
                            onClick={() => handleDeleteSingle(entry.item.id)}
                            className="px-3.5 py-2 rounded-xl bg-red-50 hover:bg-red-600 text-red-700 hover:text-white border border-red-200 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                          >
                            {isDeleting ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                            ลบข้อนี้
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-white border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-slate-500">
            * ระบบจะไม่ลบข้อสอบต้นฉบับออกทั้งหมดโดยอัตโนมัติ (ปุ่มลบอัตโนมัติจะเก็บไว้ 1 ข้อเสมอ และจะเลือกเก็บข้อที่ถูกติ๊กออกสอบอยู่ก่อน)
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-bold text-sm cursor-pointer shrink-0"
          >
            ปิดหน้าต่าง
          </button>
        </div>
      </div>
    </div>
  );
}
