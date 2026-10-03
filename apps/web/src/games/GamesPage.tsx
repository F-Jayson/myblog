import { ArrowLeft, Gamepad2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ensureGameGuestToken } from "../api";
import { useAuth } from "../auth";
import { resolveMediaUrl } from "../media";
import type { GameLeaderboard, GamePlayer } from "../types";
import {
	classicCombine,
	classicSpawn,
	createBoard,
	createMines,
	createSnake,
	fibonacciCombine,
	fibonacciSpawn,
	hasMoves,
	mineFlagCount,
	MINE_PRESETS,
	moveBoard,
	openMine,
	queueSnakeDirection,
	stepSnake,
	toggleMineFlag,
	type Combine,
	type GameDirection,
	type MineDifficulty,
	type MineState,
	type SnakeState,
} from "./engine";
import "./games.css";

const GAMES = [
	{ id: "snake", title: "贪吃蛇", summary: "吃到食物得 10 分，撞墙或咬到自己就结束。", rules: "方向键、WASD、滑动或下方按键改变方向。不能直接掉头。" },
	{ id: "minesweeper", title: "扫雷", summary: "翻开所有安全格。用时越短，排名越靠前。", rules: "第一次点击必定安全。右键或打开插旗模式标记地雷。初级 9×9、中级 16×16、高级 16×30。" },
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

function tileStyle(value: number): CSSProperties {
	const text = String(value);
	const level = Math.min(16, Math.max(0, Math.round(Math.log2(Math.max(1, value)))));
	const light = Math.max(16, 90 - level * 4.5);
	const fontSize = text.length >= 8 ? ".68rem" : text.length >= 6 ? ".82rem" : text.length >= 4 ? "1.05rem" : text.length >= 3 ? "1.3rem" : "1.6rem";
	return { background: `hsl(152 46% ${light}%)`, color: light > 58 ? "#073126" : "#f4fff9", fontSize };
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

function SnakeGame({ onReport, onRestart, message, messageError, best }: GamePanelProps) {
	const [state, setState] = useState<SnakeState>(() => createSnake());
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
		const id = window.setInterval(() => setState((current) => stepSnake(current)), 140);
		const clockId = window.setInterval(() => setClock((value) => value + 1), 200);
		return () => {
			window.clearInterval(id);
			window.clearInterval(clockId);
		};
	}, [frozen]);

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
	const [snapshot, setSnapshot] = useState(() => ({ board: createBoard(spawn), score: 0, over: false }));
	const [clock, setClock] = useState(0);
	const started = useRef(performance.now());
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const elapsed = useCallback(() => Math.max(1, Math.round(performance.now() - started.current)), []);

	useEffect(() => {
		if (snapshot.over) return;
		const id = window.setInterval(() => setClock((value) => value + 1), 200);
		return () => window.clearInterval(id);
	}, [snapshot.over]);

	const publish = useLeaveScore(() => {
		const current = snapshotRef.current;
		if (current.score <= 0) return null;
		return { score: current.score, durationMs: elapsed() };
	}, onReport);

	useEffect(() => {
		if (snapshot.over) publish();
	}, [snapshot.over, publish]);

	const move = useCallback((direction: GameDirection) => {
		setSnapshot((current) => {
			if (current.over) return current;
			const moved = moveBoard(current.board, direction, combine, spawn);
			if (!moved.moved) return current;
			const score = current.score + moved.scoreGained;
			return { board: moved.board, score, over: !hasMoves(moved.board, combine) };
		});
	}, [combine, spawn]);
	useDirectionKeys(move);
	const swipe = useSwipe(move);
	void clock;

	return <div className="game-stage">
		<div className="game-status">
			<span>得分 <b>{formatPoints(snapshot.score)}</b></span>
			<span>用时 <b>{formatClock(elapsed())}</b></span>
			{best ? <span>最好 <b>{best}</b></span> : null}
			<button className="game-button" type="button" onClick={onRestart}><RotateCcw size={15} />再来一局</button>
		</div>
		<div className="number-board" role="application" aria-label="数字棋盘" {...swipe}>
			{snapshot.board.flat().map((value, index) => <div key={index} className="number-tile" style={value ? tileStyle(value) : undefined}>{value || ""}</div>)}
		</div>
		{snapshot.over ? <div className="game-overlay"><strong>无法继续移动</strong><span>本局 {formatPoints(snapshot.score)}</span><button className="game-button primary" type="button" onClick={onRestart}>再来一局</button></div> : null}
		<ControlPad onDirection={move} />
		<GameMessage text={message} error={messageError} />
	</div>;
}

function MineGame({ difficulty, onReport, onRestart, message, messageError, best }: GamePanelProps & { difficulty: MineDifficulty }) {
	const [state, setState] = useState<MineState>(() => createMines(difficulty));
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
		if (!current.won) return null;
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
		setState((current) => flag ? toggleMineFlag(current, index) : openMine(current, index));
	}

	const flags = mineFlagCount(state);
	void clock;
	const ended = !state.alive || state.won;

	return <div className="game-stage">
		<div className="game-status">
			<span>剩余 <b>{state.mines - flags}</b></span>
			<span>用时 <b>{formatClock(elapsed())}</b></span>
			{best ? <span>最好 <b>{best}</b></span> : null}
			<button className={`game-button${flagMode ? " is-selected" : ""}`} type="button" aria-pressed={flagMode} onClick={() => setFlagMode((value) => !value)}>插旗</button>
			<button className="game-button" type="button" onClick={onRestart}><RotateCcw size={15} />再来一局</button>
		</div>
		<div className="mine-scroll">
			<div className="mine-board" role="grid" aria-label={`${MINE_PRESETS[difficulty].label}扫雷`} style={{ gridTemplateColumns: `repeat(${state.cols}, 1.7rem)` }}>
				{state.cells.map((cell, index) => {
					const className = ["mine-cell", cell.open ? "is-open" : "", cell.mine && cell.open ? "is-mine" : "", cell.flag ? "is-flag" : "", cell.open && cell.near ? `n${cell.near}` : ""].filter(Boolean).join(" ");
					const label = cell.flag ? "旗" : cell.open && cell.mine ? "雷" : cell.open && cell.near ? String(cell.near) : "";
					return <button key={index} type="button" className={className} disabled={ended && !cell.open && !cell.flag} onClick={() => reveal(index, flagMode)} onContextMenu={(event) => { event.preventDefault(); if (!ended) reveal(index, true); }}>{label}</button>;
				})}
			</div>
		</div>
		{ended ? <div className="game-overlay"><strong>{state.won ? "排雷成功" : "踩到地雷了"}</strong>{state.won ? null : <span>这次不记入排行榜</span>}<button className="game-button primary" type="button" onClick={onRestart}>再来一局</button></div> : null}
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

export default function GamesPage() {
	const params = useParams();
	const gameId = isGameId(params.gameId) ? params.gameId : undefined;
	const unknownGame = Boolean(params.gameId) && !gameId;
	const { user, loading: authLoading, features, openAuth } = useAuth();
	const [player, setPlayer] = useState<GamePlayer | null>(null);
	const [board, setBoard] = useState<GameLeaderboard | null>(null);
	const [difficulty, setDifficulty] = useState<MineDifficulty>("beginner");
	const [round, setRound] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [noticeError, setNoticeError] = useState(false);
	const meta = GAMES.find((game) => game.id === gameId);
	const viewRef = useRef({ gameId, difficulty });
	viewRef.current = { gameId, difficulty };

	useEffect(() => {
		if (authLoading || !features.gamesEnabled) return;
		if (!user) ensureGameGuestToken();
		const controller = new AbortController();
		setLoading(true);
		setError("");
		const task = !gameId || unknownGame
			? api.gamesHome().then((result) => { if (!controller.signal.aborted) setPlayer(result.player); })
			: api.gameLeaderboard(gameId, gameId === "minesweeper" ? difficulty : undefined).then((result) => {
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
	}, [authLoading, user, features.gamesEnabled, gameId, unknownGame, difficulty]);

	const report = useCallback((score: number, durationMs: number) => {
		if (!gameId) return;
		const ranked = gameId === "minesweeper" ? durationMs : score;
		if (ranked <= 0) return;
		setNotice("正在记录成绩...");
		setNoticeError(false);
		const submittedGame = gameId;
		const submittedDifficulty = difficulty;
		void api.recordGameScore(gameId, {
			score: gameId === "minesweeper" ? 0 : Math.round(score),
			durationMs: Math.max(0, Math.round(durationMs)),
			difficulty: gameId === "minesweeper" ? difficulty : undefined,
		}).then((result) => {
			const view = viewRef.current;
			const sameGame = view.gameId === submittedGame;
			const sameDifficulty = submittedGame !== "minesweeper" || view.difficulty === submittedDifficulty;
			if (!sameGame || !sameDifficulty) return;
			setBoard(result.leaderboard);
			setPlayer(result.leaderboard.player);
			const rank = result.leaderboard.me?.rank;
			setNotice(result.improved ? `已记入排行榜，当前第 ${rank ?? "—"} 名` : "没有超过最好成绩");
			setNoticeError(false);
		}).catch((reason: unknown) => {
			setNotice(reason instanceof Error ? reason.message : "成绩记录失败");
			setNoticeError(true);
		});
	}, [gameId, difficulty]);

	const restart = useCallback(() => {
		setNotice("");
		setNoticeError(false);
		setRound((value) => value + 1);
	}, []);

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
		{gameId === "minesweeper" ? <div className="game-toolbar">
			{(["beginner", "intermediate", "expert"] as const).map((level) => <button key={level} className={`game-button${difficulty === level ? " is-selected" : ""}`} type="button" onClick={() => { setDifficulty(level); setNotice(""); setRound((value) => value + 1); }}>{MINE_PRESETS[level].label}</button>)}
		</div> : null}
		<div className="game-layout">
			{gameId === "snake" ? <SnakeGame key={round} {...panel} /> : null}
			{gameId === "2048" ? <NumberGame key={round} {...panel} combine={classicCombine} spawn={classicSpawn} /> : null}
			{gameId === "fibonacci" ? <NumberGame key={round} {...panel} combine={fibonacciCombine} spawn={fibonacciSpawn} /> : null}
			{gameId === "minesweeper" ? <MineGame key={`${difficulty}-${round}`} {...panel} difficulty={difficulty} /> : null}
			<aside className="game-rank">
				<h3>排行榜</h3>
				{loading && !board ? <p className="game-note">正在加载排行榜...</p> : null}
				{error ? <p className="game-message is-error">{error}</p> : null}
				{board ? <LeaderList board={board} /> : null}
			</aside>
		</div>
	</section>;
}
