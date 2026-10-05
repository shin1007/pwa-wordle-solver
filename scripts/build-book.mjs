// 「定跡」（1語目と、その色の出方ごとの2語目）を作る: node scripts/build-book.mjs normal|hard [1語目...]
//   1語目の色の出方ごとに、おすすめ上位の2語目を実際に最後まで解かせて比べ、
//   手数のコスト（5手以上・失敗を重く見る）が最小のものを選ぶ。
//   1語目を複数渡すと全部作って比べ、最良のものを book.js に書き出す（もう一方のモードの定跡はそのまま残す）。
// 単語リストや solver.js を変更したら再実行する（全コア使って数分〜十数分かかる）。
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Solver, ALL_GREEN } from '../solver.js';
import * as books from '../book.js';

const SECOND_CANDIDATES = 25; // 比べる2語目の数（おすすめ上位から）

// 1ゲームのコスト。平均手数に加え、5手以上と6手超え（失敗）を重く見る
const gameCost = n => n + 0.2 * Math.max(0, n - 4) + 10 * Math.max(0, n - 6);

/** history の状態から guess を入れて、answer を解き切るまでの総手数 */
function playOut(solver, hard, history, guess, answer) {
    const h = [...history];
    let n = h.length;
    for (;;) {
        n++;
        const p = solver.feedback(solver.index.get(guess), answer);
        if (p === ALL_GREEN || n > 10) return n;
        h.push({ word: guess, pattern: p });
        guess = solver.rank(h, { hard, limit: 1 }).ranking[0].word;
    }
}

/** 1語目 opener がパターン pattern だった局面で、おすすめ上位の2語目を最後まで解かせて最良のものを選ぶ */
function bestSecond(solver, hard, opener, pattern) {
    const history = [{ word: opener, pattern }];
    const answers = solver.candidates(history);
    const options = solver.rank(history, { hard, limit: SECOND_CANDIDATES }).ranking.map(r => r.word);
    let best = null;
    for (const word of options) {
        const games = answers.map(a => playOut(solver, hard, history, word, a));
        const cost = games.reduce((s, n) => s + gameCost(n), 0);
        if (!best || cost < best.cost - 1e-9) best = { word, cost, games };
    }
    return { pattern, ...best, default: options[0] };
}

if (!isMainThread) {
    const solver = new Solver();
    for (const [opener, pattern] of workerData.jobs) {
        parentPort.postMessage(bestSecond(solver, workerData.hard, opener, pattern));
    }
    process.exit(0);
}

const mode = process.argv[2];
if (mode !== 'normal' && mode !== 'hard') throw new Error('使い方: node scripts/build-book.mjs normal|hard [1語目...]');
const hard = mode === 'hard';
const openers = process.argv.slice(3).length ? process.argv.slice(3) : ['tarse'];
const solver = new Solver();

// 1語目ごとの色の出方（正解リストに出現するもの）を並列で処理する
const jobs = [];
for (const opener of openers) {
    const g = solver.index.get(opener);
    const patterns = new Set();
    for (let a = 0; a < solver.answerCount; a++) patterns.add(solver.feedback(g, a));
    patterns.delete(ALL_GREEN);
    for (const p of patterns) jobs.push([opener, p]);
}
// 大きい局面から配ると並列の効率が良い
jobs.sort((x, y) => solver.candidates([{ word: y[0], pattern: y[1] }]).length
    - solver.candidates([{ word: x[0], pattern: x[1] }]).length);

const threads = Math.max(1, cpus().length - 1);
const buckets = Array.from({ length: threads }, () => []);
jobs.forEach((job, i) => buckets[i % threads].push(job));

const results = new Map(openers.map(o => [o, []]));
let done = 0;
await Promise.all(buckets.map((bucket, t) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { jobs: bucket, hard } });
    let i = 0;
    worker.on('message', r => {
        results.get(bucket[i++][0]).push(r);
        if (++done % 50 === 0) console.log(`${done}/${jobs.length}`);
    });
    worker.on('error', reject);
    worker.on('exit', resolve);
})));

// 1語目ごとに集計（1語目で正解した1ゲームも含める）
const summaries = openers.map(opener => {
    const list = results.get(opener);
    const games = list.flatMap(r => r.games);
    if (solver.index.get(opener) < solver.answerCount) games.push(1);
    const dist = {};
    for (const n of games) dist[n] = (dist[n] || 0) + 1;
    const avg = games.reduce((s, n) => s + n, 0) / games.length;
    const cost = games.reduce((s, n) => s + gameCost(n), 0) / games.length;
    const changed = list.filter(r => r.word !== r.default).length;
    console.log(`${opener}: avg ${avg.toFixed(4)} cost ${cost.toFixed(4)} >=5: ${games.filter(n => n >= 5).length}`
        + ` 6: ${dist[6] || 0} fail: ${games.filter(n => n > 6).length} (2語目を変更 ${changed}/${list.length}) ${JSON.stringify(dist)}`);
    return { opener, list, avg, cost };
});

const best = summaries.reduce((a, b) => (b.cost < a.cost ? b : a));
const second = {};
for (const r of best.list.sort((a, b) => a.pattern - b.pattern)) {
    second[r.pattern] = { word: r.word, expected: +(r.games.reduce((s, n) => s + n, 0) / r.games.length - 1).toFixed(4) };
}
const book = { hard, opener: best.opener, expected: +best.avg.toFixed(4), second };
const result = { NORMAL_BOOK: books.NORMAL_BOOK ?? null, HARD_BOOK: books.HARD_BOOK ?? null, [hard ? 'HARD_BOOK' : 'NORMAL_BOOK']: book };
writeFileSync(new URL('../book.js', import.meta.url), `// scripts/build-book.mjs で生成（通常モード / ハードモードの定跡）
// hard: ハードモード用か, opener: 1語目, expected: 1語目から平均何手で解けたか,
// second: 1語目の色パターン → 2語目と、その2語目を含めて平均あと何手で解けたか
export const NORMAL_BOOK = ${JSON.stringify(result.NORMAL_BOOK)};
export const HARD_BOOK = ${JSON.stringify(result.HARD_BOOK)};
`);
console.log(`book.js: ${mode} opener ${best.opener}`);
