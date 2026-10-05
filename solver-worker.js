// ランキング計算はUIを止めないようにWeb Workerで行う
import { Solver } from './solver.js';
import { NORMAL_BOOK, HARD_BOOK } from './book.js';

const solver = new Solver();

self.onmessage = (event) => {
    const { id, history, hard } = event.data;
    const result = solver.rank(history, { hard, limit: 30, book: hard ? HARD_BOOK : NORMAL_BOOK });
    self.postMessage({ id, ...result });
};
