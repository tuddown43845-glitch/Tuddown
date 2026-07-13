const text = `
1. คำถามแรก
ก. ตอบ ก
ข. ตอบ ข
ค. ตอบ ค
ง. ตอบ ง
ตอบ: ก
`;

const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
const parsedMcqs = [];
let currentMcq = null;
const targetClass = 'ทั้งหมด';

for (const line of lines) {
  if (line.match(/^\d+[\.\)\s]/) || line.match(/^ข้อ\s*\d+/)) {
    if (currentMcq) parsedMcqs.push(currentMcq);
    currentMcq = {
      text: line.replace(/^(\d+[\.\)\s]+|ข้อ\s*\d+\.?\s*)/, ''),
      options: [],
      correctIndex: 0,
      classGroup: targetClass || 'ทั้งหมด'
    };
  } else if (line.match(/^[กขคงจA-Ea-e][\.\)\s]/) && currentMcq) {
    currentMcq.options.push(line.replace(/^[กขคงจA-Ea-e][\.\)\s]+/, ''));
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
