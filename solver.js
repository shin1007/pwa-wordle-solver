import { ANSWERS, ALLOWED } from './words.js';

// フィードバックは 3進数 5桁で表す（i文字目の重み 3^i, 0=灰 1=黄 2=緑）
export const ALL_GREEN = 242;
const PATTERN_COUNT = 243;
const CODE_A = 'a'.charCodeAt(0);

// 探索パラメータ（rank の params で上書きできる）
export const DEFAULT_PARAMS = {
    topK: 30,          // 先読みで厳密評価する上位候補数（トップレベル）
    innerK: 8,         // 先読みで厳密評価する上位候補数（部分問題）
    extraPool: 100,    // 部分問題で候補単語以外に試す推測語の数
    rolloutMax: 20,    // 先読みの末端でも、残りがこの語数以下なら最後まで（貪欲に）解いて手数を数える
    maxGuesses: 6,     // Wordleの手数上限
    failPenalty: 3,    // 上限を超える1手ごとのペナルティ（失敗しにくい手を優先する）
    tailTurn: 4,       // この手数を超える推測に tailPenalty を加える（5手以上かかる展開を避ける）
    tailPenalty: 0.2,
    depth2Max: 50,     // 候補がこの語数以下なら2段先まで読む
    depth1Max: 300,    // 候補がこの語数以下なら1段先まで読む
    // 1文字違いの塊（_ATCH など）が推測後も分かれずに残る場合の補正の重み（0で無効）
    clusterWeightNormal: 1,
    clusterWeightHard: 1,
    // 残り k 語（3語以上）を解く手数の見積もり a + b * ln(k) の係数（ソルバー自身の実測に合わせたもの）
    costNormal: [1.4, 0.28],
    costHard: [1.5, 0.29],
};

/** 評価済みの推測語の並び順（見積もり手数、同点なら候補単語・エントロピー優先） */
function compareScored(x, y) {
    return x.expected - y.expected
        || (y.isCandidate - x.isCandidate)
        || (y.entropy - x.entropy);
}

/** 色の配列（'gray' | 'yellow' | 'green'）をパターン番号に変換 */
export function colorsToPattern(colors) {
    const value = { gray: 0, yellow: 1, green: 2 };
    let p = 0;
    for (let i = 4; i >= 0; i--) p = p * 3 + value[colors[i]];
    return p;
}

export class Solver {
    constructor(answers = ANSWERS, allowed = ALLOWED) {
        this.words = [...answers, ...allowed];
        this.answerCount = answers.length;
        this.index = new Map(this.words.map((w, i) => [w, i]));
        this.codes = new Uint8Array(this.words.length * 5);
        this.words.forEach((w, i) => {
            for (let j = 0; j < 5; j++) this.codes[i * 5 + j] = w.charCodeAt(j) - CODE_A;
        });
        this.letterCount = new Int8Array(26);
        this.bucketSizes = new Int32Array(PATTERN_COUNT);
        this.touched = new Int32Array(PATTERN_COUNT);
        this._search = null;
        this.params = DEFAULT_PARAMS;
        this.cost = DEFAULT_PARAMS.costNormal;
    }

    /**
     * 残り k 語を解くのに必要な推測回数の見積もり（次の1手を含む）。
     * 1語なら1手、2語なら 1.5 手、それ以上は経験的な近似式。
     */
    estimateCost(k) {
        if (k <= 1) return 1;
        if (k === 2) return 1.5;
        return this.cost[0] + this.cost[1] * Math.log(k);
    }

    /** 1文字違いの s 語が塊のまま残ったとき、1語ずつ試すしかない場合の手数と見積もりの差 */
    clusterExtra(s) {
        return Math.max(0, (s + 1) / 2 - this.estimateCost(s));
    }

    /** これまで turn 手使った状態から k 語を解く見積もり手数（ペナルティ込み） */
    leafCost(k, turn) {
        const { maxGuesses, failPenalty, tailTurn, tailPenalty } = this.params;
        const base = this.estimateCost(k);
        const end = turn + base;
        let cost = base;
        if (end > maxGuesses) cost += (end - maxGuesses) * failPenalty;
        if (end > tailTurn) cost += (end - tailTurn) * tailPenalty;
        return cost;
    }

    /** turn 手目の推測そのもののコスト */
    guessCost(turn) {
        const { maxGuesses, failPenalty, tailTurn, tailPenalty } = this.params;
        return 1 + (turn > maxGuesses ? failPenalty : 0) + (turn > tailTurn ? tailPenalty : 0);
    }

    /** leafCost(k, turn) を k = 0..候補数 について並べた表（探索中に使い回す） */
    _leafTable(turn) {
        const tables = this._search.leafTables;
        let table = tables[turn];
        if (!table) {
            table = new Float64Array(this._search.cands.length + 1);
            for (let k = 0; k < table.length; k++) table[k] = this.leafCost(k, turn);
            tables[turn] = table;
        }
        return table;
    }

    /**
     * 1文字違いの単語の塊（1か所以外の4文字が同じ位置で一致する3語以上）を列挙する。
     * 戻り値は cands 内の添字の配列の配列。
     */
    clusters(cands) {
        const c = this.codes;
        const result = [];
        for (let i = 0; i < 5; i++) {
            const groups = new Map();
            cands.forEach((a, idx) => {
                let key = 0;
                for (let j = 0; j < 5; j++) if (j !== i) key = key * 26 + c[a * 5 + j];
                const group = groups.get(key);
                if (group) group.push(idx);
                else groups.set(key, [idx]);
            });
            for (const group of groups.values()) if (group.length >= 3) result.push(group);
        }
        return result;
    }

    /** 推測語 g を出したとき、正解が a なら返ってくるパターン（重複文字もWordleと同じ規則） */
    feedback(g, a) {
        const c = this.codes, cnt = this.letterCount;
        const gi = g * 5, ai = a * 5;
        let greens = 0;
        for (let i = 0; i < 5; i++) {
            if (c[gi + i] === c[ai + i]) greens |= 1 << i;
            else cnt[c[ai + i]]++;
        }
        // 黄色は左から順に、正解側で余っている文字数の分だけ付く
        let p = 0;
        for (let i = 0, w = 1; i < 5; i++, w *= 3) {
            if (greens & (1 << i)) p += 2 * w;
            else {
                const l = c[gi + i];
                if (cnt[l] > 0) { p += w; cnt[l]--; }
            }
        }
        for (let i = 0; i < 5; i++) cnt[c[ai + i]] = 0;
        return p;
    }

    /** 履歴 [{word, pattern}] と矛盾しない単語番号の配列（基本は正解リストから） */
    candidates(history) {
        const ids = history.map(h => ({ g: this.index.get(h.word), p: h.pattern }))
            .filter(h => h.g !== undefined);
        const match = a => ids.every(h => this.feedback(h.g, a) === h.p);
        const result = [];
        for (let a = 0; a < this.answerCount; a++) if (match(a)) result.push(a);
        if (result.length > 0) return result;
        // 正解リストに無い単語が答えの場合に備え、入力可能単語にフォールバック
        for (let a = this.answerCount; a < this.words.length; a++) if (match(a)) result.push(a);
        return result;
    }

    // ---- ハードモードの制約 ----

    /** 制約 {green: Int8Array(5), min: Int8Array(26)} に (推測語, パターン) の情報を加えた新しい制約 */
    addConstraint(cons, g, pattern) {
        const green = Int8Array.from(cons.green);
        const min = Int8Array.from(cons.min);
        const seen = new Int8Array(26);
        for (let i = 0, p = pattern; i < 5; i++, p = Math.floor(p / 3)) {
            const v = p % 3, l = this.codes[g * 5 + i];
            if (v === 2) green[i] = l;
            if (v > 0) seen[l]++;
        }
        for (let l = 0; l < 26; l++) if (seen[l] > min[l]) min[l] = seen[l];
        return { green, min, key: `${green.join(',')}/${min.join('')}` };
    }

    emptyConstraint() {
        return { green: new Int8Array(5).fill(-1), min: new Int8Array(26), key: '' };
    }

    /** ハードモードで単語 g が入力可能か（緑は同じ位置、黄・緑の文字は必要数含む） */
    hardOk(g, cons) {
        const c = this.codes, gi = g * 5;
        for (let i = 0; i < 5; i++) {
            if (cons.green[i] >= 0 && c[gi + i] !== cons.green[i]) return false;
        }
        const min = cons.min;
        for (let l = 0; l < 26; l++) {
            if (min[l] === 0) continue;
            let n = 0;
            for (let i = 0; i < 5; i++) if (c[gi + i] === l) n++;
            if (n < min[l]) return false;
        }
        return true;
    }

    // ---- 評価 ----
    //
    // 探索中（this._search）は、候補単語を rank 時点の候補 cands の添字（位置）で表し、
    // 推測語 g ごとのフィードバックの行 rows[g * n + 位置] を一度だけ計算して使い回す。
    // 同じ部分問題（候補・深さ・手数・制約が同じ）の答えはメモして再利用する。

    /**
     * 文字 l を i 文字目に置いたときの、各候補に対するパターンの i 桁目の値の表（posValue[(i * 26 + l) * n + 位置]）。
     * 同じ文字を2回以上含まない推測語なら、黄色は「正解がその文字を含むか」だけで決まるので、
     * パターンはこの表の5つの値の和になる。
     */
    _buildPosValue(cands) {
        const n = cands.length, c = this.codes;
        const table = new Uint8Array(5 * 26 * n);
        for (let x = 0; x < n; x++) {
            const ai = cands[x] * 5;
            let mask = 0;
            for (let j = 0; j < 5; j++) mask |= 1 << c[ai + j];
            for (let i = 0, w = 1; i < 5; i++, w *= 3) {
                for (let l = 0; l < 26; l++) {
                    table[(i * 26 + l) * n + x] = c[ai + i] === l ? 2 * w : (mask >> l) & 1 ? w : 0;
                }
            }
        }
        return table;
    }

    /**
     * 推測語 g の行（cands 全体に対するフィードバック）の先頭位置。未計算なら計算する。
     * どの候補にも含まれない文字（必ず灰色）だけが違う推測語は行が同じなので、1つの行を共有する。
     */
    _row(g) {
        const s = this._search;
        if (s.rowOff[g] >= 0) return s.rowOff[g];
        const n = s.cands.length, rows = s.rows, c = this.codes, gi = g * 5;
        let key = 0, mask = 0, repeated = false;
        for (let i = 0; i < 5; i++) {
            const l = c[gi + i], bit = 1 << l;
            if (!(s.liveMask & bit)) { key = key * 27 + 26; continue; }
            key = key * 27 + l;
            if (mask & bit) repeated = true;
            mask |= bit;
        }
        const same = s.rowByKey.get(key);
        if (same !== undefined) return (s.rowOff[g] = same);
        const off = g * n;
        if (repeated) {
            const cands = s.cands;
            for (let i = 0; i < n; i++) rows[off + i] = this.feedback(g, cands[i]);
        } else {
            // 灰色の文字の表の値は全部 0 なので、同じ灰色の文字が重なっていてもよい
            const t = s.posValue;
            const o0 = c[gi] * n, o1 = (26 + c[gi + 1]) * n, o2 = (52 + c[gi + 2]) * n,
                o3 = (78 + c[gi + 3]) * n, o4 = (104 + c[gi + 4]) * n;
            for (let i = 0; i < n; i++) rows[off + i] = t[o0 + i] + t[o1 + i] + t[o2 + i] + t[o3 + i] + t[o4 + i];
        }
        s.rowByKey.set(key, off);
        return (s.rowOff[g] = off);
    }

    /**
     * パターン列 pats[0..m) を返す推測語を turn 手目の後に出したときの見積もり平均手数（1パス・先読みなし）。
     * エントロピーは this._entropy に入れる。
     */
    _evaluate(pats, m, turn, clusters) {
        const sizes = this.bucketSizes, touched = this.touched;
        let t = 0;
        for (let i = 0; i < m; i++) {
            const p = pats[i];
            if (sizes[p]++ === 0) touched[t++] = p;
        }
        const leaf = this._leafTable(turn + 1);
        let total = 0, entropy = 0;
        for (let j = 0; j < t; j++) {
            const p = touched[j], k = sizes[p];
            sizes[p] = 0;
            entropy -= (k / m) * Math.log2(k / m);
            if (p === ALL_GREEN) continue;
            total += k * leaf[k];
        }
        if (clusters) total += this.clusterWeight * this._clusterPenalty(clusters, pats);
        this._entropy = entropy;
        return this.guessCost(turn + 1) + total / m;
    }

    /** 推測後も同じパターンにまとまって残る、塊の語に対する追加手数の合計 */
    _clusterPenalty(clusters, pats) {
        let penalty = 0;
        for (const group of clusters) {
            // 塊の中で同じパターンになった語の数を数える（塊は小さいので総当たり）
            for (let x = 0; x < group.length; x++) {
                const p = pats[group[x]];
                if (p === ALL_GREEN) continue;
                let same = 0, first = true;
                for (let y = 0; y < group.length; y++) {
                    if (pats[group[y]] !== p) continue;
                    if (y < x) { first = false; break; }
                    same++;
                }
                if (first && same >= 3) penalty += same * this.clusterExtra(same);
            }
        }
        return penalty;
    }

    /**
     * 部分問題（候補の位置 pos）で試す推測語を評価し、見積もり順の上位 k 件を返す。
     * 試すのは候補単語と extra（ハードモードでは入力可能なものだけ）。
     */
    _scoreSub(pos, hard, cons, turn, k) {
        const s = this._search, m = pos.length, pats = s.pats, stamp = ++s.stamp;
        const words = Array.from(pos, i => s.cands[i]);
        const clusters = this.clusterWeight > 0 ? this.clusters(words) : [];
        const useClusters = clusters.length > 0 ? clusters : null;
        for (const g of words) s.mark[g] = stamp;
        const top = [];
        const consider = (g, isCandidate) => {
            if (hard && !this.hardOk(g, cons)) return;
            const off = this._row(g), rows = s.rows;
            for (let i = 0; i < m; i++) pats[i] = rows[off + pos[i]];
            const item = { g, isCandidate, expected: this._evaluate(pats, m, turn, useClusters), entropy: this._entropy };
            // 安定な挿入で上位 k 件を保つ（同点なら先に試した語が前）
            let i = top.length;
            while (i > 0 && compareScored(item, top[i - 1]) < 0) i--;
            if (i >= k) return;
            top.splice(i, 0, item);
            if (top.length > k) top.pop();
        };
        for (const g of words) consider(g, true);
        for (const g of s.extra) if (s.mark[g] !== stamp) consider(g, false);
        return top;
    }

    /**
     * 推測語 g を出した場合の平均手数を、決定木を depth 段まで先読みして求める。
     * pos: 候補の位置, hard: ハードモード, cons: 現在の制約, turn: これまでの手数
     */
    _expectedWithLookahead(g, pos, depth, hard, cons, turn) {
        const n = pos.length, s = this._search, rows = s.rows, off = this._row(g);
        // パターンごとに候補を振り分ける（パターンは最初に現れた順、各バケツ内は元の順）
        const sizes = this.bucketSizes, touched = [];
        for (let i = 0; i < n; i++) {
            const p = rows[off + pos[i]];
            if (sizes[p]++ === 0) touched.push(p);
        }
        const starts = [];
        let acc = 0;
        for (const p of touched) {
            starts.push(acc);
            const k = sizes[p];
            sizes[p] = acc;
            acc += k;
        }
        const sorted = new Int32Array(n);
        for (let i = 0; i < n; i++) sorted[sizes[rows[off + pos[i]]]++] = pos[i];
        for (const p of touched) sizes[p] = 0;

        let total = 0;
        for (let j = 0; j < touched.length; j++) {
            const p = touched[j];
            if (p === ALL_GREEN) continue;
            const start = starts[j], end = j + 1 < touched.length ? starts[j + 1] : n;
            if (end - start === n) return Infinity; // 何も絞り込めない推測
            const nextCons = hard ? this.addConstraint(cons, g, p) : cons;
            total += (end - start) * this._solveCost(sorted.subarray(start, end), depth, hard, nextCons, turn + 1);
        }
        return this.guessCost(turn + 1) + total / n;
    }

    /** 候補（位置 pos）を解き切るまでの平均手数（次の1手を含む）の最小値 */
    _solveCost(pos, depth, hard, cons, turn) {
        const n = pos.length;
        if (n <= 2) return this.leafCost(n, turn);
        const memo = this._search.memo;
        const key = `${depth} ${turn} ${cons.key} ${pos.join(',')}`;
        const cached = memo.get(key);
        if (cached !== undefined) return cached;

        let best;
        if (depth <= 0) {
            const [first] = this._scoreSub(pos, hard, cons, turn, 1);
            // 少数なら最後まで解いてみる（ハードモードの _OUND のような罠を見抜くため）
            best = n <= this.params.rolloutMax
                ? this._expectedWithLookahead(first.g, pos, 0, hard, cons, turn)
                : first.expected;
        } else {
            best = Infinity;
            for (const s of this._scoreSub(pos, hard, cons, turn, this.params.innerK)) {
                best = Math.min(best, this._expectedWithLookahead(s.g, pos, depth - 1, hard, cons, turn));
            }
        }
        memo.set(key, best);
        return best;
    }

    /**
     * 次に入力すべき単語のランキングを返す。
     * history: [{word, pattern}], hard: ハードモードか, limit: 返す件数, depth: 先読みの深さ（省略時は候補数で自動）,
     * params: 探索パラメータの上書き, book: 定跡（book.js の NORMAL_BOOK / HARD_BOOK。モードが違えば使わない）
     * 戻り値: { candidates: string[], ranking: [{word, expected, isCandidate}] }
     */
    rank(history, { hard = false, limit = 30, depth, params, book } = {}) {
        this.params = { ...DEFAULT_PARAMS, ...params };
        this.clusterWeight = hard ? this.params.clusterWeightHard : this.params.clusterWeightNormal;
        this.cost = hard ? this.params.costHard : this.params.costNormal;
        const cands = this.candidates(history);
        if (cands.length === 0) return { candidates: [], ranking: [] };

        let cons = this.emptyConstraint();
        for (const h of history) {
            const g = this.index.get(h.word);
            if (g !== undefined) cons = this.addConstraint(cons, g, h.pattern);
        }

        const n = cands.length, W = this.words.length;
        let liveMask = 0;
        for (const a of cands) for (let j = 0; j < 5; j++) liveMask |= 1 << this.codes[a * 5 + j];
        this._search = {
            cands,
            liveMask,
            rows: new Uint8Array(W * n),
            posValue: this._buildPosValue(cands),
            rowOff: new Int32Array(W).fill(-1),
            rowByKey: new Map(),
            pats: new Uint8Array(n),
            mark: new Int32Array(W),
            stamp: 0,
            leafTables: [],
            memo: new Map(),
            extra: [],
        };
        try {
            const isCand = new Uint8Array(W);
            for (const a of cands) isCand[a] = 1;
            const clusters = this.clusterWeight > 0 ? this.clusters(cands) : [];
            const useClusters = clusters.length > 0 ? clusters : null;
            const turn = history.length;
            const scored = [];
            const evaluated = new Map(); // 行の位置 → [見積もり, エントロピー]（行を共有する語は評価も同じ）
            for (let g = 0; g < W; g++) {
                if (hard && !this.hardOk(g, cons)) continue;
                const off = this._row(g);
                let e = evaluated.get(off);
                if (!e) {
                    e = [this._evaluate(this._search.rows.subarray(off, off + n), n, turn, useClusters), this._entropy];
                    evaluated.set(off, e);
                }
                scored.push({ g, isCandidate: isCand[g] === 1, expected: e[0], entropy: e[1] });
            }
            scored.sort(compareScored);

            if (n > 2) {
                // 上位候補は決定木を先読みして平均手数を精密化（候補が少ないほど深く読む）
                if (depth === undefined) depth = n <= this.params.depth2Max ? 2 : n <= this.params.depth1Max ? 1 : 0;
                this._search.extra = scored.slice(0, this.params.extraPool).map(s => s.g);
                const top = scored.slice(0, this.params.topK);
                const all = Int32Array.from(cands, (_, i) => i);
                for (const s of top) {
                    s.expected = this._expectedWithLookahead(s.g, all, depth, hard, cons, turn);
                }
                top.sort(compareScored);
                scored.splice(0, top.length, ...top);
            }

            // 定跡（事前に最後まで解かせて選んだ2語目）があれば先頭にする
            const entry = book && book.hard === hard && history.length === 1 && history[0].word === book.opener
                ? book.second[history[0].pattern] : null;
            const bookIndex = entry ? scored.findIndex(s => this.words[s.g] === entry.word) : -1;
            if (bookIndex >= 0) {
                const [s] = scored.splice(bookIndex, 1);
                scored.unshift({ ...s, expected: entry.expected, fromBook: true });
            }

            const toResult = s => ({
                word: this.words[s.g],
                expected: s.expected,
                isCandidate: s.isCandidate,
                fromBook: !!s.fromBook,
            });
            // 候補単語はランキング順に並べる
            const candidates = scored.filter(s => s.isCandidate).map(s => this.words[s.g]);
            return { candidates, ranking: scored.slice(0, limit).map(toResult) };
        } finally {
            this._search = null;
        }
    }
}
