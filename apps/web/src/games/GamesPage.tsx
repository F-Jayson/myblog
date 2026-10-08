import { ArrowLeft, Bomb, CircleHelp, Flag, Gamepad2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ensureGameGuestToken } from "../api";
import { useAuth } from "../auth";
import { resolveMediaUrl } from "../media";
import type { GameLeaderboard, GamePlayer } from "../types";
import {
	classicCombine,
	classicSpawn,
	createMineField,
	createSnake,
	createTiles,
	customMineSetup,
	cycleMineMark,
	fibonacciCombine,
	fibonacciSpawn,
	mineFlagCount,
	MINE_PRESETS,
	moveTiles,
	openMine,
	queueSnakeDirection,
	SNAKE_PRESETS,
	stepSnake,
	tilesHaveMoves,
	type Combine,
	type GameDirection,
	type MineDifficulty,
	type MineSetup,
	type MineState,
	type NumberTile,
	type SnakeDifficulty,
	type SnakeState,
} from "./engine";
import { useGameSidebar } from "./sidebarSlot";
import "./games.css";

const GAMES = [
	{ id: "snake", title: "贪吃蛇", summary: "吃到食物得 10 分，撞墙或咬到自己就结束。", rules: "方向键、WASD、滑动或下方按键改变方向。不能直接掉头。简单棋盘更小、移动更慢，困难则相反。" },
	{ id: "minesweeper", title: "扫雷", summary: "翻开所有安全格。用时越短，排名越靠前。", rules: "第一次点击必定安全。右键或插旗模式会在旗子、问号和空白之间切换。初级、中级、高级之外可以自定义行列和雷数，自定义成绩不计入排行榜。" },
	{ id: "2048", title: "2048", summary: "相同数字合并成它们的和，尽量拿到更高分。", rules: "相同数字撞在一起会合成它们的和。每次滑动后会出现一个新的 2 或 4，同一次滑动里不会连锁合并。" },
	{ id: "fibonacci", title: "斐波那契 2048", summary: "相邻斐波那契数可以合并，两个 1 合并为 2。", rules: "例如 1+2=3，2+3=5。2 不能和 2 合并。新出现的数字是 1 或 2。" },
] as const;

type GameId = (typeof GAMES)[number]["id"];
type ReportScore = (score: number, durationMs: number) => void;

function isGameId(value: string | undefined): value is GameId {
	return GAMES.some((game) => game.id === value);
}

function directionFromKey(key: string): GameDirection | null {
	const directions: Record<string, GameDirection> = {
		ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
		w: "up", a: "left", s: "down", d: "right",
		W: "up", A: "left", S: "down", D: "right",
	};
	return directions[key] ?? null;
}

function formatClock(ms: number) {
	const safe = Math.max(0, Math.round(ms));
	const minutes = Math.floor(safe / 60_000);
	const seconds = Math.floor(safe / 1000) % 60;
	const tenths = Math.floor(safe / 100) % 10;
	return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function formatPoints(score: number) {
	return `${new Intl.NumberFormat("zh-CN").format(score)} 分`;
}

function formatRanked(lowerIsBetter: boolean, score: number) {
	return lowerIsBetter ? formatClock(score) : formatPoints(score);
}

const CLASSIC_TILES: Record<number, { background: string; color: string }> = {
	1: { background: "#eee4da", color: "#776e65" },
	2: { background: "#eee4da", color: "#776e65" },
	4: { background: "#ede0c8", color: "#776e65" },
	8: { background: "#f2b179", color: "#f9f6f2" },
	16: { background: "#f59563", color: "#f9f6f2" },
	32: { background: "#f67c5f", color: "#f9f6f2" },
	64: { background: "#f65e3b", color: "#f9f6f2" },
	128: { background: "#edcf72", color: "#f9f6f2" },
	256: { background: "#edcc61", color: "#f9f6f2" },
	512: { background: "#edc850", color: "#f9f6f2" },
	1024: { background: "#edc53f", color: "#f9f6f2" },
	2048: { background: "#edc22e", color: "#f9f6f2" },
};

const CLASSIC_RAMP = [CLASSIC_TILES[2], CLASSIC_TILES[4], CLASSIC_TILES[8], CLASSIC_TILES[16], CLASSIC_TILES[32], CLASSIC_TILES[64], CLASSIC_TILES[128], CLASSIC_TILES[256], CLASSIC_TILES[512], CLASSIC_TILES[1024], CLASSIC_TILES[2048], { background: "#3c3a32", color: "#f9f6f2" }];

function tileStyle(value: number): CSSProperties {
	const text = String(value);
	const known = CLASSIC_TILES[value];
	const level = Math.min(CLASSIC_RAMP.length - 1, Math.max(0, Math.round(Math.log2(Math.max(2, value))) - 1));
	const palette = known ?? CLASSIC_RAMP[level] ?? CLASSIC_TILES[2];
	const fontSize = text.length >= 8 ? ".68rem" : text.length >= 6 ? ".82rem" : text.length >= 4 ? "1.05rem" : text.length >= 3 ? "1.35rem" : "1.7rem";
	return { background: palette.background, color: palette.color, fontSize };
}

function PlayerFace({ name, avatar }: { name: string; avatar: string }) {
	const src = resolveMediaUrl(avatar);
	if (!src) return <span className="game-avatar" aria-hidden="true">{name.slice(0, 1) || "游"}</span>;
	return <img src={src} alt="" width={40} height={40} />;
}

function GameMessage({ text, error }: { text: string; error: boolean }) {
	if (!text) return null;
	return <p className={`game-message${error ? " is-error" : ""}`}>{text}</p>;
}

function ControlPad({ onDirection }: { onDirection: (direction: GameDirection) => void }) {
	return <div className="game-pad" aria-label="方向控制">
		<div><button type="button" aria-label="向上" onClick={() => onDirection("up")}>↑</button></div>
		<div>
			<button type="button" aria-label="向左" onClick={() => onDirection("left")}>←</button>
			<button type="button" aria-label="向下" onClick={() => onDirection("down")}>↓</button>
			<button type="button" aria-label="向右" onClick={() => onDirection("right")}>→</button>
		</div>
	</div>;
}

function usePageHidden() {
	const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
	useEffect(() => {
		const update = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	return hidden;
}

function useDirectionKeys(onDirection: (direction: GameDirection) => void) {
	const ref = useRef(onDirection);
	ref.current = onDirection;
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const target = event.target;
			if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			const direction = directionFromKey(event.key);
			if (!direction) return;
			event.preventDefault();
			ref.current(direction);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}

function useSwipe(onDirection: (direction: GameDirection) => void) {
	const start = useRef<{ x: number; y: number } | null>(null);
	const ref = useRef(onDirection);
	ref.current = onDirection;
	return {
		onPointerDown(event: ReactPointerEvent<HTMLElement>) {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			start.current = { x: event.clientX, y: event.clientY };
		},
		onPointerUp(event: ReactPointerEvent<HTMLElement>) {
			if (!start.current) return;
			const dx = event.clientX - start.current.x;
			const dy = event.clientY - start.current.y;
			start.current = null;
			if (Math.hypot(dx, dy) < 28) return;
			ref.current(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"));
		},
		onPointerCancel() { start.current = null; },
	};
}

function useLeaveScore(read: () => { score: number; durationMs: number } | null, onReport: ReportScore) {
	const readRef = useRef(read);
	const reportRef = useRef(onReport);
	readRef.current = read;
	reportRef.current = onReport;
	const sent = useRef(false);
	const publish = useCallback(() => {
		if (sent.current) return;
		const current = readRef.current();
		if (!current) return;
		sent.current = true;
		reportRef.current(current.score, current.durationMs);
	}, []);
	useEffect(() => {
		const onHide = () => publish();
		const onShow = () => { sent.current = false; };
		window.addEventListener("pagehide", onHide);
		window.addEventListener("pageshow", onShow);
		return () => {
			window.removeEventListener("pagehide", onHide);
			window.removeEventListener("pageshow", onShow);
			publish();
		};
	}, [publish]);
	return publish;
}

function SnakeGame({ onReport, onRestart, message, messageError, best, width, height, intervalMs }: GamePanelProps & { width: number; height: number; intervalMs: number }) {
	const [state, setState] = useState<SnakeState>(() => createSnake(width, height));
	const [paused, setPaused] = useState(false);
	const [clock, setClock] = useState(0);
	const hidden = usePageHidden();
	const started = useRef(performance.now());
	const held = useRef(0);
	const holdFrom = useRef<number | null>(null);
	const stateRef = useRef(state);
	stateRef.current = state;
	const frozen = paused || hidden || !state.alive;

	const elapsed = useCallback(() => {
		const extra = holdFrom.current == null ? 0 : performance.now() - holdFrom.current;
		return Math.max(1, Math.round(performance.now() - started.current - held.current - extra));
	}, []);

	useEffect(() => {
		if (frozen) {
			if (holdFrom.current == null) holdFrom.current = performance.now();
			return;
		}
		if (holdFrom.current != null) {
			held.current += performance.now() - holdFrom.current;
			holdFrom.current = null;
		}
	}, [frozen]);

	useEffect(() => {
		if (frozen) return;
		const id = window.setInterval(() => setState((current) => stepSnake(current)), intervalMs);
		const clockId = window.setInterval(() => setClock((value) => value + 1), 200);
		return () => {
			window.clearInterval(id);
			window.clearInterval(clockId);
		};
	}, [frozen, intervalMs]);

	const publish = useLeaveScore(() => {
		const current = stateRef.current;
		if (current.score <= 0) return null;
		return { score: current.score, durationMs: elapsed() };
	}, onReport);

	useEffect(() => {
		if (!state.alive) publish();
	}, [state.alive, publish]);

	const turn = useCallback((direction: GameDirection) => {
		setState((current) => queueSnakeDirection(current, direction));
	}, []);
	useDirectionKeys(turn);
	const swipe = useSwipe(turn);
	const head = state.snake[0];
	const body = new Set(state.snake.slice(1).map((point) => `${point.x},${point.y}`));
	void clock;

	return <div className="game-stage">
		<div className="game-status">
			<span>得分 <b>{state.score}</b></span>
			<span>用时 <b>{formatClock(elapsed())}</b></span>
			{best ? <span>最好 <b>{best}</b></span> : null}
			<button className="game-button" type="button" onClick={() => setPaused((value) => !value)}>{paused || hidden ? "继续" : "暂停"}</button>
			<button className="game-button" type="button" onClick={onRestart}><RotateCcw size={15} />再来一局</button>
		</div>
		<div
			className="snake-board"
			role="application"
			aria-label="贪吃蛇棋盘"
			style={{ gridTemplateColumns: `repeat(${state.width}, minmax(0, 1fr))` }}
			{...swipe}
		>
			{Array.from({ length: state.width * state.height }, (_, index) => {
				const x = index % state.width;
				const y = Math.floor(index / state.width);
				const key = `${x},${y}`;
				const className = head && head.x === x && head.y === y ? "snake-cell is-head" : body.has(key) ? "snake-cell is-snake" : state.food.x === x && state.food.y === y ? "snake-cell is-food" : "snake-cell";
				return <span key={key} className={className} />;
			})}
		</div>
		{!state.alive ? <div className="game-overlay"><strong>{state.won ? "棋盘已经填满" : "游戏结束"}</strong><button className="game-button primary" type="button" onClick={onRestart}>再来一局</button></div> : null}
		{paused || hidden ? <p className="game-note">游戏已暂停</p> : null}
		<ControlPad onDirection={turn} />
		<GameMessage text={message} error={messageError} />
	</div>;
}

function NumberGame({ combine, spawn, onReport, onRestart, message, messageError, best }: GamePanelProps & { combine: Combine; spawn: (random: () => number) => number }) {
	const [tiles, setTiles] = useState<NumberTile[]>(() => createTiles(spawn));
	const [score, setScore] = useState(0);
	const [over, setOver] = useState(false);
	const [clock, setClock] = useState(0);
	const started = useRef(performance.now());
	const tilesRef = useRef(tiles);
	const scoreRef = useRef(score);
	const overRef = useRef(over);
	tilesRef.current = tiles;
	scoreRef.current = score;
	overRef.current = over;
	const elapsed = useCallback(() => Math.max(1, Math.round(performance.now() - started.current)), []);

	useEffect(() => {
		if (over) return;
		const id = window.setInterval(() => setClock((value) => value + 1), 200);
		return () => window.clearInterval(id);
	}, [over]);

	useEffect(() => {
		if (!tiles.some((tile) => tile.ghost)) return;
		const id = window.setTimeout(() => setTiles((current) => current.filter((tile) => !tile.ghost)), 180);
		return () => window.clearTimeout(id);
	}, [tiles]);

	const publish = useLeaveScore(() => {
		if (scoreRef.current <= 0) return null;
		return { score: scoreRef.current, durationMs: elapsed() };
	}, onReport);

	useEffect(() => {
		if (over) publish();
	}, [over, publish]);

	const move = useCallback((direction: GameDirection) => {
		if (overRef.current) return;
		const moved = moveTiles(tilesRef.current, direction, combine, spawn);
		if (!moved.moved) return;
		tilesRef.current = moved.tiles;
		setTiles(moved.tiles);
		setScore((current) => {
			const next = current + moved.scoreGained;
			scoreRef.current = next;
			return next;
		});
		const ended = !tilesHaveMoves(moved.tiles, combine);
		overRef.current = ended;
		if (ended) setOver(true);
	}, [combine, spawn]);
	useDirectionKeys(move);
	const swipe = useSwipe(move);
	void clock;

	return <div className="game-stage">
		<div className="game-status">
			<span>得分 <b>{formatPoints(score)}</b></span>
			<span>用时 <b>{formatClock(elapsed())}</b></span>
			{best ? <span>最好 <b>{best}</b></span> : null}
			<button className="game-button" type="button" onClick={onRestart}><RotateCcw size={15} />再来一局</button>
		</div>
		<div className="number-board" role="application" aria-label="数字棋盘" {...swipe}>
			<div className="number-grid" aria-hidden="true">{Array.from({ length: 16 }, (_, index) => <span className="number-slot" key={index} />)}</div>
			{tiles.map((tile) => <div key={tile.id} className={`number-tile${tile.ghost ? " is-ghost" : ""}${tile.pop ? " is-pop" : ""}`} style={{ transform: `translate(calc(${tile.col} * (100% + var(--tile-gap))), calc(${tile.row} * (100% + var(--tile-gap))))` }}>
				<div key={`${tile.value}-${tile.pop ? "pop" : "still"}`} className={`number-face${tile.pop ? " is-pop" : ""}${tile.fresh ? " is-fresh" : ""}`} style={tileStyle(tile.value)}>{tile.value}</div>
			</div>)}
		</div>
		{over ? <div className="game-overlay"><strong>无法继续移动</strong><span>本局 {formatPoints(score)}</span><button className="game-button primary" type="button" onClick={onRestart}>再来一局</button></div> : null}
		<ControlPad onDirection={move} />
		<GameMessage text={message} error={messageError} />
	</div>;
}

function MineGame({ setup, ranked, onReport, onRestart, message, messageError, best }: GamePanelProps & { setup: MineSetup; ranked: boolean }) {
	const [state, setState] = useState<MineState>(() => createMineField(setup));
	const [flagMode, setFlagMode] = useState(false);
	const [clock, setClock] = useState(0);
	const startAt = useRef<number | null>(null);
	const endAt = useRef<number | null>(null);
	const stateRef = useRef(state);
	stateRef.current = state;
	const elapsed = useCallback(() => {
		if (startAt.current == null) return 0;
		const end = endAt.current ?? performance.now();
		return Math.max(0, Math.round(end - startAt.current));
	}, []);

	useEffect(() => {
		if (!state.started || state.won || !state.alive) {
			if (state.started && endAt.current == null && (!state.alive || state.won)) endAt.current = performance.now();
			return;
		}
		const id = window.setInterval(() => setClock((value) => value + 1), 100);
		return () => window.clearInterval(id);
	}, [state.started, state.alive, state.won]);

	const publish = useLeaveScore(() => {
		const current = stateRef.current;
		if (!ranked || !current.won) return null;
		const durationMs = elapsed();
		if (durationMs <= 0) return null;
		return { score: 0, durationMs };
	}, onReport);

	useEffect(() => {
		if (state.won) publish();
	}, [state.won, publish]);

	function reveal(index: number, flag: boolean) {
		const cell = state.cells[index];
		if (!state.started && !flag && cell && !cell.open && !cell.flag && startAt.current == null) startAt.current = performance.now();
		setState((current) => flag ? cycleMineMark(current, index) : openMine(current, index));
	}

	const flags = mineFlagCount(state);
	void clock;
	const ended = !state.alive || state.won;

	return <div className="game-stage">
		<div className="game-status">
			<span>剩余 <b>{state.mines - flags}</b></span>
			<span>用时 <b>{formatClock(elapsed())}</b></span>
			{best ? <span>最好 <b>{best}</b></span> : null}
			<button className={`game-button${flagMode ? " is-selected" : ""}`} type="button" aria-pressed={flagMode} onClick={() => setFlagMode((value) => !value)}><Flag size={14} />插旗 / 问号</button>
			<button className="game-button" type="button" onClick={onRestart}><RotateCcw size={15} />再来一局</button>
		</div>
		<div className="mine-scroll">
			<div className="mine-board" role="grid" aria-label={`${setup.label}扫雷`} style={{ gridTemplateColumns: `repeat(${state.cols}, var(--mine-cell))` }}>
				{state.cells.map((cell, index) => {
					const shade = (index % state.cols + Math.floor(index / state.cols)) % 2 === 0 ? "is-a" : "is-b";
					const className = ["mine-cell", shade, cell.open ? "is-open" : "", cell.mine && cell.open ? "is-mine" : "", cell.flag ? "is-flag" : "", cell.question && !cell.open ? "is-question" : "", cell.open && cell.near ? `n${cell.near}` : ""].filter(Boolean).join(" ");
					const mark = cell.flag ? <Flag size={14} aria-label="旗子" /> : cell.question && !cell.open ? <CircleHelp size={14} aria-label="问号" /> : cell.open && cell.mine ? <Bomb size={14} aria-label="地雷" /> : cell.open && cell.near ? String(cell.near) : "";
					return <button key={index} type="button" className={className} disabled={ended && !cell.open && !cell.flag && !cell.question} onClick={() => reveal(index, flagMode)} onContextMenu={(event) => { event.preventDefault(); if (!ended) reveal(index, true); }}>{mark}</button>;
				})}
			</div>
		</div>
		{ended ? <div className="game-overlay"><strong>{state.won ? "排雷成功" : "踩到地雷了"}</strong>{state.won && ranked ? null : <span>{ranked ? "这次不记入排行榜" : "自定义难度不计入排行榜"}</span>}<button className="game-button primary" type="button" onClick={onRestart}>再来一局</button></div> : null}
		{ranked ? null : <p className="game-note">当前是自定义棋盘，成绩只留在这一局。</p>}
		<GameMessage text={message} error={messageError} />
	</div>;
}

type GamePanelProps = {
	onReport: ReportScore;
	onRestart: () => void;
	message: string;
	messageError: boolean;
	best: string;
};

function Identity({ player, pending, onLogin }: { player: GamePlayer | null; pending: boolean; onLogin: () => void }) {
	if (!player) return pending ? <p className="game-note">正在准备排行榜身份...</p> : null;
	return <div className="game-identity">
		<PlayerFace name={player.name} avatar={player.avatar} />
		<div>
			<strong>{player.name}</strong>
			<p>{player.isGuest ? "游客成绩记在这个名字下。登录后排行榜显示你的昵称和头像。" : "排行榜显示你的昵称和头像。"}</p>
		</div>
		{player.isGuest ? <button className="game-button" type="button" onClick={onLogin}>登录</button> : null}
	</div>;
}

function LeaderList({ board }: { board: GameLeaderboard }) {
	const mine = board.me;
	const visible = new Set(board.entries.map((entry) => entry.playerKey));
	const rows = mine && !visible.has(mine.playerKey) ? [...board.entries, mine] : board.entries;
	if (!rows.length) return <p className="game-note">还没有人上榜，来做第一个。</p>;
	return <ol>
		{rows.map((entry) => <li key={entry.playerKey} className={entry.playerKey === mine?.playerKey ? "is-me" : ""}>
			<span>{entry.rank}</span>
			<PlayerFace name={entry.name} avatar={entry.avatar} />
			<span className="game-name">{entry.name}</span>
			<b>{formatRanked(board.lowerIsBetter, entry.score)}</b>
		</li>)}
	</ol>;
}

function LeaderboardBody({ loading, error, board, note }: { loading: boolean; error: string; board: GameLeaderboard | null; note: string }) {
	return <>
		{note ? <p className="game-note">{note}</p> : null}
		{loading && !board ? <p className="game-note">正在加载排行榜...</p> : null}
		{error ? <p className="game-message is-error">{error}</p> : null}
		{board ? <LeaderList board={board} /> : null}
	</>;
}

export function GameSidebarRank() {
	const slot = useGameSidebar();
	const data = slot?.data;
	return <section className="card widget game-rank game-sidebar-rank">
		<h3>{data?.title || "排行榜"}</h3>
		{data ? <LeaderboardBody loading={data.loading} error={data.error} board={data.board} note={data.note} /> : <p className="game-note">选择一款游戏后，排行榜会显示在这里。</p>}
	</section>;
}

export default function GamesPage() {
	const params = useParams();
	const gameId = isGameId(params.gameId) ? params.gameId : undefined;
	const unknownGame = Boolean(params.gameId) && !gameId;
	const { user, loading: authLoading, features, openAuth } = useAuth();
	const sidebar = useGameSidebar();
	const setSidebar = sidebar?.setData;
	const [player, setPlayer] = useState<GamePlayer | null>(null);
	const [board, setBoard] = useState<GameLeaderboard | null>(null);
	const [mineLevel, setMineLevel] = useState<MineDifficulty | "custom">("beginner");
	const [mineSetup, setMineSetup] = useState<MineSetup>(MINE_PRESETS.beginner);
	const [customRows, setCustomRows] = useState(12);
	const [customCols, setCustomCols] = useState(12);
	const [customMines, setCustomMines] = useState(20);
	const [customOpen, setCustomOpen] = useState(false);
	const [customError, setCustomError] = useState("");
	const [snakeLevel, setSnakeLevel] = useState<SnakeDifficulty>("normal");
	const [round, setRound] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [noticeError, setNoticeError] = useState(false);
	const meta = GAMES.find((game) => game.id === gameId);
	const rankedMine = mineLevel !== "custom";
	const rankKey = gameId === "minesweeper" ? (rankedMine ? mineLevel : "custom") : gameId === "snake" ? snakeLevel : "";
	const viewRef = useRef({ gameId, rankKey });
	viewRef.current = { gameId, rankKey };

	useEffect(() => {
		if (authLoading || !features.gamesEnabled) return;
		if (!user) ensureGameGuestToken();
		const controller = new AbortController();
		setLoading(true);
		setError("");
		const skipBoard = gameId === "minesweeper" && !rankedMine;
		const task = !gameId || unknownGame
			? api.gamesHome().then((result) => { if (!controller.signal.aborted) setPlayer(result.player); })
			: skipBoard
				? Promise.resolve().then(() => { if (!controller.signal.aborted) setBoard(null); })
				: api.gameLeaderboard(gameId, gameId === "minesweeper" ? mineLevel : gameId === "snake" ? snakeLevel : undefined).then((result) => {
					if (controller.signal.aborted) return;
					setBoard(result);
					setPlayer(result.player);
				});
		task.catch((reason: unknown) => {
			if (controller.signal.aborted) return;
			const message = reason instanceof Error ? reason.message : "排行榜加载失败";
			setError(/500|failed to fetch|network|econnrefused/iu.test(message) ? "排行榜暂时没有连上" : message);
		}).finally(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => controller.abort();
	}, [authLoading, user, features.gamesEnabled, gameId, unknownGame, mineLevel, snakeLevel, rankedMine]);

	const report = useCallback((score: number, durationMs: number) => {
		if (!gameId || (gameId === "minesweeper" && !rankedMine)) return;
		const ranked = gameId === "minesweeper" ? durationMs : score;
		if (ranked <= 0) return;
		setNotice("正在记录成绩...");
		setNoticeError(false);
		const submittedGame = gameId;
		const submittedKey = rankKey;
		void api.recordGameScore(gameId, {
			score: gameId === "minesweeper" ? 0 : Math.round(score),
			durationMs: Math.max(0, Math.round(durationMs)),
			difficulty: gameId === "minesweeper" && mineLevel !== "custom" ? mineLevel : gameId === "snake" ? snakeLevel : undefined,
		}).then((result) => {
			const view = viewRef.current;
			const sameGame = view.gameId === submittedGame;
			const sameDifficulty = view.rankKey === submittedKey;
			if (!sameGame || !sameDifficulty) return;
			setBoard(result.leaderboard);
			setPlayer(result.leaderboard.player);
			const rank = result.leaderboard.me?.rank;
			setNotice(result.improved ? `已记入排行榜，当前第 ${rank ?? "—"} 名` : "没有超过最好成绩");
			setNoticeError(false);
		}).catch((reason: unknown) => {
			const message = reason instanceof Error ? reason.message : "成绩记录失败";
			setNotice(/internal server error|failed to fetch|network|econnrefused|^500\b/iu.test(message) ? "网络错误，成绩没有上传成功" : message);
			setNoticeError(true);
		});
	}, [gameId, rankedMine, rankKey, mineLevel, snakeLevel]);

	const restart = useCallback(() => {
		setNotice("");
		setNoticeError(false);
		setRound((value) => value + 1);
	}, []);

	useEffect(() => {
		if (!setSidebar) return;
		if (!features.gamesEnabled || unknownGame) {
			setSidebar(null);
			return;
		}
		if (!gameId || !meta) {
			setSidebar({ title: "排行榜", loading: false, error: "", board: null, note: "选择一款游戏后，排行榜会显示在这里。" });
			return;
		}
		const levelLabel = gameId === "snake" ? SNAKE_PRESETS[snakeLevel].label : gameId === "minesweeper" ? mineSetup.label : "";
		const unranked = gameId === "minesweeper" && !rankedMine;
		setSidebar({
			title: levelLabel ? `${meta.title} · ${levelLabel}` : `${meta.title}排行榜`,
			loading: unranked ? false : loading,
			error: unranked ? "" : error,
			board: unranked ? null : board,
			note: unranked ? "自定义难度不计入排行榜。" : "",
		});
	}, [setSidebar, features.gamesEnabled, unknownGame, gameId, meta, snakeLevel, mineSetup, rankedMine, loading, error, board]);

	useEffect(() => () => setSidebar?.(null), [setSidebar]);

	const applyCustomMine = (event: FormEvent) => {
		event.preventDefault();
		const result = customMineSetup(customRows, customCols, customMines);
		if ("error" in result) {
			setCustomError(result.error);
			return;
		}
		setCustomError("");
		setMineLevel("custom");
		setMineSetup(result.setup);
		setNotice("");
		setNoticeError(false);
		setRound((value) => value + 1);
	};

	if (!features.gamesEnabled) {
		return <section className="card content-card user-tool-page auth-required"><Gamepad2 size={30} /><h2>小游戏暂未开放</h2><p>管理员暂时关闭了这项功能，请稍后再试。</p></section>;
	}

	if (unknownGame) {
		return <section className="card content-card user-tool-page"><h2>没有这个小游戏</h2><p>可以从列表里重新选一款。</p><Link className="game-link-button" to="/tools/games">返回小游戏</Link></section>;
	}

	if (!gameId || !meta) {
		return <section className="card content-card user-tool-page game-shell">
			<div className="game-hub">
				<header className="game-heading">
					<div>
						<span className="game-kicker">MINI GAMES</span>
						<h2><Gamepad2 size={22} /> 小游戏</h2>
						<p>贪吃蛇、扫雷、2048 和斐波那契 2048。游客也能上榜，登录后显示昵称和头像。</p>
					</div>
				</header>
				<Identity player={player} pending={loading && !error} onLogin={() => openAuth("login")} />
				{error ? <p className="game-message is-error">{error}</p> : null}
				<div className="game-grid">
					{GAMES.map((game) => <Link key={game.id} className="game-card" to={`/tools/games/${game.id}`}>
						<strong>{game.title}</strong>
						<p>{game.summary}</p>
						<span>开始游戏</span>
					</Link>)}
				</div>
			</div>
		</section>;
	}

	const best = board?.me ? formatRanked(board.lowerIsBetter, board.me.score) : "";
	const panel = {
		onReport: report,
		onRestart: restart,
		message: notice,
		messageError: noticeError,
		best,
	};
	const snakePreset = SNAKE_PRESETS[snakeLevel];
	const rankNote = gameId === "minesweeper" && !rankedMine ? "自定义难度不计入排行榜。" : "";

	return <section className="card content-card user-tool-page game-shell">
		<header className="game-heading">
			<div>
				<span className="game-kicker">MINI GAMES</span>
				<h2>{meta.title}</h2>
				<p>{meta.rules}</p>
			</div>
			<Link className="game-link-button" to="/tools/games"><ArrowLeft size={16} />全部小游戏</Link>
		</header>
		<Identity player={player} pending={loading && !error} onLogin={() => openAuth("login")} />
		{gameId === "snake" ? <div className="game-toolbar" role="group" aria-label="贪吃蛇难度">
			{(Object.keys(SNAKE_PRESETS) as SnakeDifficulty[]).map((level) => <button key={level} className={`game-button${snakeLevel === level ? " is-selected" : ""}`} type="button" onClick={() => { setSnakeLevel(level); setNotice(""); setNoticeError(false); setRound((value) => value + 1); }}>{SNAKE_PRESETS[level].label}</button>)}
		</div> : null}
		{gameId === "minesweeper" ? <div className="game-toolbar" role="group" aria-label="扫雷难度">
			{(["beginner", "intermediate", "expert"] as const).map((level) => <button key={level} className={`game-button${mineLevel === level ? " is-selected" : ""}`} type="button" onClick={() => { setCustomOpen(false); setMineLevel(level); setMineSetup(MINE_PRESETS[level]); setCustomError(""); setNotice(""); setNoticeError(false); setRound((value) => value + 1); }}>{MINE_PRESETS[level].label}</button>)}
			<button className={`game-button${mineLevel === "custom" || customOpen ? " is-selected" : ""}`} type="button" onClick={() => setCustomOpen(true)}>自定义</button>
		</div> : null}
		{gameId === "minesweeper" && (customOpen || mineLevel === "custom") ? <form className="mine-custom" onSubmit={applyCustomMine}>
			<label>行<input type="number" min={5} max={30} value={customRows} onChange={(event) => setCustomRows(Number(event.target.value))} /></label>
			<label>列<input type="number" min={5} max={40} value={customCols} onChange={(event) => setCustomCols(Number(event.target.value))} /></label>
			<label>雷<input type="number" min={1} max={Math.max(1, customRows * customCols - 1)} value={customMines} onChange={(event) => setCustomMines(Number(event.target.value))} /></label>
			<button className="game-button primary" type="submit">开始</button>
			{customError ? <p className="game-message is-error">{customError}</p> : <p className="game-note">行 5–30，列 5–40，雷数至少 1，并且要比格子总数少 1。</p>}
		</form> : null}
		<div className="game-layout">
			{gameId === "snake" ? <SnakeGame key={`${snakeLevel}-${round}`} {...panel} width={snakePreset.width} height={snakePreset.height} intervalMs={snakePreset.intervalMs} /> : null}
			{gameId === "2048" ? <NumberGame key={round} {...panel} combine={classicCombine} spawn={classicSpawn} /> : null}
			{gameId === "fibonacci" ? <NumberGame key={round} {...panel} combine={fibonacciCombine} spawn={fibonacciSpawn} /> : null}
			{gameId === "minesweeper" ? <MineGame key={`${mineSetup.label}-${mineSetup.rows}-${mineSetup.cols}-${mineSetup.mines}-${round}`} {...panel} setup={mineSetup} ranked={rankedMine} /> : null}
			<aside className="game-rank game-rank-fallback">
				<h3>{meta.title}排行榜</h3>
				<LeaderboardBody loading={rankedMine || gameId !== "minesweeper" ? loading : false} error={rankNote ? "" : error} board={rankNote ? null : board} note={rankNote} />
			</aside>
		</div>
	</section>;
}
