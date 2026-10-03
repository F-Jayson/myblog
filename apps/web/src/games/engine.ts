export type GameDirection = "up" | "down" | "left" | "right";

export type Point = { x: number; y: number };

export type SnakeState = {
	width: number;
	height: number;
	snake: Point[];
	direction: GameDirection;
	queued: GameDirection;
	food: Point;
	score: number;
	alive: boolean;
	won: boolean;
};

const opposite: Record<GameDirection, GameDirection> = { up: "down", down: "up", left: "right", right: "left" };

function samePoint(left: Point, right: Point) {
	return left.x === right.x && left.y === right.y;
}

function stepPoint(point: Point, direction: GameDirection): Point {
	if (direction === "up") return { x: point.x, y: point.y - 1 };
	if (direction === "down") return { x: point.x, y: point.y + 1 };
	if (direction === "left") return { x: point.x - 1, y: point.y };
	return { x: point.x + 1, y: point.y };
}

function randomEmpty(width: number, height: number, occupied: Point[], random: () => number) {
	const open: Point[] = [];
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (!occupied.some((point) => point.x === x && point.y === y)) open.push({ x, y });
		}
	}
	if (!open.length) return null;
	return open[Math.floor(random() * open.length)] ?? open[0];
}

export function createSnake(width = 16, height = 16, random: () => number = Math.random): SnakeState {
	const y = Math.floor(height / 2);
	const snake = [{ x: 4, y }, { x: 3, y }, { x: 2, y }];
	const food = randomEmpty(width, height, snake, random) ?? { x: width - 1, y };
	return { width, height, snake, direction: "right", queued: "right", food, score: 0, alive: true, won: false };
}

export function queueSnakeDirection(state: SnakeState, direction: GameDirection): SnakeState {
	if (!state.alive || opposite[state.queued] === direction) return state;
	return { ...state, queued: direction };
}

export function stepSnake(state: SnakeState, random: () => number = Math.random): SnakeState {
	if (!state.alive) return state;
	const direction = state.queued;
	const head = stepPoint(state.snake[0], direction);
	if (head.x < 0 || head.y < 0 || head.x >= state.width || head.y >= state.height) {
		return { ...state, direction, alive: false };
	}
	const eating = samePoint(head, state.food);
	const body = eating ? state.snake : state.snake.slice(0, -1);
	if (body.some((point) => samePoint(point, head))) return { ...state, direction, alive: false };
	const snake = [head, ...state.snake];
	if (!eating) snake.pop();
	if (!eating) return { ...state, snake, direction, queued: direction, alive: true };
	const score = state.score + 10;
	if (snake.length >= state.width * state.height) {
		return { ...state, snake, direction, queued: direction, score, alive: false, won: true };
	}
	const food = randomEmpty(state.width, state.height, snake, random) ?? state.food;
	return { ...state, snake, direction, queued: direction, food, score, alive: true };
}

export type Board = number[][];
export type Combine = (left: number, right: number) => number | null;

function emptyBoard(): Board {
	return Array.from({ length: 4 }, () => [0, 0, 0, 0]);
}

function transpose(board: Board): Board {
	return board[0].map((_, column) => board.map((row) => row[column] ?? 0));
}

function slideLine(line: number[], combine: Combine) {
	const tiles = line.filter((value) => value !== 0);
	const next: number[] = [];
	let gained = 0;
	for (let index = 0; index < tiles.length; index += 1) {
		const current = tiles[index] ?? 0;
		const following = tiles[index + 1];
		const merged = following === undefined ? null : combine(current, following);
		if (merged) {
			next.push(merged);
			gained += merged;
			index += 1;
		} else {
			next.push(current);
		}
	}
	while (next.length < line.length) next.push(0);
	return { line: next, gained, moved: next.some((value, index) => value !== line[index]) };
}

function slideLeft(board: Board, combine: Combine) {
	let gained = 0;
	let moved = false;
	const next = board.map((row) => {
		const slid = slideLine(row, combine);
		gained += slid.gained;
		moved = moved || slid.moved;
		return slid.line;
	});
	return { board: next, gained, moved };
}

export function slideBoard(board: Board, direction: GameDirection, combine: Combine) {
	if (direction === "left") return slideLeft(board, combine);
	if (direction === "right") {
		const slid = slideLeft(board.map((row) => [...row].reverse()), combine);
		return { board: slid.board.map((row) => [...row].reverse()), gained: slid.gained, moved: slid.moved };
	}
	if (direction === "up") {
		const slid = slideLeft(transpose(board), combine);
		return { board: transpose(slid.board), gained: slid.gained, moved: slid.moved };
	}
	const turned = transpose(board).map((row) => [...row].reverse());
	const slid = slideLeft(turned, combine);
	return { board: transpose(slid.board.map((row) => [...row].reverse())), gained: slid.gained, moved: slid.moved };
}

function emptyCells(board: Board) {
	const cells: Point[] = [];
	board.forEach((row, y) => row.forEach((value, x) => { if (value === 0) cells.push({ x, y }); }));
	return cells;
}

export function spawnTile(board: Board, value: number, random: () => number = Math.random) {
	const cells = emptyCells(board);
	if (!cells.length || value <= 0) return board;
	const spot = cells[Math.floor(random() * cells.length)] ?? cells[0];
	return board.map((row, y) => row.map((cell, x) => (x === spot.x && y === spot.y ? value : cell)));
}

export function hasMoves(board: Board, combine: Combine) {
	if (board.some((row) => row.some((cell) => cell === 0))) return true;
	for (let y = 0; y < board.length; y += 1) {
		for (let x = 0; x < board[y].length; x += 1) {
			const value = board[y][x] ?? 0;
			if (x + 1 < board[y].length && combine(value, board[y][x + 1] ?? 0)) return true;
			if (y + 1 < board.length && combine(value, board[y + 1]?.[x] ?? 0)) return true;
		}
	}
	return false;
}

export function createBoard(spawnValue: (random: () => number) => number, random: () => number = Math.random) {
	let board = emptyBoard();
	board = spawnTile(board, spawnValue(random), random);
	board = spawnTile(board, spawnValue(random), random);
	return board;
}

export function moveBoard(board: Board, direction: GameDirection, combine: Combine, spawnValue: (random: () => number) => number, random: () => number = Math.random) {
	const slid = slideBoard(board, direction, combine);
	if (!slid.moved) return { board, scoreGained: 0, moved: false };
	return { board: spawnTile(slid.board, spawnValue(random), random), scoreGained: slid.gained, moved: true };
}

export function classicSpawn(random: () => number) {
	return random() < 0.9 ? 2 : 4;
}

export function classicCombine(left: number, right: number) {
	return left > 0 && left === right ? left + right : null;
}

const fibonacciValues = [1, 2, 3, 5, 8, 13];

function fibonacciIndex(value: number) {
	if (!Number.isInteger(value) || value < 1) return -1;
	while ((fibonacciValues[fibonacciValues.length - 1] ?? 0) < value && fibonacciValues.length < 80) {
		const last = fibonacciValues[fibonacciValues.length - 1] ?? 0;
		const previous = fibonacciValues[fibonacciValues.length - 2] ?? 0;
		const next = last + previous;
		if (!Number.isSafeInteger(next)) break;
		fibonacciValues.push(next);
	}
	return fibonacciValues.indexOf(value);
}

export function fibonacciSpawn(random: () => number) {
	return random() < 0.9 ? 1 : 2;
}

// Two 1s become 2. Other tiles merge only with a neighboring Fibonacci number,
// so 2 does not merge with 2, while 1+2=3 and 2+3=5.
export function fibonacciCombine(left: number, right: number) {
	if (left === 1 && right === 1) return 2;
	const leftIndex = fibonacciIndex(left);
	const rightIndex = fibonacciIndex(right);
	if (leftIndex >= 0 && rightIndex >= 0 && Math.abs(leftIndex - rightIndex) === 1) return left + right;
	return null;
}

export type MineDifficulty = "beginner" | "intermediate" | "expert";

export const MINE_PRESETS: Record<MineDifficulty, { rows: number; cols: number; mines: number; label: string }> = {
	beginner: { rows: 9, cols: 9, mines: 10, label: "初级" },
	intermediate: { rows: 16, cols: 16, mines: 40, label: "中级" },
	expert: { rows: 16, cols: 30, mines: 99, label: "高级" },
};

export type MineCell = { mine: boolean; open: boolean; flag: boolean; near: number };

export type MineState = {
	rows: number;
	cols: number;
	mines: number;
	cells: MineCell[];
	alive: boolean;
	won: boolean;
	started: boolean;
};

function mineNeighbors(index: number, cols: number, rows: number) {
	const x = index % cols;
	const y = Math.floor(index / cols);
	const found: number[] = [];
	for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
		for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
			if (!offsetX && !offsetY) continue;
			const nextX = x + offsetX;
			const nextY = y + offsetY;
			if (nextX < 0 || nextY < 0 || nextX >= cols || nextY >= rows) continue;
			found.push(nextY * cols + nextX);
		}
	}
	return found;
}

function placeMines(state: MineState, safeIndex: number, random: () => number) {
	const total = state.rows * state.cols;
	let banned = new Set([safeIndex, ...mineNeighbors(safeIndex, state.cols, state.rows)]);
	if (total - banned.size < state.mines) banned = new Set([safeIndex]);
	const candidates = Array.from({ length: total }, (_, index) => index).filter((index) => !banned.has(index));
	const cells = state.cells.map((cell) => ({ ...cell }));
	for (let index = 0; index < state.mines && index < candidates.length; index += 1) {
		const swap = index + Math.floor(random() * (candidates.length - index));
		const chosen = candidates[swap] ?? candidates[index];
		candidates[swap] = candidates[index] ?? chosen;
		candidates[index] = chosen;
		const cell = cells[chosen];
		if (cell) cell.mine = true;
	}
	cells.forEach((cell, index) => {
		if (cell.mine) return;
		cell.near = mineNeighbors(index, state.cols, state.rows).reduce((totalMines, neighbor) => totalMines + (cells[neighbor]?.mine ? 1 : 0), 0);
	});
	return cells;
}

function floodOpen(cells: MineCell[], index: number, cols: number, rows: number) {
	const stack = [index];
	while (stack.length) {
		const current = stack.pop();
		if (current === undefined) continue;
		const cell = cells[current];
		if (!cell || cell.open || cell.flag || cell.mine) continue;
		cell.open = true;
		if (cell.near !== 0) continue;
		stack.push(...mineNeighbors(current, cols, rows));
	}
}

export function createMines(difficulty: MineDifficulty): MineState {
	const preset = MINE_PRESETS[difficulty];
	return {
		rows: preset.rows,
		cols: preset.cols,
		mines: preset.mines,
		cells: Array.from({ length: preset.rows * preset.cols }, () => ({ mine: false, open: false, flag: false, near: 0 })),
		alive: true,
		won: false,
		started: false,
	};
}

function settled(state: MineState, cells: MineCell[]): MineState {
	const won = state.alive && cells.every((cell) => cell.mine || cell.open);
	const revealed = won ? cells.map((cell) => ({ ...cell, open: cell.mine ? cell.open : true })) : cells;
	return { ...state, cells: revealed, won, started: true };
}

export function openMine(state: MineState, index: number, random: () => number = Math.random): MineState {
	if (!state.alive || state.won || index < 0 || index >= state.cells.length) return state;
	const target = state.cells[index];
	if (!target || target.open || target.flag) return state;
	const cells = state.started ? state.cells.map((cell) => ({ ...cell })) : placeMines(state, index, random);
	const cell = cells[index];
	if (!cell) return state;
	if (cell.mine) {
		return { ...state, started: true, alive: false, cells: cells.map((item) => ({ ...item, open: item.mine ? true : item.open })) };
	}
	floodOpen(cells, index, state.cols, state.rows);
	return settled({ ...state, alive: true }, cells);
}

export function toggleMineFlag(state: MineState, index: number): MineState {
	if (!state.alive || state.won || index < 0 || index >= state.cells.length) return state;
	const cells = state.cells.map((cell, cellIndex) => cellIndex === index && !cell.open ? { ...cell, flag: !cell.flag } : cell);
	return { ...state, cells };
}

export function mineFlagCount(state: MineState) {
	return state.cells.reduce((total, cell) => total + (cell.flag ? 1 : 0), 0);
}
