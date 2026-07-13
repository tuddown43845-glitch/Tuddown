const regex = /^(?:ข้อ\s*(?:ที่)?\s*|q(?:uestion)?\s*\(?|\[|\()?0*(\d+)[\.\)\]\s]/i;
const tests = [
  "1. คำถาม",
  "1) คำถาม",
  "1 คำถาม",
  "ข้อ 1 คำถาม",
  "ข้อที่ 1 คำถาม",
  "ข้อที่1 คำถาม",
  "Q1. คำถาม",
  "Q 1. คำถาม",
  "Question 1. คำถาม",
  "(1) คำถาม",
  "[1] คำถาม",
  "01. คำถาม",
  "10. คำถาม"
];

tests.forEach(t => {
  const match = t.match(regex);
  console.log(`"${t}" => ${match ? 'MATCH' : 'NO MATCH'}`);
});
