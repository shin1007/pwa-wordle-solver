import { ANSWERS, ALLOWED } from './words.js';
import { OPENING_RANKING, OPENING_RANKING_HARD } from './opening.js';
import { colorsToPattern } from './solver.js';
import { NORMAL_BOOK, HARD_BOOK } from './book.js';

const wordCountSpan = document.getElementById('word-count');
const bestWordSpan = document.getElementById('best-word');
const hardModeButton = document.getElementById('hard-mode-btn');
const contrastButton = document.getElementById('contrast-btn');
const hardBadge = document.getElementById('hard-badge');
const wordListPanel = document.getElementById('word-list-panel');
const wordListContainer = document.getElementById('word-list-container');
const wordListCloseButton = document.getElementById('word-list-close');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const possibleWordsCountButton = document.getElementById('possible-words-count-btn');
const keyboard = document.getElementById('keyboard');
const toast = document.getElementById('toast');
const helpDialog = document.getElementById('help-dialog');
const settingsDialog = document.getElementById('settings-dialog');
const rows = Array.from(document.querySelectorAll('#input-section .row'));

const COLORS = ['gray', 'yellow', 'green'];

let activeInputRow = null;
let currentInputPosition = 0;
let originalRowBeforeEdit = null; // 再編集前の行（文字と色）を保存する変数。新規入力のときは null

// 入力可能な単語（正解候補 + 入力可能単語）
const validWords = new Set([...ANSWERS, ...ALLOWED]);

// ブラウザに保存した設定を読み書きする（ストレージが使えなくても動作させる）
function loadSetting(key) {
    try {
        return localStorage.getItem(key) === 'true';
    } catch (e) {
        return false;
    }
}

function saveSetting(key, value) {
    try {
        localStorage.setItem(key, String(value));
    } catch (e) { /* 保存できなくても続行 */ }
}

// ハードモード（設定はブラウザに保存）
let hardMode = loadSetting('hardMode');

// モードごとの最初に入れておく単語（全正解でのシミュレーション結果から選定した、定跡（book.js）の1語目）
const STARTING_WORDS = { normal: [NORMAL_BOOK.opener], hard: [HARD_BOOK.opener] };

// 表示する「おすすめ」の件数
const RANKING_DISPLAY_COUNT = 20;

// マスの色を取得・設定する
function cellColor(cell) {
    return COLORS.find(color => cell.classList.contains(color)) || null;
}

function setCellColor(cell, color) {
    cell.classList.remove(...COLORS);
    if (color) cell.classList.add(color);
}

// アニメーションを最初から再生する
function playAnimation(element, className) {
    element.classList.remove(className);
    void element.offsetWidth; // 付け直したクラスでアニメーションをやり直させる
    element.classList.add(className);
    element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

// 一言メッセージを表示する（action を渡すと「元に戻す」などのボタンを付ける）
let toastTimer = null;
function showToast(message, action = null) {
    toast.replaceChildren(message);
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.addEventListener('click', () => {
            action.run();
            hideToast();
        });
        toast.appendChild(button);
    }
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 5000 : 1800);
}

function hideToast() {
    toast.classList.remove('show');
}

// 盤面が変わったら、候補・キーボードの色を更新する
function boardChanged() {
    displayPossibleWords();
    updateKeyboard();
}

// マスの色を変更する関数
function changeCellColor(cell) {
    // 編集中の行の色は変更しない
    if (cell.parentElement.classList.contains('editing')) {
        return;
    }

    // セルに文字がなければ何もしない
    if (cell.textContent.trim() === '') {
        return;
    }

    const currentColor = cellColor(cell);

    // 次の色に切り替える
    const nextColor = COLORS[(COLORS.indexOf(currentColor) + 1) % COLORS.length];

    const cellIndex = Array.from(cell.parentNode.children).indexOf(cell);
    const newLetter = cell.textContent.trim().toLowerCase();

    // もし次の色が黄色なら、ユニークな黄色文字が5つを超えないかチェック
    if (nextColor === 'yellow') {
        const uniqueYellowLetters = new Set();
        document.querySelectorAll('#input-section .cell.yellow').forEach(yellowCell => {
            uniqueYellowLetters.add(yellowCell.textContent.trim().toLowerCase());
        });
        // 新しい文字が既存の黄色文字セットになく、かつセットのサイズが既に5以上の場合
        if (!uniqueYellowLetters.has(newLetter) && uniqueYellowLetters.size >= 5) {
            showToast('黄色の文字は5種類までです');
            return; // 6種類目の黄色は許可しない
        }
    }

    // もし次の色が緑なら、同じ列に異なる文字の緑セルがあれば灰色に戻す
    if (nextColor === 'green') {
        rows.forEach(row => {
            const cellInSameColumn = row.children[cellIndex];
            const existingLetter = cellInSameColumn.textContent.trim().toLowerCase();
            if (cellInSameColumn.classList.contains('green') && existingLetter !== newLetter) {
                setCellColor(cellInSameColumn, 'gray');
            }
        });
    }

    setCellColor(cell, nextColor);
    boardChanged();
}

// 各マスにクリックイベントを追加
rows.forEach(row => {
    row.querySelectorAll('.cell').forEach(cell => {
        cell.addEventListener('click', () => {
            // 編集中の行は何もしない（長押しで編集を始めた直後のクリックもここに来る）
            if (row.classList.contains('editing')) return;
            if (row.classList.contains('fixed')) {
                // 確定済みの行は色を切り替える
                cancelEditing();
                changeCellColor(cell);
            } else {
                // 空の行は入力を始める
                startEditing(row);
            }
        });
    });
});

// 行の文字と色を保存・復元する
function snapshotRow(row) {
    return Array.from(row.children).map(cell => ({ letter: cell.textContent, color: cellColor(cell) }));
}

function restoreRow(row, snapshot) {
    row.classList.remove('editing');
    row.classList.toggle('fixed', !!snapshot);
    Array.from(row.children).forEach((cell, i) => {
        cell.textContent = snapshot ? snapshot[i].letter : '';
        setCellColor(cell, snapshot ? snapshot[i].color : null);
    });
}

// 入力位置のマスに印を付ける
function updateCursor() {
    document.querySelectorAll('#input-section .cell.cursor').forEach(cell => cell.classList.remove('cursor'));
    if (activeInputRow && currentInputPosition < 5) {
        activeInputRow.children[currentInputPosition].classList.add('cursor');
    }
}

// 行の編集を開始する関数
function startEditing(row) {
    if (activeInputRow === row) return;
    // 別の行を編集中なら、そちらは取り消す
    cancelEditing();

    const wasFixed = row.classList.contains('fixed');
    // 再編集の場合は元の行を保存しておく（取り消したときに戻す）
    originalRowBeforeEdit = wasFixed ? snapshotRow(row) : null;

    // 行の文字をクリアして、先頭から入力できるようにする
    row.querySelectorAll('.cell').forEach(cell => {
        cell.textContent = '';
        setCellColor(cell, null);
    });

    activeInputRow = row;
    currentInputPosition = 0; // 常に先頭から入力開始

    row.classList.remove('fixed');
    row.classList.add('editing');
    updateCursor();
    // 打ち直す行の情報を除いて候補を計算し直す
    if (wasFixed) boardChanged();
}

// 行の編集をキャンセルする関数
function cancelEditing() {
    if (!activeInputRow) return;

    // 再編集をキャンセルした場合は元の単語に戻し、新規入力をキャンセルした場合は文字をクリアする
    const restored = !!originalRowBeforeEdit;
    restoreRow(activeInputRow, originalRowBeforeEdit);
    activeInputRow = null;
    currentInputPosition = 0;
    originalRowBeforeEdit = null;
    updateCursor();
    if (restored) boardChanged();
}

// 入力欄が空いている最初の行
function firstEmptyRow() {
    return rows.find(row => !row.classList.contains('fixed')) || null;
}

// 1文字入力する
function typeLetter(letter) {
    if (!activeInputRow) {
        const row = firstEmptyRow();
        if (!row) {
            showToast('空いている行がありません（行を長押しで打ち直し）');
            return;
        }
        startEditing(row);
    }
    if (currentInputPosition >= 5) return;
    const cell = activeInputRow.children[currentInputPosition];
    cell.textContent = letter;
    currentInputPosition++;
    playAnimation(cell, 'pop');
    updateCursor();
}

// 1文字消す
function deleteLetter() {
    if (!activeInputRow || currentInputPosition === 0) return;
    currentInputPosition--;
    activeInputRow.children[currentInputPosition].textContent = '';
    updateCursor();
}

// 入力中の行を確定する
function submitRow() {
    if (!activeInputRow) return;

    if (currentInputPosition === 0) {
        // 打ち直し中の行を空のまま確定したら、その行を削除する
        if (originalRowBeforeEdit) {
            originalRowBeforeEdit = null;
            cancelEditing();
            showToast('行を削除しました');
        }
        return;
    }

    if (currentInputPosition < 5) {
        playAnimation(activeInputRow, 'shake');
        showToast('5文字入力してください');
        return;
    }

    validateAndFixWord(activeInputRow);
}

// ほかの確定済みの行から分かっている緑・黄を、新しく入れた単語に引き継ぐ
function inheritColors(word, row) {
    const others = rows.filter(r => r !== row && r.classList.contains('fixed')).map(snapshotRow);
    const colors = Array(5).fill('gray');

    // 同じ列で同じ文字が緑になっていれば緑
    for (let i = 0; i < 5; i++) {
        if (others.some(cells => cells[i].color === 'green' && cells[i].letter.toLowerCase() === word[i])) {
            colors[i] = 'green';
        }
    }

    // 答えに含まれると分かっている文字は、分かっている個数まで黄にする
    const knownCount = {};
    others.forEach(cells => {
        const count = {};
        cells.forEach(({ letter, color }) => {
            if (color === 'green' || color === 'yellow') {
                const l = letter.toLowerCase();
                count[l] = (count[l] || 0) + 1;
            }
        });
        for (const l in count) knownCount[l] = Math.max(knownCount[l] || 0, count[l]);
    });
    for (let i = 0; i < 5; i++) {
        if (colors[i] === 'green') knownCount[word[i]] = (knownCount[word[i]] || 0) - 1;
    }
    for (let i = 0; i < 5; i++) {
        if (colors[i] === 'gray' && knownCount[word[i]] > 0) {
            colors[i] = 'yellow';
            knownCount[word[i]]--;
        }
    }
    return colors;
}

// 入力された単語を検証し、行を固定する関数
function validateAndFixWord(row) {
    const cells = Array.from(row.querySelectorAll('.cell'));
    const word = cells.map(cell => cell.textContent.trim()).join('').toLowerCase();

    if (!validWords.has(word)) {
        // 無効な単語の場合
        playAnimation(row, 'shake');
        showToast('単語リストにない単語です');
        return;
    }

    // 同じ単語に打ち直した場合は元の色を残し、それ以外はほかの行から分かっている色を引き継ぐ
    const original = originalRowBeforeEdit;
    const keepColors = original && original.map(c => c.letter).join('').toLowerCase() === word;
    const colors = keepColors ? original.map(c => c.color) : inheritColors(word, row);

    row.classList.add('fixed'); // 行を固定
    row.classList.remove('editing');
    // 色はすぐに付け、1マスずつめくる演出は CSS で行う（めくり終わるまで色を隠す）
    cells.forEach((cell, i) => {
        setCellColor(cell, colors[i]);
        cell.style.setProperty('--i', i);
        playAnimation(cell, 'flip');
    });
    activeInputRow = null;
    currentInputPosition = 0;
    originalRowBeforeEdit = null;
    updateCursor();
    boardChanged();
}

// キー入力を処理する関数（物理キーボード・画面内キーボード共通）
function handleKey(key) {
    if (key === 'Enter') {
        submitRow();
    } else if (key === 'Backspace') {
        deleteLetter();
    } else if (key === 'Escape') {
        cancelEditing();
    } else if (/^[a-z]$/.test(key)) {
        typeLetter(key);
    }
}

function handlePhysicalKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // ダイアログ表示中はダイアログに任せる
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && wordListPanel.classList.contains('open')) {
        closeWordList();
        return;
    }
    // 画面内キーボード以外のボタンにフォーカスがあるときの Enter は、そのボタンに任せる
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === 'Enter' && target?.closest('button') && !target.closest('#keyboard')) return;

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (['Enter', 'Backspace', 'Escape'].includes(key) || /^[a-z]$/.test(key)) {
        event.preventDefault();
        handleKey(key);
    }
}

// 画面内キーボードを作る
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function createKey(key, label, ariaLabel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key';
    button.dataset.key = key;
    button.textContent = label;
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    return button;
}

function buildKeyboard() {
    KEYBOARD_ROWS.forEach((letters, i) => {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'kb-row';
        const spacer = () => Object.assign(document.createElement('div'), { className: 'kb-spacer' });

        if (i === 1) rowDiv.appendChild(spacer());
        if (i === 2) {
            const enterKey = createKey('Enter', 'ENTER', '確定');
            enterKey.classList.add('wide');
            rowDiv.appendChild(enterKey);
        }
        for (const letter of letters) {
            rowDiv.appendChild(createKey(letter, letter));
        }
        if (i === 2) {
            const backspaceKey = createKey('Backspace', '⌫', '1文字消す');
            backspaceKey.classList.add('wide');
            rowDiv.appendChild(backspaceKey);
        }
        if (i === 1) rowDiv.appendChild(spacer());

        keyboard.appendChild(rowDiv);
    });

    // キーにフォーカスを移さない（物理キーボードの Enter が二重に効かないように）
    keyboard.addEventListener('mousedown', event => event.preventDefault());
    keyboard.addEventListener('click', event => {
        const key = event.target.closest('.key');
        if (key) handleKey(key.dataset.key);
    });
}

// 確定済みの行から、文字ごとに分かっている一番良い色を集める（緑 > 黄 > 灰）
function letterStates() {
    const states = {};
    rows.filter(row => row.classList.contains('fixed')).forEach(row => {
        Array.from(row.children).forEach(cell => {
            const letter = cell.textContent.trim().toLowerCase();
            if (!letter) return;
            const color = cellColor(cell) || 'gray';
            if (!states[letter] || COLORS.indexOf(color) > COLORS.indexOf(states[letter])) {
                states[letter] = color;
            }
        });
    });
    return states;
}

// キーボードの色を更新する
function updateKeyboard() {
    const states = letterStates();
    keyboard.querySelectorAll('.key').forEach(key => {
        setCellColor(key, states[key.dataset.key] || null);
    });
}

// 確定済みの行から、入力した単語とその色（フィードバック）の履歴を作る
function collectHistory() {
    const history = [];
    rows.filter(row => row.classList.contains('fixed')).forEach(row => {
        const cells = Array.from(row.querySelectorAll('.cell'));
        const word = cells.map(cell => cell.textContent.trim().toLowerCase()).join('');
        if (word.length !== 5) return;
        const colors = cells.map(cell => cellColor(cell) || 'gray');
        history.push({ word, pattern: colorsToPattern(colors) });
    });
    return history;
}

// ランキング計算（Web Worker、使えない環境ではメインスレッドで計算）
let solverWorker = null;
let mainThreadSolver = null;
let latestRequestId = 0;
let latestRequest = null;

function startSolverWorker() {
    try {
        solverWorker = new Worker('./solver-worker.js', { type: 'module' });
        solverWorker.onmessage = event => renderRanking(event.data);
        solverWorker.onerror = () => {
            // モジュールWorker非対応などの場合はメインスレッドに切り替えて再計算
            solverWorker = null;
            if (latestRequest) runRanking(latestRequest);
        };
    } catch (e) {
        solverWorker = null;
    }
}

async function runRanking(request) {
    if (solverWorker) {
        solverWorker.postMessage(request);
        return;
    }
    if (!mainThreadSolver) {
        const { Solver } = await import('./solver.js');
        mainThreadSolver = new Solver();
    }
    const result = mainThreadSolver.rank(request.history, { hard: request.hard, limit: 30, book: request.hard ? HARD_BOOK : NORMAL_BOOK });
    renderRanking({ id: request.id, ...result });
}

// 1手目は定跡の1語目を先頭にする
function openingRanking() {
    const book = hardMode ? HARD_BOOK : NORMAL_BOOK;
    const opener = { word: book.opener, expected: book.expected, isCandidate: ANSWERS.includes(book.opener), fromBook: true };
    return [opener, ...(hardMode ? OPENING_RANKING_HARD : OPENING_RANKING).filter(r => r.word !== opener.word)];
}

// 候補単語とおすすめランキングを画面に表示する関数
function displayPossibleWords() {
    const history = collectHistory();
    const id = ++latestRequestId;
    if (history.length === 0) {
        // 1手目は事前計算済みのランキングを使う
        latestRequest = null;
        renderRanking({ id, candidates: ANSWERS, ranking: openingRanking() });
        return;
    }
    possibleWordsCountButton.classList.add('loading');
    bestWordSpan.textContent = '計算中';
    latestRequest = { id, history, hard: hardMode };
    runRanking(latestRequest);
}

function createSpan(className, text) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = text;
    return span;
}

// おすすめ単語の行（順位・単語・正解候補/定跡 と、タップで説明が開く平均手数）
function createWordItem(rank, r) {
    const wordRow = document.createElement('div');
    wordRow.className = 'word-row';

    const wordItem = document.createElement('button');
    wordItem.type = 'button';
    wordItem.className = 'word-item';
    wordItem.dataset.word = r.word;
    wordItem.appendChild(createSpan('word-rank', `${rank}.`));
    wordItem.appendChild(createSpan('word-text', r.word));
    if (r.isCandidate) {
        const chip = createSpan('chip star', '正解候補');
        chip.title = 'この単語がそのまま答えの可能性があります（当たればこの手で解けます）';
        wordItem.appendChild(chip);
    }
    if (r.fromBook) wordItem.appendChild(createSpan('chip book', '定跡'));

    const score = document.createElement('button');
    score.type = 'button';
    score.className = 'word-score';
    score.textContent = `${r.expected.toFixed(2)} 手`;
    score.setAttribute('aria-expanded', 'false');
    score.setAttribute('aria-label', `${r.expected.toFixed(2)} 手（数値の説明を表示）`);
    score.addEventListener('click', () => toggleScoreExplanation(wordRow, score, r));

    wordRow.append(wordItem, score);
    return wordRow;
}

// 数値の説明を単語の下に開く（同時に開くのは1つだけ）
function toggleScoreExplanation(wordRow, score, r) {
    const wasOpen = score.getAttribute('aria-expanded') === 'true';
    wordListContainer.querySelectorAll('.score-explain').forEach(el => el.remove());
    wordListContainer.querySelectorAll('.word-score[aria-expanded="true"]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    if (wasOpen) return;

    const word = r.word.toUpperCase();
    const expected = r.expected.toFixed(2);
    const used = collectHistory().length; // ここまでに使った手数
    const lines = [
        `次に ${word} を入れると、この1手を含めて<b>平均およそ ${expected} 手</b>で解ける見込みです。`,
    ];
    if (used > 0) {
        lines.push(`ここまでの ${used} 手と合わせると、合計でおよそ ${(used + r.expected).toFixed(1)} 手です。`);
    }
    lines.push(r.isCandidate
        ? `${word} は答えの可能性もあるので、当たればこの手で解けます。`
        : `${word} は答えにはなりませんが、候補を絞り込むのに役立つ単語です。`);
    if (r.fromBook) lines.push('「定跡」は、事前に全パターンを計算して選んだ手順の一手です。');
    lines.push('<span class="note">※ 5手以上かかる展開は少し減点して計算しているため、純粋な平均より少し大きめに出ます。小さいほど良い手です。</span>');

    const explain = document.createElement('div');
    explain.className = 'score-explain';
    explain.innerHTML = lines.map(line => `<p>${line}</p>`).join('');
    wordRow.after(explain);
    score.setAttribute('aria-expanded', 'true');
}

function createListHeader(text, legend = '') {
    const header = document.createElement('div');
    header.className = 'word-list-header';
    header.textContent = text;
    if (legend) header.appendChild(createSpan('word-list-legend', legend));
    return header;
}

function renderRanking({ id, candidates, ranking }) {
    // 古いリクエストの結果は捨てる
    if (id !== latestRequestId) return;

    possibleWordsCountButton.classList.remove('loading');
    wordListContainer.replaceChildren();

    if (candidates.length === 0) {
        bestWordSpan.textContent = '該当なし';
        wordCountSpan.textContent = '色の付け方を確認';
        const empty = document.createElement('div');
        empty.className = 'word-list-empty';
        empty.textContent = '条件に合う単語がありません。マスの色が本家の結果と同じか確認してください。';
        wordListContainer.appendChild(empty);
        return;
    }
    bestWordSpan.textContent = ranking[0].word;
    wordCountSpan.textContent = `候補 ${candidates.length} 語`;

    // おすすめ順（数値は「この単語を含めて平均あと何手で解けるか」に、5手以上かかる展開への減点を加えたスコア）
    wordListContainer.appendChild(createListHeader('おすすめの次の一手', '数値：この単語を含めて平均あと何手で解けるかの目安（小さいほど良い、タップで説明）　正解候補：この単語がそのまま答えの可能性あり'));
    ranking.slice(0, RANKING_DISPLAY_COUNT).forEach((r, i) => {
        wordListContainer.appendChild(createWordItem(i + 1, r));
    });

    wordListContainer.appendChild(createListHeader(`正解の候補（${candidates.length} 語）`));
    const candidateList = document.createElement('div');
    candidateList.className = 'candidates';
    candidates.forEach(word => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'candidate';
        item.dataset.word = word;
        item.textContent = word;
        candidateList.appendChild(item);
    });
    wordListContainer.appendChild(candidateList);
}

// 設定の表示を更新
function updateHardModeButton() {
    hardModeButton.setAttribute('aria-checked', String(hardMode));
    hardBadge.hidden = !hardMode;
}

function updateContrastButton() {
    contrastButton.setAttribute('aria-checked', String(document.documentElement.dataset.contrast === 'high'));
}

hardModeButton.addEventListener('click', () => {
    hardMode = !hardMode;
    saveSetting('hardMode', hardMode);
    updateHardModeButton();
    // まだ色を付けていなければ、初期単語を新しいモードのものに差し替える
    const previousWords = STARTING_WORDS[hardMode ? 'normal' : 'hard'];
    if (!activeInputRow && isUntouchedStartingBoard(previousWords)) {
        fillStartingWords();
    }
    boardChanged();
});

contrastButton.addEventListener('click', () => {
    const highContrast = document.documentElement.dataset.contrast !== 'high';
    if (highContrast) {
        document.documentElement.dataset.contrast = 'high';
    } else {
        delete document.documentElement.dataset.contrast;
    }
    saveSetting('highContrast', highContrast);
    updateContrastButton();
});

// 盤面が初期単語（すべて灰色）のままかどうか
function isUntouchedStartingBoard(words) {
    return rows.every((row, i) => {
        const cells = Array.from(row.querySelectorAll('.cell'));
        const text = cells.map(cell => cell.textContent.trim().toLowerCase()).join('');
        const colored = cells.some(cell => cell.classList.contains('yellow') || cell.classList.contains('green'));
        return text === (words[i] || '') && !colored;
    });
}

// 盤面を空にして、現在のモードの初期単語を入れる
function fillStartingWords() {
    const words = STARTING_WORDS[hardMode ? 'hard' : 'normal'];
    rows.forEach((row, i) => {
        const word = words[i];
        // 初期単語が入っている行は固定状態にする
        restoreRow(row, word ? Array.from(word, letter => ({ letter, color: 'gray' })) : null);
    });
}

// 盤面をリセットする（直後なら元に戻せる）
function resetBoard() {
    cancelEditing();
    const snapshot = rows.map(row => row.classList.contains('fixed') ? snapshotRow(row) : null);
    fillStartingWords();
    boardChanged();
    showToast('リセットしました', {
        label: '元に戻す',
        run: () => {
            cancelEditing();
            rows.forEach((row, i) => restoreRow(row, snapshot[i]));
            boardChanged();
        },
    });
}

// おすすめ・一覧の単語を入力欄に入れて、ENTER なしでそのまま確定する
function addSelectedWordToInput(word) {
    let row = activeInputRow;
    if (!row) {
        row = firstEmptyRow();
        if (!row) {
            showToast('空いている行がありません（行を長押しで打ち直し）');
            return;
        }
        startEditing(row);
    }
    Array.from(row.children).forEach((cell, i) => {
        cell.textContent = word[i];
    });
    currentInputPosition = 5;
    updateCursor();
    validateAndFixWord(row);
}

// 候補の一覧を開く・閉じる（横画面では常に表示されている）
function openWordList() {
    wordListPanel.classList.add('open');
    sheetBackdrop.classList.add('open');
    wordListContainer.scrollTop = 0;
}

function closeWordList() {
    wordListPanel.classList.remove('open');
    sheetBackdrop.classList.remove('open');
}

// 「次のおすすめ」: タップで一覧を開き、長押しでその単語を入力して確定する
const LONG_PRESS_MS = 500;
let bestPressTimer = null;
let bestLongPressed = false;

function cancelBestPress() {
    clearTimeout(bestPressTimer);
}

possibleWordsCountButton.addEventListener('pointerdown', () => {
    bestLongPressed = false;
    cancelBestPress();
    bestPressTimer = window.setTimeout(() => {
        const word = bestWordSpan.textContent.trim();
        if (!validWords.has(word)) return;
        bestLongPressed = true;
        navigator.vibrate?.(30);
        addSelectedWordToInput(word);
    }, LONG_PRESS_MS);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(type =>
    possibleWordsCountButton.addEventListener(type, cancelBestPress));
possibleWordsCountButton.addEventListener('contextmenu', event => event.preventDefault());
possibleWordsCountButton.addEventListener('click', () => {
    if (bestLongPressed) {
        bestLongPressed = false; // 長押しの直後のクリックでは一覧を開かない
        return;
    }
    openWordList();
});
wordListCloseButton.addEventListener('click', closeWordList);
sheetBackdrop.addEventListener('click', closeWordList);
wordListContainer.addEventListener('click', (event) => {
    // クリックされた要素が単語の場合だけ入力・確定して閉じる（スクロールや余白のタップでは閉じない）
    const wordItem = event.target.closest('[data-word]');
    if (wordItem) {
        addSelectedWordToInput(wordItem.dataset.word);
        closeWordList();
    }
});

// ダイアログの外側（背景）をクリックしたら閉じる
function closeOnBackdropClick(dialog) {
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
}

// アプリケーション起動時の初期化
document.addEventListener('DOMContentLoaded', () => {
    startSolverWorker();   // ランキング計算用のWorkerを起動する
    buildKeyboard();
    updateHardModeButton();
    updateContrastButton();
    fillStartingWords();   // グリッドを初期化する
    boardChanged();

    // 物理キーボード入力イベントリスナーを追加
    document.addEventListener('keydown', handlePhysicalKey);

    document.getElementById('reset-btn').addEventListener('click', resetBoard);
    document.getElementById('help-btn').addEventListener('click', () => helpDialog.showModal());
    document.getElementById('settings-btn').addEventListener('click', () => settingsDialog.showModal());
    closeOnBackdropClick(helpDialog);
    closeOnBackdropClick(settingsDialog);

    // 初めて開いたときは使い方を表示する
    if (!loadSetting('helpSeen')) {
        helpDialog.showModal();
        saveSetting('helpSeen', true);
    }

    // 盤面・キーボード・一覧の外をクリックしたら編集をキャンセルする
    document.addEventListener('click', (event) => {
        if (activeInputRow && !event.target.closest('#input-section, #keyboard, #word-list-panel, #possible-words-count-btn, .toast, dialog')) {
            cancelEditing();
        }
    });

    // 各行に長押しイベントを追加（長押しで打ち直し）
    rows.forEach(row => {
        let pressTimer;

        const startPress = () => {
            // 固定された行でのみ長押しを有効にする
            if (row.classList.contains('fixed')) {
                pressTimer = window.setTimeout(() => startEditing(row), 600);
            }
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };

        // マウスイベント
        row.addEventListener('mousedown', startPress);
        row.addEventListener('mouseup', cancelPress);
        row.addEventListener('mouseleave', cancelPress);

        // タッチイベント
        row.addEventListener('touchstart', startPress, { passive: true });
        row.addEventListener('touchend', cancelPress);
        row.addEventListener('touchmove', cancelPress, { passive: true });
        row.addEventListener('touchcancel', cancelPress);
    });
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
        .then(registration => {
            console.log('Service Worker registered:', registration);
        })
        .catch(error => {
            console.error('Service Worker registration failed:', error);
        });
    });
}
