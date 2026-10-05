// 組み込みデータを生成する: node scripts/build.mjs
//   1. answers.txt / allowed.txt → words.js（単語リスト）
//      元データ: https://github.com/alex1770/wordle の wordlist_nyt20230701_hidden（正解候補）と
//      wordlist_nyt20220830_all から正解候補を除いたもの（入力可能）。MIT License
//   2. words.js + solver.js → opening.js（1手目のランキング。計算が重いので事前計算）
// 単語リストや solver.js を変更したら再実行し、続けて scripts/build-book.mjs normal / hard（定跡）も作り直す。
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readList = name => readFileSync(new URL(name, root), 'utf-8')
    .split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{5}$/.test(w));

const answers = readList('answers.txt');
const allowed = readList('allowed.txt');
writeFileSync(new URL('words.js', root), `// scripts/build.mjs で allowed.txt / answers.txt から生成
// ANSWERS: 正解になりうる単語, ALLOWED: 入力可能だが正解にはならない単語
export const ANSWERS = '${answers.join(' ')}'.split(' ');
export const ALLOWED = '${allowed.join(' ')}'.split(' ');
`);
console.log(`words.js: answers ${answers.length}, allowed ${allowed.length}`);

// 生成した words.js を読み込んでから solver を使う
const { Solver } = await import('../solver.js');
const solver = new Solver();
const round = r => ({ ...r, expected: +r.expected.toFixed(4) });
const build = hard => solver.rank([], { hard, limit: 30, depth: 1 }).ranking.map(round);

const normal = build(false);
const hard = build(true);
writeFileSync(new URL('opening.js', root), `// scripts/build.mjs で生成
export const OPENING_RANKING = ${JSON.stringify(normal)};
export const OPENING_RANKING_HARD = ${JSON.stringify(hard)};
`);
for (const [name, list] of [['normal', normal], ['hard', hard]]) {
    console.log(name, list.slice(0, 5).map(r => `${r.word}:${r.expected.toFixed(3)}`).join(' '));
}
