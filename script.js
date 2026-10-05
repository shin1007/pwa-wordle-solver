import { ANSWERS, ALLOWED } from './words.js';
import { OPENING_RANKING, OPENING_RANKING_HARD } from './opening.js';
import { colorsToPattern } from './solver.js';
import { NORMAL_BOOK, HARD_BOOK } from './book.js';

const wordCountSpan = document.getElementById('word-count');
const bestWordSpan = document.getElementById('best-word');
const hardModeButton = document.getElementById('hard-mode-btn');
const wordListContainer = document.getElementById('word-list-container');
const possibleWordsCountButton = document.getElementById('possible-words-count-btn');
const hiddenInput = document.getElementById('hidden-input');


let activeInputRow = null;
let currentInputPosition = 0;
let originalWordBeforeEdit = ''; // 再編集前の単語を保存する変数

// 入力可能な単語（正解候補 + 入力可能単語）
const validWords = new Set([...ANSWERS, ...ALLOWED]);

// ハードモード（設定はブラウザに保存）
let hardMode = false;
try {
    hardMode = localStorage.getItem('hardMode') === 'true';
} catch (e) { /* ストレージが使えなくても動作させる */ }

// モードごとの最初に入れておく単語（全正解でのシミュレーション結果から選定した、定跡（book.js）の1語目）
const STARTING_WORDS = { normal: [NORMAL_BOOK.opener], hard: [HARD_BOOK.opener] };

// 表示する「おすすめ」の件数
const RANKING_DISPLAY_COUNT = 20;

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

    const colors = ['gray', 'yellow', 'green'];
    let currentColor = null;

    // 現在の色を取得
    for (const color of colors) {
        if (cell.classList.contains(color)) {
            currentColor = color;
            break;
        }
    }

    // 次の色に切り替える
    let nextColorIndex = (colors.indexOf(currentColor) + 1) % colors.length;
    let nextColor = colors[nextColorIndex];

    const cellIndex = Array.from(cell.parentNode.children).indexOf(cell);
    const allRows = document.querySelectorAll('#input-section .row');

    // もし次の色が緑なら、同じ列に異なる文字の緑セルがあればリセット
    if (nextColor === 'green') {
        const newLetter = cell.textContent.trim().toLowerCase();
        allRows.forEach(row => {
            const cellInSameColumn = row.children[cellIndex];
            const existingLetter = cellInSameColumn.textContent.trim().toLowerCase();
            if (cellInSameColumn.classList.contains('green') && existingLetter !== newLetter) {
                cellInSameColumn.classList.remove('green');
            }
        });
    }

    // もし次の色が黄色なら、ユニークな黄色文字が5つを超えないかチェック
    if (nextColor === 'yellow') {
        const newLetter = cell.textContent.trim().toLowerCase();
        if (newLetter) {
            const uniqueYellowLetters = new Set();
            document.querySelectorAll('#input-section .cell.yellow').forEach(yellowCell => {
                uniqueYellowLetters.add(yellowCell.textContent.trim().toLowerCase());
            });
            // 新しい文字が既存の黄色文字セットになく、かつセットのサイズが既に5以上の場合
            if (!uniqueYellowLetters.has(newLetter) && uniqueYellowLetters.size >= 5) {
                return; // 6種類目の黄色は許可しない
            }
        }
    }

    // クラスを付け替える
    if (currentColor) {
        cell.classList.remove(currentColor);
    }
    cell.classList.add(nextColor);
    displayPossibleWords();
    updateSolutionSection();
}

// 各マスにクリックイベントを追加
document.querySelectorAll('#input-section .cell').forEach(cell => {
    cell.addEventListener('click', (event) => {
        const row = cell.parentElement;
        // 編集中の行はキャンセルしない
        if (row.classList.contains('editing')) {
            startEditing(row); 
        // 既に文字が入っているセルをクリックした場合
        } else if (cell.textContent.trim().length > 0) {
            changeCellColor(cell);
            cancelEditing(row);
        // 空のセルをクリックした場合
        } else {
            startEditing(row);
        }
    });
});

// 行の編集を開始する関数
function startEditing(row) {
    displayPossibleWords();
    // 再編集の場合、元の単語を保存し、fixedクラスを削除
    if (originalWordBeforeEdit.length === 0) {
        originalWordBeforeEdit = Array.from(row.children).map(cell => cell.textContent).join('');
    }

    // 行の文字をクリアして、先頭から入力できるようにする
    row.querySelectorAll('.cell').forEach(cell => {
        cell.textContent = null;
        // 背景色をリセットするために、色クラスを削除
        cell.classList.remove('gray', 'yellow', 'green');
    });

    activeInputRow = row;
    currentInputPosition = 0; // 常に先頭から入力開始

    row.classList.remove('fixed');
    row.classList.add('editing');
    // スマホのキーボードをアクティベートするために非表示inputにフォーカス
    hiddenInput.focus();
}

// 行の編集をキャンセルする関数
function cancelEditing() {
    hiddenInput.blur(); // フォーカスを外してキーボードを閉じる
    if (!activeInputRow) return;

    if (originalWordBeforeEdit) {
        // 再編集をキャンセルした場合は元の単語に戻す
        activeInputRow.querySelectorAll('.cell').forEach((cell, index) => {
            cell.textContent = originalWordBeforeEdit[index] || '';
        });
        activeInputRow.classList.add('fixed'); // 再び固定する
    } else {
        // 新規入力をキャンセルした場合は文字をクリア
        activeInputRow.querySelectorAll('.cell').forEach(cell => {
            cell.textContent = '';
        });
    }
    activeInputRow.classList.remove('editing');
    activeInputRow = null;
    currentInputPosition = 0;
    originalWordBeforeEdit = '';
}

// 入力された単語を検証し、行を固定する関数
function validateAndFixWord(row) {
    const cells = row.querySelectorAll('.cell');
    let word = '';
    cells.forEach(cell => {
        word += cell.textContent.trim();
    });

    if (word.length === 5) {
        if (validWords.has(word.toLowerCase())) {
            // 有効な単語の場合
            row.classList.add('fixed'); // 行を固定
            row.classList.remove('editing');
            cells.forEach(cell => cell.classList.add('gray')); // 文字をグレーに
            activeInputRow = null;
            currentInputPosition = 0;
            displayPossibleWords();
            updateSolutionSection();
        } else {
            // 無効な単語の場合
            const container = document.querySelector('.container');
            container.classList.add('shake');
            setTimeout(() => container.classList.remove('shake'), 500);
        }
    }
}

// キー入力を処理する関数
function handleKeyInput(event) {
    // 物理キーボード用の処理
    if (!activeInputRow) return;

    const { key } = event;
    const cells = activeInputRow.querySelectorAll('.cell');

    if (key === 'Backspace' && currentInputPosition > 0) {
        currentInputPosition--;
        cells[currentInputPosition].textContent = '';
    } else if (key === 'Enter' && currentInputPosition === 5) {
        validateAndFixWord(activeInputRow);
    } else if (key === 'Escape') {
        cancelEditing();
    }
}

// スマホのソフトウェアキーボードからの入力を処理する関数
function handleSoftwareKeyInput(event) {
    if (!activeInputRow) return;

    const cells = activeInputRow.querySelectorAll('.cell');
    const inputType = event.inputType;
    const data = event.data;

    // 物理キーボードとソフトウェアキーボード両方の文字入力を処理
    if (inputType === 'insertText' && data) {
        // 1文字ずつ処理
        for (const char of data.toLowerCase()) {
            if (char.match(/^[a-z]$/) && currentInputPosition < 5) {
                cells[currentInputPosition].textContent = char;
                currentInputPosition++;
                if (currentInputPosition === 5) {
                    validateAndFixWord(activeInputRow);
                }
            }
        }
    }

    hiddenInput.value = ''; // inputを常に空にしておく
}

// 確定済みの行から、入力した単語とその色（フィードバック）の履歴を作る
function collectHistory() {
    const history = [];
    document.querySelectorAll('#input-section .row.fixed').forEach(row => {
        const cells = Array.from(row.querySelectorAll('.cell'));
        const word = cells.map(cell => cell.textContent.trim().toLowerCase()).join('');
        if (word.length !== 5) return;
        const colors = cells.map(cell =>
            cell.classList.contains('green') ? 'green' :
            cell.classList.contains('yellow') ? 'yellow' : 'gray');
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
    bestWordSpan.textContent = 'thinking...';
    latestRequest = { id, history, hard: hardMode };
    runRanking(latestRequest);
}

function createWordItem(label, note, word) {
    const wordItem = document.createElement('div');
    wordItem.classList.add('word-item');
    wordItem.dataset.word = word;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    wordItem.appendChild(labelSpan);
    if (note) {
        const noteSpan = document.createElement('span');
        noteSpan.classList.add('word-note');
        noteSpan.textContent = note;
        wordItem.appendChild(noteSpan);
    }
    return wordItem;
}

function createListHeader(text) {
    const header = document.createElement('div');
    header.classList.add('word-list-header');
    header.textContent = text;
    return header;
}

function renderRanking({ id, candidates, ranking }) {
    // 古いリクエストの結果は捨てる
    if (id !== latestRequestId) return;

    wordCountSpan.textContent = `see ${candidates.length} possible words`;
    wordListContainer.innerHTML = '';

    if (candidates.length === 0) {
        bestWordSpan.textContent = 'no match';
        wordListContainer.appendChild(createListHeader('no possible words - check the colors'));
        return;
    }
    bestWordSpan.textContent = `next: ${ranking[0].word}`;

    // おすすめ順（数値は「この単語を含めて平均あと何手で解けるか」に、5手以上かかる展開への減点を加えたスコア。★は正解の可能性あり）
    wordListContainer.appendChild(createListHeader('best next guesses (score ≈ avg. guesses to solve)'));
    ranking.slice(0, RANKING_DISPLAY_COUNT).forEach((r, i) => {
        const note = `${r.fromBook ? 'book ' : ''}${r.expected.toFixed(2)}${r.isCandidate ? ' ★' : ''}`;
        wordListContainer.appendChild(createWordItem(`${i + 1}. ${r.word}`, note, r.word));
    });

    wordListContainer.appendChild(createListHeader(`possible answers (${candidates.length})`));
    candidates.forEach(word => {
        wordListContainer.appendChild(createWordItem(word, '', word));
    });
}

// ハードモードの表示を更新
function updateHardModeButton() {
    hardModeButton.textContent = `hard mode: ${hardMode ? 'ON' : 'OFF'}`;
    hardModeButton.classList.toggle('on', hardMode);
}

hardModeButton.addEventListener('click', () => {
    hardMode = !hardMode;
    try {
        localStorage.setItem('hardMode', String(hardMode));
    } catch (e) { /* 保存できなくても続行 */ }
    updateHardModeButton();
    // まだ色を付けていなければ、初期単語を新しいモードのものに差し替える
    const previousWords = STARTING_WORDS[hardMode ? 'normal' : 'hard'];
    if (!activeInputRow && isUntouchedStartingBoard(previousWords)) {
        fillStartingWords();
    }
    displayPossibleWords();
});

// 盤面が初期単語（すべて灰色）のままかどうか
function isUntouchedStartingBoard(words) {
    return Array.from(document.querySelectorAll('#input-section .row')).every((row, i) => {
        const cells = Array.from(row.querySelectorAll('.cell'));
        const text = cells.map(cell => cell.textContent.trim().toLowerCase()).join('');
        const colored = cells.some(cell => cell.classList.contains('yellow') || cell.classList.contains('green'));
        return text === (words[i] || '') && !colored;
    });
}

// 盤面を空にして、現在のモードの初期単語を入れる
function fillStartingWords() {
    const words = STARTING_WORDS[hardMode ? 'hard' : 'normal'];
    document.querySelectorAll('#input-section .row').forEach((row, i) => {
        const word = words[i] || '';
        row.classList.remove('fixed', 'editing');
        row.querySelectorAll('.cell').forEach((cell, j) => {
            cell.textContent = word[j] || '';
            cell.classList.remove('gray', 'yellow', 'green');
            if (word) cell.classList.add('gray');
        });
        // 初期単語が入っている行は固定状態にする
        if (word) row.classList.add('fixed');
    });
    updateSolutionSection();
}

function addSelectedWordToInput(word) {
    // 編集中の行がなければ、背景が白くなっている行を編集モードにする
    const rows = document.querySelectorAll('#input-section .row');
    for (const row of rows) {
        const cells = row.querySelectorAll('.cell');
        let isEmpty = true;
        for (const cell of cells) {
            if (cell.classList.contains('gray')) {
                isEmpty = false;
            }
            if (cell.classList.contains('yellow')) {
                isEmpty = false;
            }
            if (cell.classList.contains('green')) {
                isEmpty = false;
            }
        }
        if (isEmpty) {
            startEditing(row);
            break;
        }
    }
    const inputCells = activeInputRow.querySelectorAll('.cell');
    for (let i = 0; i < 5; i++) {
        inputCells[i].textContent = word[i];
    }
    validateAndFixWord(activeInputRow);
}

// 候補リストの表示/非表示を切り替える
possibleWordsCountButton.addEventListener('click', (event) => {
    possibleWordsCountButton.classList.add('hidden');
    wordListContainer.classList.remove('hidden');
});
// 候補リストの表示/非表示を切り替える
wordListContainer.addEventListener('click', (event) => {
    // クリックされた要素が単語アイテム(.word-item)の場合
    const wordItem = event.target.closest('.word-item');
    if (wordItem) {
        addSelectedWordToInput(wordItem.dataset.word);
    }
    // 単語を選択した場合でも、背景をクリックした場合でもリストを非表示にする
    wordListContainer.classList.add('hidden');
    possibleWordsCountButton.classList.remove('hidden');
});

// 解答セクションを更新する関数
function updateSolutionSection() {
    const inputRows = document.querySelectorAll('#input-section .row');
    const greenLettersInPosition = Array(5).fill('');
    const yellowLetterSet = new Set();

    // 入力セクションから緑色と黄色の文字情報を収集
    inputRows.forEach(row => {
        const cells = row.querySelectorAll('.cell');
        cells.forEach((cell, index) => {
            const letter = cell.textContent.trim().toLowerCase();
            if (!letter) return;

            if (cell.classList.contains('green')) {
                greenLettersInPosition[index] = letter;
            } else if (cell.classList.contains('yellow')) {
                // 黄色の文字が既に含まれていないか確認してから追加
                yellowLetterSet.add(letter);
            }
        });
    });

    // 黄色の文字リストから、緑色で確定した文字を除外する
    const greenLetters = greenLettersInPosition.filter(letter => letter !== '');
    greenLetters.forEach(letter => yellowLetterSet.delete(letter));
    const yellowLetters = Array.from(yellowLetterSet);


    // 緑色のマスを更新
    const greenCells = document.querySelectorAll('#solution-grid .green-row .cell');
    greenCells.forEach((cell, index) => {
        cell.textContent = greenLettersInPosition[index].toUpperCase() || '';
    });

    // 黄色のマスを更新
    const yellowCells = document.querySelectorAll('#solution-grid .yellow-row .cell');
    yellowCells.forEach((cell, index) => {
        cell.textContent = yellowLetters[index] ? yellowLetters[index].toUpperCase() : '';
    });
}

// グリッドの初期状態を設定する関数
function initializeGrid() {
    fillStartingWords();
    // 初期状態に基づいて候補単語と解答サマリーを更新
    displayPossibleWords();
    updateSolutionSection();
}

// アプリケーション起動時の初期化
document.addEventListener('DOMContentLoaded', () => {
    // スマホでの文字列選択を無効にする
    document.body.style.webkitUserSelect = 'none';
    document.body.style.mozUserSelect = 'none';
    document.body.style.msUserSelect = 'none';
    document.body.style.userSelect = 'none';

    startSolverWorker();   // ランキング計算用のWorkerを起動する
    updateHardModeButton();
    initializeGrid();      // グリッドを初期化する

    // 物理キーボード入力イベントリスナーを追加
    document.addEventListener('keydown', handleKeyInput);
    // ソフトウェアキーボード入力イベントリスナーを追加
    hiddenInput.addEventListener('input', handleSoftwareKeyInput);

    // グリッド外クリックで編集をキャンセルするイベントリスナー
    document.addEventListener('click', (event) => {
        // クリックされた要素が入力セクションやその子孫でない場合に編集をキャンセル
        if (activeInputRow && !event.target.closest('.container')) {
            cancelEditing();
        }
    });

    // 各行に長押しイベントを追加
    document.querySelectorAll('#input-section .row').forEach(row => {
        let pressTimer;

        const startPress = (e) => {
            // 固定された行でのみ長押しを有効にする
            if (row.classList.contains('fixed')) {
                pressTimer = window.setTimeout(() => startEditing(row), 800);
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
        row.addEventListener('touchstart', startPress);
        row.addEventListener('touchend', cancelPress);
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
