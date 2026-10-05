// ソルバーの性能を測る: node scripts/bench.mjs [normal|hard] [正解の間引き間隔] [探索パラメータのJSON]
//   全正解（または間引いたもの）について、1語目から最後まで solver.rank のおすすめ1位で解かせ、
//   平均手数・手数分布・失敗数と、1手あたりの計算時間を表示する。全コアで並列に実行する。
import { cpus } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Solver, ALL_GREEN } from '../solver.js';
import { NORMAL_BOOK, HARD_BOOK } from '../book.js';

function play(solver, hard, answer, params) {
    const history = [];
    const book = hard ? HARD_BOOK : NORMAL_BOOK;
    let guess = book.opener;
    let maxMs = 0, totalMs = 0;
    for (let n = 1; ; n++) {
        const p = solver.feedback(solver.index.get(guess), answer);
        if (p === ALL_GREEN || n >= 10) return { n, maxMs, totalMs };
        history.push({ word: guess, pattern: p });
        const t = performance.now();
        guess = solver.rank(history, { hard, limit: 1, book, params }).ranking[0].word;
        const ms = performance.now() - t;
        totalMs += ms;
        maxMs = Math.max(maxMs, ms);
    }
}

if (!isMainThread) {
    const solver = new Solver();
    for (const a of workerData.answers) parentPort.postMessage({ a, ...play(solver, workerData.hard, a, workerData.params) });
    process.exit(0);
}

const mode = process.argv[2] || 'normal';
const step = +(process.argv[3] || 1);
const hard = mode === 'hard';
const params = process.argv[4] ? JSON.parse(process.argv[4]) : undefined;
const solver = new Solver();
const answers = [];
for (let a = 0; a < solver.answerCount; a += step) answers.push(a);

const threads = Math.max(1, cpus().length - 1);
const buckets = Array.from({ length: threads }, () => []);
answers.forEach((a, i) => buckets[i % threads].push(a));
const results = [];
const start = performance.now();
await Promise.all(buckets.map(b => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { answers: b, hard, params } });
    w.on('message', r => results.push(r));
    w.on('error', reject);
    w.on('exit', resolve);
})));
const wall = (performance.now() - start) / 1000;
const dist = {};
for (const r of results) dist[r.n] = (dist[r.n] || 0) + 1;
const avg = results.reduce((s, r) => s + r.n, 0) / results.length;
// build-book.mjs と同じ1ゲームのコスト（5手以上・失敗を重く見る）
const cost = results.reduce((s, r) => s + r.n + 0.2 * Math.max(0, r.n - 4) + 10 * Math.max(0, r.n - 6), 0) / results.length;
const ranks = results.reduce((s, r) => s + r.n - 1, 0);
const cpu = results.reduce((s, r) => s + r.totalMs, 0);
const worst = results.reduce((a, b) => (b.maxMs > a.maxMs ? b : a));
console.log(`${mode}: games ${results.length} avg ${avg.toFixed(4)} cost ${cost.toFixed(4)} fail ${results.filter(r => r.n > 6).length} ${JSON.stringify(dist)}`);
console.log(`time: wall ${wall.toFixed(1)}s, rank avg ${(cpu / ranks).toFixed(1)}ms, max ${worst.maxMs.toFixed(0)}ms (${solver.words[worst.a]})`);
const fails = results.filter(r => r.n > 6).map(r => solver.words[r.a]);
if (fails.length) console.log('fail:', fails.join(' '));
