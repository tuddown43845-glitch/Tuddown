const text = '\u200B1. คำถาม\n\u200Bก. ตอบ\nตอบ ก';
const lines = text.split('\n').map(l => l.trim().replace(/[\u200B-\u200D\uFEFF]/g, '')).filter(Boolean);
console.log(lines);
for (const line of lines) {
  console.log('Match question:', !!(line.match(/^\d+[\.\)\s]/) || line.match(/^ข้อ\s*\d+/)));
  console.log('Match option:', !!(line.match(/^[กขคงจA-Ea-e][\.\)\s]/)));
}
