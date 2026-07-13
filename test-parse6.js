const text = `
ข้อที่ 1 คำถาม 1
(ก) ตอบ ก
[ข] ตอบ ข
ค) ตอบ ค
ง. ตอบ ง
จ ตอบ จ
Answer: ก

[2] คำถาม 2
a) ตอบ a
b. ตอบ b
c ตอบ c
d ตอบ d
e) ตอบ e
ตอบ: c
`;

const lines = text.split('\n').map(l => l.trim().replace(/[\u200B-\u200D\uFEFF]/g, '')).filter(Boolean);
const parsedMcqs = [];
let currentMcq = null;
const targetClass = 'ทั้งหมด';
const qRegex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]/i;
const optRegex = /^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]/i;

for (const line of lines) {
  if (line.match(qRegex)) {
    if (currentMcq) parsedMcqs.push(currentMcq);
    currentMcq = {
      text: line.replace(/^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]+/i, ''),
      options: [],
      correctIndex: 0,
      classGroup: targetClass || 'ทั้งหมด'
    };
  } else if (line.match(optRegex) && currentMcq) {
    currentMcq.options.push(line.replace(/^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]+/i, ''));
  } else if (line.toLowerCase().startsWith('answer') || line.startsWith('ตอบ') || line.startsWith('เฉลย')) {
    if (currentMcq) {
      const ansChar = line.replace(/^(answer|ตอบ|เฉลย)\s*:?\s*/i, '').trim().toLowerCase()[0];
      const charMap = { 'ก': 0, 'ข': 1, 'ค': 2, 'ง': 3, 'จ': 4, 'a': 0, 'b': 1, 'c': 2, 'd': 3, 'e': 4 };
      if (ansChar && charMap[ansChar] !== undefined) {
        currentMcq.correctIndex = charMap[ansChar];
      }
    }
  }
}
if (currentMcq) parsedMcqs.push(currentMcq);
console.log(JSON.stringify(parsedMcqs, null, 2));
