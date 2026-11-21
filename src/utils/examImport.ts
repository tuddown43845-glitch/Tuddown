import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import type { MCQ, Subjective } from '../types';

export type ExamTypeValue = 'general' | 'midterm' | 'final';

export interface ParsedMcqDraft {
  tempId: string;
  text: string;
  options: string[];
  correctIndex: number;
  answerDetected: boolean;
  classGroup: string;
  examType: ExamTypeValue;
  warnings: string[];
}

export interface ParsedSubjDraft {
  tempId: string;
  text: string;
  classGroup: string;
  examType: ExamTypeValue;
  warnings: string[];
}

const THAI_DIGITS: Record<string, string> = {
  '๐': '0',
  '๑': '1',
  '๒': '2',
  '๓': '3',
  '๔': '4',
  '๕': '5',
  '๖': '6',
  '๗': '7',
  '๘': '8',
  '๙': '9',
};

const CHAR_TO_INDEX: Record<string, number> = {
  'ก': 0,
  'ข': 1,
  'ค': 2,
  'ง': 3,
  'จ': 4,
  a: 0,
  b: 1,
  c: 2,
  d: 3,
  e: 4,
  '1': 0,
  '2': 1,
  '3': 2,
  '4': 3,
  '5': 4,
};

const THAI_OPTION_LABELS = ['ก', 'ข', 'ค', 'ง', 'จ'];

export const convertThaiDigits = (str: string): string =>
  str.replace(/[๐-๙]/g, (ch) => THAI_DIGITS[ch] ?? ch);

export const cleanInvisibleChars = (str: string): string =>
  str
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n');

const createTempId = (prefix: string, idx: number) =>
  `${prefix}_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;

export const computeMcqWarnings = (
  text: string,
  options: string[],
  correctIndex: number,
  answerDetected: boolean,
): string[] => {
  const warnings: string[] = [];
  if (!text.trim() || text.trim().length < 4) {
    warnings.push('ข้อความโจทย์สั้นผิดปกติ');
  }
  const nonEmptyOpts = options.filter((o) => o.trim().length > 0);
  if (nonEmptyOpts.length < 4) {
    warnings.push(`พบตัวเลือกเพียง ${nonEmptyOpts.length} ข้อ (แนะนำ 4-5 ข้อ)`);
  }
  if (!answerDetected) {
    warnings.push('ไม่พบเฉลยในไฟล์ (ตั้งค่าเริ่มต้นเป็น ก. กรุณาตรวจสอบ)');
  } else if (correctIndex < 0 || correctIndex >= nonEmptyOpts.length) {
    warnings.push('ตำแหน่งเฉลยไม่ตรงกับจำนวนตัวเลือก');
  }
  return warnings;
};

export const computeSubjWarnings = (text: string): string[] => {
  const warnings: string[] = [];
  if (!text.trim() || text.trim().length < 6) {
    warnings.push('ข้อความคำถามสั้นผิดปกติ');
  }
  return warnings;
};

/**
 * Extract structured text from a Word (.docx) file using mammoth.convertToHtml()
 * + safe in-memory DOMParser so that:
 * 1. Word Auto-Numbering (<ol><li>) is preserved as explicit `1.` / `ก.` prefixes!
 * 2. Bold / underlined / highlighted options are tagged with [ANS_HINT] so the parser
 *    can automatically detect answer keys styled in bold/underline/highlight!
 * 3. Tables are extracted cleanly row-by-row.
 */
export async function extractStructuredLinesFromDocx(
  arrayBuffer: ArrayBuffer,
): Promise<{ structuredText: string; aiText: string }> {
  const [htmlResult, rawResult] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer }),
    mammoth.extractRawText({ arrayBuffer }),
  ]);

  const html = htmlResult.value || '';
  if (!html.trim() || typeof DOMParser === 'undefined') {
    const fallback = cleanInvisibleChars(rawResult.value || '');
    return { structuredText: fallback, aiText: fallback };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) {
    const fallback = cleanInvisibleChars(rawResult.value || '');
    return { structuredText: fallback, aiText: fallback };
  }

  const lines: string[] = [];
  const aiLines: string[] = [];

  const getInlineText = (node: Node, annotateStyleForAi: boolean): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '\n';

    let inner = '';
    el.childNodes.forEach((child) => {
      inner += getInlineText(child, annotateStyleForAi);
    });

    if (annotateStyleForAi && inner.trim()) {
      if (tag === 'strong' || tag === 'b') return `[BOLD]${inner}[/BOLD]`;
      if (tag === 'u') return `[UNDERLINE]${inner}[/UNDERLINE]`;
      if (tag === 'mark') return `[MARK]${inner}[/MARK]`;
    }
    return inner;
  };

  // Detect if almost the entire element text is emphasized (common way teachers mark correct choice in Word)
  const isWholeBlockEmphasized = (el: HTMLElement): boolean => {
    const fullText = cleanInvisibleChars(el.textContent || '').trim();
    if (!fullText || fullText.length > 260) return false;
    const emphasizedNodes = el.querySelectorAll('strong, b, u, mark');
    if (emphasizedNodes.length === 0) return false;
    let emphasizedLen = 0;
    emphasizedNodes.forEach((n) => {
      // Avoid double counting nested <strong><u>...</u></strong>
      if (!n.parentElement?.closest('strong, b, u, mark')) {
        emphasizedLen += cleanInvisibleChars(n.textContent || '').trim().length;
      }
    });
    return emphasizedLen / fullText.length >= 0.7;
  };

  let autoQuestionCounter = 1;

  const walkBlock = (el: HTMLElement, listDepth = 0) => {
    const tag = el.tagName.toLowerCase();

    if (tag === 'ol' || tag === 'ul') {
      let itemIndex = 0;
      Array.from(el.children).forEach((child) => {
        if (child.tagName.toLowerCase() !== 'li') return;
        const liEl = child as HTMLElement;
        const childLists = Array.from(liEl.children).filter((c) => {
          const ct = c.tagName.toLowerCase();
          return ct === 'ol' || ct === 'ul';
        });

        // Clone text excluding nested lists
        let ownText = '';
        let ownAiText = '';
        let ownEmphasizedLen = 0;
        liEl.childNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const nt = (node as HTMLElement).tagName.toLowerCase();
            if (nt === 'ol' || nt === 'ul') return;
            if (nt === 'strong' || nt === 'b' || nt === 'u' || nt === 'mark') {
              ownEmphasizedLen += cleanInvisibleChars(node.textContent || '').trim().length;
            }
          }
          ownText += getInlineText(node, false);
          ownAiText += getInlineText(node, true);
        });

        const cleanOwn = cleanInvisibleChars(ownText).trim();
        const cleanAi = cleanInvisibleChars(ownAiText).trim();
        const isBoldChoice =
          cleanOwn.length > 0 &&
          (ownEmphasizedLen / cleanOwn.length >= 0.7 || (childLists.length === 0 && isWholeBlockEmphasized(liEl)));

        if (cleanOwn) {
          const alreadyHasQPrefix = /^(?:ข้อ\s*(?:ที่)?\s*)?[0-9๐-๙]+\s*[\.\)\]]/.test(cleanOwn);
          const alreadyHasOptPrefix = /^(?:\*?\s*)?(?:\(|\[)?[กขคงจa-eA-E]\s*[\.\)\]]/.test(cleanOwn);

          if (listDepth === 0 && tag === 'ol') {
            if (alreadyHasQPrefix || alreadyHasOptPrefix) {
              lines.push(cleanOwn);
              aiLines.push(cleanAi);
            } else {
              lines.push(`${autoQuestionCounter}. ${cleanOwn}`);
              aiLines.push(`${autoQuestionCounter}. ${cleanAi}`);
              autoQuestionCounter++;
            }
          } else if (listDepth >= 1 && itemIndex < THAI_OPTION_LABELS.length) {
            const label = THAI_OPTION_LABELS[itemIndex];
            const star = isBoldChoice ? '*' : '';
            if (alreadyHasOptPrefix) {
              lines.push(`${star}${cleanOwn}`);
              aiLines.push(cleanAi);
            } else {
              lines.push(`${star}${label}. ${cleanOwn}`);
              aiLines.push(`${label}. ${cleanAi}`);
            }
          } else {
            lines.push(cleanOwn);
            aiLines.push(cleanAi);
          }
        }

        childLists.forEach((nested) => walkBlock(nested as HTMLElement, listDepth + 1));
        itemIndex++;
      });
      return;
    }

    if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr'));
      rows.forEach((tr) => {
        const cells = Array.from(tr.children).map((td) =>
          cleanInvisibleChars(getInlineText(td, false)).replace(/\s+/g, ' ').trim(),
        );
        const aiCells = Array.from(tr.children).map((td) =>
          cleanInvisibleChars(getInlineText(td, true)).replace(/\s+/g, ' ').trim(),
        );
        const nonEmpty = cells.filter(Boolean);
        if (nonEmpty.length > 0) {
          lines.push(nonEmpty.join('\t'));
          aiLines.push(aiCells.filter(Boolean).join('\t'));
        }
      });
      return;
    }

    if (tag === 'p' || tag === 'div' || /^h[1-6]$/.test(tag)) {
      // If a div wraps block children, recurse
      if (
        tag === 'div' &&
        Array.from(el.children).some((c) =>
          ['p', 'div', 'ol', 'ul', 'table', 'h1', 'h2', 'h3', 'h4'].includes(c.tagName.toLowerCase()),
        )
      ) {
        Array.from(el.children).forEach((c) => walkBlock(c as HTMLElement, listDepth));
        return;
      }

      const rawText = cleanInvisibleChars(getInlineText(el, false)).trim();
      const rawAi = cleanInvisibleChars(getInlineText(el, true)).trim();
      if (!rawText) return;

      const isEmphasized = isWholeBlockEmphasized(el);
      const subLines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
      const aiSubLines = rawAi.split('\n').map((l) => l.trim()).filter(Boolean);

      subLines.forEach((sub, idx) => {
        // Only tag as bold-answer hint if the line looks like an option (not a bold question heading!)
        const looksLikeOption = /^(?:\*?\s*)?(?:\(|\[)?([กขคงจa-eA-E])[\.\)\]]/.test(sub);
        if (isEmphasized && looksLikeOption && !sub.startsWith('*')) {
          lines.push(`*${sub}`);
        } else {
          lines.push(sub);
        }
        aiLines.push(aiSubLines[idx] ?? sub);
      });
      return;
    }

    Array.from(el.children).forEach((c) => walkBlock(c as HTMLElement, listDepth));
  };

  Array.from(root.children).forEach((c) => walkBlock(c as HTMLElement, 0));

  return {
    structuredText: lines.join('\n'),
    aiText: aiLines.join('\n'),
  };
}

/**
 * Split a single line that contains multiple inline options (e.g. "ก. 10   ข. 20   ค. 30   ง. 40")
 * into separate lines so two-column or tabbed Word choices parse cleanly!
 */
const splitInlineMultipleOptions = (line: string): string[] => {
  // Split before option markers preceded by tab or 2+ spaces: e.g. "  ข." or "\tค." or "  *ง." or "  B."
  const splitRegex = /(?:\t|\s{2,})(?=(?:\*\s*)?(?:\(|\[)?(?:[กขคงจ]|[A-Ea-e])[\.\)\]]\s*)/g;
  const parts = line
    .split(splitRegex)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    // Verify at least 2 parts actually look like options so we don't split normal prose
    const optLikeCount = parts.filter((p) =>
      /^(?:\*\s*)?(?:\(|\[)?(?:[กขคงจ]|[A-Ea-e])[\.\)\]]/.test(p),
    ).length;
    if (optLikeCount >= 2) {
      return parts;
    }
  }
  return [line];
};

/**
 * Parse end-of-document answer key summary such as:
 * "เฉลย: 1. ก  2. ข  3. ค" or "1-ก, 2-ข, 3-ค"
 */
const extractAnswerKeyMap = (lines: string[]): Map<number, number> => {
  const map = new Map<number, number>();
  // Look for lines containing multiple "num.ans" pairs (e.g. "1.ก 2.ข 3.ค")
  const pairRegex = /(\d{1,3})\s*[\.\)\-:=]\s*([กขคงจa-eA-E1-5])(?=\s|,|;|$)/g;
  lines.forEach((rawLine) => {
    const line = convertThaiDigits(rawLine);
    const matches = Array.from(line.matchAll(pairRegex));
    if (matches.length >= 2 || /^(?:เฉลย|คำตอบ|answer\s*key)/i.test(line)) {
      matches.forEach((m) => {
        const qNum = parseInt(m[1], 10);
        const ansChar = m[2].toLowerCase();
        const ansIdx = CHAR_TO_INDEX[ansChar];
        if (qNum > 0 && ansIdx !== undefined) {
          map.set(qNum, ansIdx);
        }
      });
    }
  });
  return map;
};

/**
 * Upgraded local MCQ parser supporting:
 * - Thai & Arabic question numbers (1., ๑., ข้อ 1., ข้อที่ 1., Q1.)
 * - Multi-column / same-line choices (ก. ... ข. ...)
 * - Choices using ก-จ, A-E, or 1)-5)
 * - Answer detection via ตอบ/เฉลย/Answer, leading `*`, `(ถูก)`/`[ถูก]`, bold/underline in Word, or end-of-file answer key
 */
export function parseMcqTextToDrafts(
  rawText: string,
  defaultClassGroup: string,
  defaultExamType: ExamTypeValue,
): ParsedMcqDraft[] {
  const cleaned = cleanInvisibleChars(rawText);
  const rawLines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Extract any bulk answer key at the bottom of the file
  const answerKeyMap = extractAnswerKeyMap(rawLines);

  // Expand inline multi-column choices into individual lines
  const lines: string[] = [];
  rawLines.forEach((line) => {
    // Stop parsing questions if we hit an explicit standalone Answer Key section header
    lines.push(...splitInlineMultipleOptions(line));
  });

  // Strict question start regex: requires explicit delimiter (. ) ]) or "ข้อ"/"Q" prefix
  // Prevents false splits on years like "2567 เป็นปี..." or numbers like "100 บาท"
  const qRegex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\.?\s*)?([0-9๐-๙]{1,3})\s*[\.\)\]]\s*(.+)$/i;
  const qWordOnlyRegex = /^(?:ข้อ\s*(?:ที่)?\s*)([0-9๐-๙]{1,3})\s+(.+)$/i;

  // Option regex: supports optional leading *, ก-จ, a-e, A-E with . ) ]
  const optRegex = /^(\*)?\s*(?:\(|\[)?([กขคงจa-eA-E])[\.\)\]]\s*(.*)$/;
  // Numeric option regex (only active once a question has started, e.g. 1) ... 2) ...)
  const numOptRegex = /^(\*)?\s*(?:\(|\[)?([1-5])\)\s*(.+)$/;

  // Answer line regex: ตอบ ก / เฉลย: ข / Answer: B / ตอบ 2 / เฉลย ข้อ 3
  const ansRegex = /^(?:answer|ans|ตอบ|เฉลย|คำตอบ)\s*(?:ข้อ)?\s*[:=\-]?\s*(?:ข้อ)?\s*\(?([กขคงจa-eA-E1-5])\)?[\.\)]?\s*$/i;
  const ansInlineRegex = /(?:answer|ตอบ|เฉลย)\s*(?:ข้อ)?\s*[:=]\s*(?:ข้อ)?\s*\(?([กขคงจa-eA-E1-5])\)?/i;
  const answerKeySectionHeader = /^(?:เฉลยข้อสอบ|เฉลยคำตอบ|ตารางเฉลย|เฉลยทั้งหมด|answer\s*key)\s*:?$/i;

  interface TempMcq {
    qNum: number;
    text: string;
    options: string[];
    correctIndex: number;
    answerDetected: boolean;
  }

  const parsed: TempMcq[] = [];
  let current: TempMcq | null = null;
  let inAnswerKeySection = false;

  for (const line of lines) {
    if (answerKeySectionHeader.test(line)) {
      inAnswerKeySection = true;
      continue;
    }

    if (inAnswerKeySection) {
      // Parse single-line answer key rows like "1. ก" inside the answer key section
      const singlePair = convertThaiDigits(line).match(/^(\d{1,3})\s*[\.\)\-:=]\s*([กขคงจa-eA-E1-5])/i);
      if (singlePair) {
        const qNum = parseInt(singlePair[1], 10);
        const idx = CHAR_TO_INDEX[singlePair[2].toLowerCase()];
        if (qNum > 0 && idx !== undefined) {
          answerKeyMap.set(qNum, idx);
        }
      }
      continue;
    }

    // Check bulk answer key line (multiple pairs on one line) — skip adding as question text
    const multiPairCount = Array.from(
      convertThaiDigits(line).matchAll(/(\d{1,3})\s*[\.\)\-:=]\s*([กขคงจa-eA-E1-5])(?=\s|,|;|$)/g),
    ).length;
    if (multiPairCount >= 3) {
      continue;
    }

    // 1. Standalone Answer line
    const ansMatch = line.match(ansRegex) || (line.length < 40 ? line.match(ansInlineRegex) : null);
    if (ansMatch && current) {
      const ansChar = convertThaiDigits(ansMatch[1]).toLowerCase();
      if (CHAR_TO_INDEX[ansChar] !== undefined) {
        current.correctIndex = CHAR_TO_INDEX[ansChar];
        current.answerDetected = true;
      }
      continue;
    }

    // 2. Option line (ก-จ / A-E)
    const optMatch = line.match(optRegex);
    if (optMatch && current) {
      const hasStar = Boolean(optMatch[1]);
      let optText = optMatch[3].trim();
      let isMarkedCorrect = hasStar;

      if (/\(\s*(?:ถูก|เฉลย|correct)\s*\)|\[\s*(?:ถูก|เฉลย|correct)\s*\]|\*$/i.test(optText)) {
        isMarkedCorrect = true;
        optText = optText.replace(/\s*(?:\(\s*(?:ถูก|เฉลย|correct)\s*\)|\[\s*(?:ถูก|เฉลย|correct)\s*\]|\*)\s*$/i, '').trim();
      }
      if (optText.startsWith('*')) {
        isMarkedCorrect = true;
        optText = optText.slice(1).trim();
      }

      if (isMarkedCorrect) {
        current.correctIndex = current.options.length;
        current.answerDetected = true;
      }
      current.options.push(optText);
      continue;
    }

    // 3. Numeric option line like "1) ..." inside an active question (when not yet >= 5 options)
    const numOptMatch = current && current.options.length < 5 ? line.match(numOptRegex) : null;
    if (numOptMatch && current) {
      const numVal = parseInt(numOptMatch[2], 10);
      // Only treat as option if sequential (1) for first option, 2) for second, etc.)
      if (numVal === current.options.length + 1) {
        const hasStar = Boolean(numOptMatch[1]);
        let optText = numOptMatch[3].trim();
        if (hasStar) {
          current.correctIndex = current.options.length;
          current.answerDetected = true;
        }
        current.options.push(optText);
        continue;
      }
    }

    // 4. Question start line
    const qMatch = line.match(qRegex) || line.match(qWordOnlyRegex);
    if (qMatch) {
      const numStr = convertThaiDigits(qMatch[1]);
      const qNum = parseInt(numStr, 10);
      const qBody = qMatch[2].trim();

      // Guard against sub-lists inside a question (like "1. ... 2. ... 3. ..." before any choices)
      // If current question has 0 options AND qNum is small (1-4) AND previous question number was >= qNum,
      // treat it as a numbered statement inside the question stem UNLESS qNum === 1 and parsed is empty!
      const isSubStatementInsideStem =
        current !== null &&
        current.options.length === 0 &&
        qNum <= 5 &&
        current.qNum >= qNum &&
        parsed.length > 0;

      if (!isSubStatementInsideStem && qNum >= 1 && qNum <= 500) {
        if (current) parsed.push(current);
        current = {
          qNum,
          text: qBody,
          options: [],
          correctIndex: 0,
          answerDetected: false,
        };
        continue;
      }
    }

    // 5. Continuation line
    if (current) {
      if (current.options.length === 0) {
        current.text = current.text ? `${current.text}\n${line}` : line;
      } else {
        const lastIdx = current.options.length - 1;
        current.options[lastIdx] = current.options[lastIdx]
          ? `${current.options[lastIdx]}\n${line}`
          : line;
      }
    }
  }

  if (current) parsed.push(current);

  return parsed.map((item, idx) => {
    // Apply end-of-file answer key if inline answer wasn't found
    let correctIndex = item.correctIndex;
    let answerDetected = item.answerDetected;
    if (!answerDetected) {
      const mappedByQNum = answerKeyMap.get(item.qNum);
      const mappedByOrder = answerKeyMap.get(idx + 1);
      const found = mappedByQNum !== undefined ? mappedByQNum : mappedByOrder;
      if (found !== undefined && found < item.options.length) {
        correctIndex = found;
        answerDetected = true;
      }
    }

    // Ensure at least 4 option slots if some exist, or keep exact options
    const options = item.options.slice(0, 5);
    if (correctIndex >= options.length) {
      correctIndex = 0;
    }

    return {
      tempId: createTempId('mcq_draft', idx),
      text: item.text.trim(),
      options,
      correctIndex,
      answerDetected,
      classGroup: defaultClassGroup || 'ทั้งหมด',
      examType: defaultExamType,
      warnings: computeMcqWarnings(item.text, options, correctIndex, answerDetected),
    };
  });
}

/**
 * Parse Subjective (อัตนัย) questions from text / Word structured lines.
 */
export function parseSubjTextToDrafts(
  rawText: string,
  defaultClassGroup: string,
  defaultExamType: ExamTypeValue,
): ParsedSubjDraft[] {
  const cleaned = cleanInvisibleChars(rawText);
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[._\-—=]{5,}$/.test(l)); // ignore blank dotted answer lines

  const qRegex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\.?\s*)?([0-9๐-๙]{1,3})\s*[\.\)\]]\s*(.+)$/i;
  const qWordOnlyRegex = /^(?:ข้อ\s*(?:ที่)?\s*)([0-9๐-๙]{1,3})\s+(.+)$/i;

  const parsed: string[] = [];
  let current = '';

  for (const line of lines) {
    const match = line.match(qRegex) || line.match(qWordOnlyRegex);
    if (match) {
      if (current.trim()) parsed.push(current.trim());
      current = match[2].trim();
    } else if (current) {
      current += `\n${line}`;
    } else {
      current = line;
    }
  }
  if (current.trim()) parsed.push(current.trim());

  return parsed.map((text, idx) => ({
    tempId: createTempId('subj_draft', idx),
    text,
    classGroup: defaultClassGroup || 'ทั้งหมด',
    examType: defaultExamType,
    warnings: computeSubjWarnings(text),
  }));
}

// --- EXCEL (.xlsx / .csv) TEMPLATE GENERATOR & IMPORTER ---

export function downloadExamExcelTemplate(
  mode: 'mcq' | 'subj',
  defaultClassGroup = 'ทั้งหมด',
) {
  const wb = XLSX.utils.book_new();

  if (mode === 'mcq') {
    const sampleRows = [
      {
        'คำถาม': 'ข้อใดคือความหมายของประชาธิปไตยที่ถูกต้องที่สุด?',
        'ตัวเลือก ก': 'การปกครองโดยประชาชน เพื่อประชาชน',
        'ตัวเลือก ข': 'การปกครองโดยบุคคลเพียงคนเดียว',
        'ตัวเลือก ค': 'การปกครองโดยไม่มีกฎหมาย',
        'ตัวเลือก ง': 'การปกครองโดยกองทัพ',
        'ตัวเลือก จ (ไม่บังคับ)': '',
        'เฉลย (ก/ข/ค/ง/จ หรือ 1-5)': 'ก',
        'ระดับชั้น/ห้อง': defaultClassGroup || 'ทั้งหมด',
        'ประเภท (general/midterm/final)': 'midterm',
      },
      {
        'คำถาม': 'ประเทศไทยเปลี่ยนแปลงการปกครองเป็นระบอบประชาธิปไตยในปี พ.ศ. ใด?',
        'ตัวเลือก ก': 'พ.ศ. 2470',
        'ตัวเลือก ข': 'พ.ศ. 2475',
        'ตัวเลือก ค': 'พ.ศ. 2480',
        'ตัวเลือก ง': 'พ.ศ. 2485',
        'ตัวเลือก จ (ไม่บังคับ)': 'พ.ศ. 2490',
        'เฉลย (ก/ข/ค/ง/จ หรือ 1-5)': 'ข',
        'ระดับชั้น/ห้อง': defaultClassGroup || 'ทั้งหมด',
        'ประเภท (general/midterm/final)': 'midterm',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    ws['!cols'] = [
      { wch: 48 },
      { wch: 28 },
      { wch: 28 },
      { wch: 28 },
      { wch: 28 },
      { wch: 24 },
      { wch: 22 },
      { wch: 18 },
      { wch: 26 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'ข้อสอบปรนัย');
  } else {
    const sampleRows = [
      {
        'คำถามอัตนัย': 'ให้นักเรียนอธิบายหลักธรรมาภิบาลพร้อมยกตัวอย่างการประยุกต์ใช้ในโรงเรียน',
        'ระดับชั้น/ห้อง': defaultClassGroup || 'ทั้งหมด',
        'ประเภท (general/midterm/final)': 'midterm',
      },
      {
        'คำถามอัตนัย': 'วิเคราะห์ผลกระทบของภาวะเงินเฟ้อต่อค่าครองชีพของประชาชนในปัจจุบัน',
        'ระดับชั้น/ห้อง': defaultClassGroup || 'ทั้งหมด',
        'ประเภท (general/midterm/final)': 'midterm',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(sampleRows);
    ws['!cols'] = [{ wch: 65 }, { wch: 20 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, ws, 'ข้อสอบอัตนัย');
  }

  const guideRows = [
    { 'หัวข้อ': 'วิธีใช้งาน', 'คำอธิบาย': 'กรอกข้อสอบลงในแผ่นงานแรก (ลบแถวตัวอย่างออกได้) แล้วบันทึกเป็น .xlsx และนำเข้าในระบบ' },
    { 'หัวข้อ': 'เฉลย (ปรนัย)', 'คำอธิบาย': 'ใส่ได้ทั้ง ก, ข, ค, ง, จ หรือ A, B, C, D, E หรือตัวเลข 1, 2, 3, 4, 5' },
    { 'หัวข้อ': 'ระดับชั้น/ห้อง', 'คำอธิบาย': 'ใส่ "ทั้งหมด" หรือระบุห้อง เช่น "6/3, 6/8" (หากเว้นว่างระบบจะใช้ค่าเริ่มต้นที่เลือกตอนนำเข้า)' },
    { 'หัวข้อ': 'ประเภทข้อสอบ', 'คำอธิบาย': 'ใส่ general (ทั่วไป), midterm (กลางภาค), หรือ final (ปลายภาค)' },
  ];
  const wsGuide = XLSX.utils.json_to_sheet(guideRows);
  wsGuide['!cols'] = [{ wch: 22 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'คู่มือการกรอก');

  XLSX.writeFile(wb, mode === 'mcq' ? 'template_mcq_exam.xlsx' : 'template_subjective_exam.xlsx');
}

const normalizeHeaderKey = (k: string) => k.trim().toLowerCase().replace(/\s+/g, '');

const pickCell = (row: Record<string, any>, patterns: string[]): string => {
  const entries = Object.entries(row);
  for (const pat of patterns) {
    const found = entries.find(([k]) => normalizeHeaderKey(k).includes(pat));
    if (found && found[1] !== undefined && found[1] !== null) {
      const val = String(found[1]).trim();
      if (val !== '') return val;
    }
  }
  return '';
};

const normalizeExamType = (raw: string, fallback: ExamTypeValue): ExamTypeValue => {
  const lower = raw.trim().toLowerCase();
  if (lower === 'midterm' || lower.includes('กลางภาค')) return 'midterm';
  if (lower === 'final' || lower.includes('ปลายภาค')) return 'final';
  if (lower === 'general' || lower.includes('ทั่วไป')) return 'general';
  return fallback;
};

export function parseMcqExcelToDrafts(
  arrayBuffer: ArrayBuffer,
  defaultClassGroup: string,
  defaultExamType: ExamTypeValue,
): ParsedMcqDraft[] {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  if (!firstSheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(firstSheet, { defval: '' });
  const drafts: ParsedMcqDraft[] = [];

  rows.forEach((row, idx) => {
    const text = pickCell(row, ['คำถาม', 'โจทย์', 'question', 'text']);
    if (!text) return;

    const opt1 = pickCell(row, ['ตัวเลือกก', 'ตัวเลือก1', 'ตัวเลือกที่1', 'option1', 'choice1', 'opt1']);
    const opt2 = pickCell(row, ['ตัวเลือกข', 'ตัวเลือก2', 'ตัวเลือกที่2', 'option2', 'choice2', 'opt2']);
    const opt3 = pickCell(row, ['ตัวเลือกค', 'ตัวเลือก3', 'ตัวเลือกที่3', 'option3', 'choice3', 'opt3']);
    const opt4 = pickCell(row, ['ตัวเลือกง', 'ตัวเลือก4', 'ตัวเลือกที่4', 'option4', 'choice4', 'opt4']);
    const opt5 = pickCell(row, ['ตัวเลือกจ', 'ตัวเลือก5', 'ตัวเลือกที่5', 'option5', 'choice5', 'opt5']);

    // Fallback to exact single-letter headers ก/ข/ค/ง/จ or a/b/c/d/e
    const exactPick = (keys: string[]) => {
      for (const k of keys) {
        const entry = Object.entries(row).find(([rk]) => normalizeHeaderKey(rk) === k);
        if (entry && String(entry[1] ?? '').trim()) return String(entry[1]).trim();
      }
      return '';
    };

    const options = [
      opt1 || exactPick(['ก', 'a', '1']),
      opt2 || exactPick(['ข', 'b', '2']),
      opt3 || exactPick(['ค', 'c', '3']),
      opt4 || exactPick(['ง', 'd', '4']),
      opt5 || exactPick(['จ', 'e', '5']),
    ].filter((o) => o.length > 0);

    const rawAns = convertThaiDigits(pickCell(row, ['เฉลย', 'ตอบ', 'answer', 'correct']));
    let correctIndex = 0;
    let answerDetected = false;

    if (rawAns) {
      const cleanAns = rawAns.replace(/^(?:ข้อ|ตอบ|เฉลย)\s*/i, '').replace(/[\.\)\]]+$/, '').trim().toLowerCase();
      if (CHAR_TO_INDEX[cleanAns] !== undefined && CHAR_TO_INDEX[cleanAns] < options.length) {
        correctIndex = CHAR_TO_INDEX[cleanAns];
        answerDetected = true;
      } else {
        // Try matching full option text
        const textIdx = options.findIndex((o) => o.trim().toLowerCase() === rawAns.trim().toLowerCase());
        if (textIdx >= 0) {
          correctIndex = textIdx;
          answerDetected = true;
        }
      }
    }

    const classGroup = pickCell(row, ['ระดับชั้น', 'ห้อง', 'class']) || defaultClassGroup || 'ทั้งหมด';
    const examType = normalizeExamType(pickCell(row, ['ประเภท', 'type', 'examtype']), defaultExamType);

    drafts.push({
      tempId: createTempId('mcq_xlsx', idx),
      text,
      options,
      correctIndex,
      answerDetected,
      classGroup,
      examType,
      warnings: computeMcqWarnings(text, options, correctIndex, answerDetected),
    });
  });

  return drafts;
}

export function parseSubjExcelToDrafts(
  arrayBuffer: ArrayBuffer,
  defaultClassGroup: string,
  defaultExamType: ExamTypeValue,
): ParsedSubjDraft[] {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheet = wb.Sheets[wb.SheetNames[0]];
  if (!firstSheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, any>>(firstSheet, { defval: '' });
  const drafts: ParsedSubjDraft[] = [];

  rows.forEach((row, idx) => {
    const text = pickCell(row, ['คำถาม', 'โจทย์', 'question', 'text']);
    if (!text) return;
    const classGroup = pickCell(row, ['ระดับชั้น', 'ห้อง', 'class']) || defaultClassGroup || 'ทั้งหมด';
    const examType = normalizeExamType(pickCell(row, ['ประเภท', 'type', 'examtype']), defaultExamType);
    drafts.push({
      tempId: createTempId('subj_xlsx', idx),
      text,
      classGroup,
      examType,
      warnings: computeSubjWarnings(text),
    });
  });

  return drafts;
}

export function finalizeMcqDrafts(drafts: ParsedMcqDraft[], courseId: string): MCQ[] {
  return drafts
    .filter((d) => d.text.trim().length > 0)
    .map((d, idx) => {
      const cleanedOpts = d.options.map((o) => o.trim()).filter(Boolean);
      const finalOpts = cleanedOpts.length >= 2 ? cleanedOpts : ['ตัวเลือกที่ 1', 'ตัวเลือกที่ 2', 'ตัวเลือกที่ 3', 'ตัวเลือกที่ 4'];
      const safeCorrect = d.correctIndex >= 0 && d.correctIndex < finalOpts.length ? d.correctIndex : 0;
      return {
        id: `mcq_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        courseId,
        text: d.text.trim(),
        options: finalOpts,
        correctIndex: safeCorrect,
        classGroup: d.classGroup.trim() || 'ทั้งหมด',
        examType: d.examType,
      };
    });
}

export function finalizeSubjDrafts(drafts: ParsedSubjDraft[], courseId: string): Subjective[] {
  return drafts
    .filter((d) => d.text.trim().length > 0)
    .map((d, idx) => ({
      id: `subj_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      courseId,
      text: d.text.trim(),
      classGroup: d.classGroup.trim() || 'ทั้งหมด',
      examType: d.examType,
    }));
}
