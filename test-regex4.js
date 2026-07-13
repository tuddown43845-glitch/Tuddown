const regex = /^(?:\(|\[)?([กขคงจa-e])[\.\)\]\s]/i;
const tests = [
  "ก. ตอบ",
  "ก) ตอบ",
  "(ก) ตอบ",
  "[ก] ตอบ",
  "ก ตอบ",
  "A. ตอบ",
  "(A) ตอบ",
  "a) ตอบ"
];

tests.forEach(t => {
  const match = t.match(regex);
  console.log(`"${t}" => ${match ? 'MATCH' : 'NO MATCH'}`);
});
