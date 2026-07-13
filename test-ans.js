const lines = [
  "ตอบ: ก",
  "เฉลย ก",
  "เฉลยข้อ ก",
  "Answer: A",
  "ตอบข.",
  "ตอบ ข"
];

const ansRegex = /(?:answer|ตอบ|เฉลย|เฉลยข้อ)\s*:?\s*([กขคงจa-e])/i;

lines.forEach(l => {
  const match = l.match(ansRegex);
  if (match) {
    console.log(`"${l}" => ${match[1].toLowerCase()}`);
  } else {
    console.log(`"${l}" => NO MATCH`);
  }
});
