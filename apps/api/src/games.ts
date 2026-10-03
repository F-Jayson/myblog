import { createHash } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { z } from "zod";
import { pool } from "./db.js";
import { presetAvatarForSeed, randomPresetAvatar, type CommentPrincipal } from "./repository.js";

type GameSpec = {
	lowerIsBetter: boolean;
	minScore: number;
	maxScore: number;
	minDurationMs: number;
	maxDurationMs: number;
	maxScorePerMs: number;
};

const MINE_DIFFICULTIES = ["beginner", "intermediate", "expert"] as const;
type MineDifficulty = typeof MINE_DIFFICULTIES[number];

const GAME_SPECS: Record<string, GameSpec> = {
	snake: { lowerIsBetter: false, minScore: 10, maxScore: 5_000, minDurationMs: 80, maxDurationMs: 3_600_000, maxScorePerMs: 0.2 },
	"2048": { lowerIsBetter: false, minScore: 4, maxScore: 2_000_000_000, minDurationMs: 50, maxDurationMs: 7_200_000, maxScorePerMs: 5_000 },
	fibonacci: { lowerIsBetter: false, minScore: 2, maxScore: 1_000_000_000_000_000, minDurationMs: 50, maxDurationMs: 7_200_000, maxScorePerMs: 50_000 },
	"minesweeper:beginner": { lowerIsBetter: true, minScore: 200, maxScore: 3_600_000, minDurationMs: 200, maxDurationMs: 3_600_000, maxScorePerMs: 0 },
	"minesweeper:intermediate": { lowerIsBetter: true, minScore: 800, maxScore: 7_200_000, minDurationMs: 800, maxDurationMs: 7_200_000, maxScorePerMs: 0 },
	"minesweeper:expert": { lowerIsBetter: true, minScore: 3_000, maxScore: 7_200_000, minDurationMs: 3_000, maxDurationMs: 7_200_000, maxScorePerMs: 0 },
};

const PUBLIC_GAMES = [
	{ id: "snake", title: "贪吃蛇", lowerIsBetter: false },
	{ id: "minesweeper", title: "扫雷", lowerIsBetter: true, difficulties: MINE_DIFFICULTIES },
	{ id: "2048", title: "2048", lowerIsBetter: false },
	{ id: "fibonacci", title: "斐波那契 2048", lowerIsBetter: false },
] as const;

const scoreInput = z.object({
	score: z.number().int().nonnegative().max(1_000_000_000_000_000),
	durationMs: z.number().int().nonnegative().max(7_200_000),
	difficulty: z.enum(MINE_DIFFICULTIES).optional(),
});

type PlayerIdentity =
	| { kind: "user"; id: number; name: string; avatar: string }
	| { kind: "guest"; id: number; name: string; avatar: string };

type LeaderEntry = {
	rank: number;
	playerKey: string;
	name: string;
	avatar: string;
	isGuest: boolean;
	score: number;
	durationMs: number;
	achievedAt: string;
};

const recentHits = new Map<string, number[]>();

function allowRate(key: string, limit: number, windowMs: number) {
	const now = Date.now();
	const hits = (recentHits.get(key) ?? []).filter((at) => now - at < windowMs);
	if (hits.length >= limit) {
		recentHits.set(key, hits);
		return false;
	}
	hits.push(now);
	recentHits.set(key, hits);
	if (recentHits.size > 5_000) {
		for (const [entry, times] of recentHits) {
			if (times.every((at) => now - at >= windowMs)) recentHits.delete(entry);
		}
	}
	return true;
}

function clientIp(req: Request) {
	const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
	return forwarded || req.ip || req.socket.remoteAddress || "unknown";
}

function guestToken(req: Request) {
	const token = req.header("x-game-guest")?.trim() ?? "";
	return /^[a-f0-9]{32,64}$/iu.test(token) ? token.toLowerCase() : "";
}

function tokenHash(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

function commentUser(req: Request) {
	const user = (req as Request & { commentUser?: CommentPrincipal }).commentUser;
	if (!user || !Number.isInteger(user.id) || user.id < 1) return null;
	return user;
}

function asNumber(value: unknown) {
	const parsed = typeof value === "bigint" ? Number(value) : Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function databaseMissing(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ER_NO_SUCH_TABLE";
}

function duplicateEntry(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ER_DUP_ENTRY";
}

function gameKey(game: string, difficulty?: string) {
	if (game === "minesweeper") {
		const level = MINE_DIFFICULTIES.includes(difficulty as MineDifficulty) ? difficulty : "beginner";
		return `minesweeper:${level}`;
	}
	return GAME_SPECS[game] ? game : "";
}

function publicGame(game: string) {
	return game.startsWith("minesweeper:") ? "minesweeper" : game;
}

async function readGuest(hash: string) {
	const [rows] = await pool.query<RowDataPacket[]>("SELECT id, display_name, avatar_url FROM game_guests WHERE token_hash = ? LIMIT 1", [hash]);
	const row = rows[0];
	if (!row) return null;
	const id = asNumber(row.id);
	const storedName = String(row.display_name ?? "");
	return {
		kind: "guest" as const,
		id,
		name: /^游客\d+$/u.test(storedName) ? storedName : `游客${id}`,
		avatar: String(row.avatar_url || presetAvatarForSeed(id)),
	};
}

async function ensureGuest(token: string, ip: string) {
	const hash = tokenHash(token);
	const existing = await readGuest(hash);
	if (existing) return existing;
	if (!allowRate(`guest-create:${ip}`, 8, 60 * 60 * 1000)) {
		const error = new Error("游客身份创建过于频繁，请稍后再试");
		(error as Error & { status?: number }).status = 429;
		throw error;
	}
	const avatar = randomPresetAvatar();
	const connection = await pool.getConnection();
	try {
		await connection.beginTransaction();
		const [result] = await connection.execute<ResultSetHeader>(
			"INSERT INTO game_guests (token_hash, display_name, avatar_url) VALUES (?, '游客', ?)",
			[hash, avatar],
		);
		const id = asNumber(result.insertId);
		const name = `游客${id}`;
		await connection.execute("UPDATE game_guests SET display_name = ? WHERE id = ?", [name, id]);
		await connection.commit();
		return { kind: "guest" as const, id, name, avatar };
	} catch (error) {
		await connection.rollback();
		if (!duplicateEntry(error)) throw error;
		const created = await readGuest(hash);
		if (created) return created;
		throw error;
	} finally {
		connection.release();
	}
}

async function resolvePlayer(req: Request) {
	const user = commentUser(req);
	if (user) {
		const name = user.nickname.trim() || user.account;
		const [rows] = await pool.query<RowDataPacket[]>("SELECT avatar_url FROM comment_users WHERE id = ? LIMIT 1", [user.id]);
		const stored = String(rows[0]?.avatar_url ?? "").trim();
		return {
			kind: "user" as const,
			id: user.id,
			name,
			avatar: stored || presetAvatarForSeed(user.id),
		};
	}
	const token = guestToken(req);
	if (!token) return null;
	return ensureGuest(token, clientIp(req));
}

function playerKey(player: PlayerIdentity) {
	return `${player.kind}:${player.id}`;
}

function mapEntry(row: RowDataPacket, rank: number): LeaderEntry {
	const isGuest = asNumber(row.user_id) < 1;
	const id = isGuest ? asNumber(row.guest_id) : asNumber(row.user_id);
	const name = String(row.display_name ?? "").trim() || (isGuest ? `游客${id}` : "用户");
	return {
		rank,
		playerKey: `${isGuest ? "guest" : "user"}:${id}`,
		name,
		avatar: String(row.avatar_url || presetAvatarForSeed(id)),
		isGuest,
		score: asNumber(row.score),
		durationMs: asNumber(row.duration_ms),
		achievedAt: String(row.achieved_at ?? ""),
	};
}

const LEADER_SQL = `SELECT r.score, r.duration_ms, r.achieved_at, r.user_id, r.guest_id,
	COALESCE(NULLIF(u.nickname, ''), NULLIF(u.account, ''), g.display_name) AS display_name,
	COALESCE(NULLIF(u.avatar_url, ''), g.avatar_url) AS avatar_url
	FROM game_records r
	LEFT JOIN comment_users u ON u.id = r.user_id
	LEFT JOIN game_guests g ON g.id = r.guest_id`;

async function readOwnRecord(key: string, player: PlayerIdentity) {
	const column = player.kind === "user" ? "user_id" : "guest_id";
	const [rows] = await pool.query<RowDataPacket[]>(
		`${LEADER_SQL} WHERE r.game_key = ? AND r.${column} = ? LIMIT 1`,
		[key, player.id],
	);
	return rows[0] ? mapEntry(rows[0], 0) : null;
}

async function rankOf(key: string, lowerIsBetter: boolean, entry: LeaderEntry) {
	const [rows] = await pool.query<RowDataPacket[]>(
		`SELECT COUNT(*) AS better FROM game_records
		 WHERE game_key = ? AND (
		   (? = 0 AND (score > ? OR (score = ? AND duration_ms < ?) OR (score = ? AND duration_ms = ? AND achieved_at < ?)))
		   OR (? = 1 AND (score < ? OR (score = ? AND duration_ms < ?) OR (score = ? AND duration_ms = ? AND achieved_at < ?)))
		 )`,
		[
			key,
			lowerIsBetter ? 1 : 0, entry.score, entry.score, entry.durationMs, entry.score, entry.durationMs, entry.achievedAt,
			lowerIsBetter ? 1 : 0, entry.score, entry.score, entry.durationMs, entry.score, entry.durationMs, entry.achievedAt,
		],
	);
	return asNumber(rows[0]?.better) + 1;
}

async function leaderboard(key: string, player: PlayerIdentity | null) {
	const spec = GAME_SPECS[key];
	const direction = spec.lowerIsBetter ? "ASC" : "DESC";
	const [rows] = await pool.query<RowDataPacket[]>(
		`${LEADER_SQL} WHERE r.game_key = ? ORDER BY r.score ${direction}, r.duration_ms ASC, r.achieved_at ASC LIMIT 30`,
		[key],
	);
	const entries = rows.map((row, index) => mapEntry(row, index + 1));
	let me: LeaderEntry | null = null;
	if (player) {
		const own = entries.find((entry) => entry.playerKey === playerKey(player)) ?? await readOwnRecord(key, player);
		if (own) me = { ...own, rank: own.rank > 0 ? own.rank : await rankOf(key, spec.lowerIsBetter, own) };
	}
	return {
		game: publicGame(key),
		difficulty: key.startsWith("minesweeper:") ? key.slice("minesweeper:".length) : null,
		lowerIsBetter: spec.lowerIsBetter,
		entries,
		me,
		player: player ? { playerKey: playerKey(player), name: player.name, avatar: player.avatar, isGuest: player.kind === "guest" } : null,
	};
}

function validateScore(key: string, score: number, durationMs: number) {
	const spec = GAME_SPECS[key];
	if (!spec) return "未知的小游戏";
	const ranked = spec.lowerIsBetter ? durationMs : score;
	if (!Number.isSafeInteger(ranked) || ranked < spec.minScore || ranked > spec.maxScore) return "成绩超出可记录范围";
	if (durationMs < spec.minDurationMs || durationMs > spec.maxDurationMs) return "游戏时长超出可记录范围";
	if (!spec.lowerIsBetter && durationMs > 0 && score / durationMs > spec.maxScorePerMs) return "成绩与游戏时长不匹配";
	if (key === "snake" && durationMs < score * 8) return "成绩与游戏时长不匹配";
	return "";
}

async function saveScore(key: string, player: PlayerIdentity, score: number, durationMs: number) {
	const spec = GAME_SPECS[key];
	const before = await readOwnRecord(key, player);
	const userId = player.kind === "user" ? player.id : null;
	const guestId = player.kind === "guest" ? player.id : null;
	await pool.execute(
		`INSERT INTO game_records (game_key, user_id, guest_id, score, lower_is_better, duration_ms)
		 VALUES (?, ?, ?, ?, ?, ?) AS incoming
		 ON DUPLICATE KEY UPDATE
		   duration_ms = IF(
		     (game_records.lower_is_better = 0 AND (incoming.score > game_records.score OR (incoming.score = game_records.score AND incoming.duration_ms < game_records.duration_ms)))
		     OR (game_records.lower_is_better = 1 AND (incoming.score < game_records.score OR (incoming.score = game_records.score AND incoming.duration_ms < game_records.duration_ms))),
		     incoming.duration_ms, game_records.duration_ms),
		   achieved_at = IF(
		     (game_records.lower_is_better = 0 AND (incoming.score > game_records.score OR (incoming.score = game_records.score AND incoming.duration_ms < game_records.duration_ms)))
		     OR (game_records.lower_is_better = 1 AND (incoming.score < game_records.score OR (incoming.score = game_records.score AND incoming.duration_ms < game_records.duration_ms))),
		     CURRENT_TIMESTAMP, game_records.achieved_at),
		   score = IF(
		     (game_records.lower_is_better = 0 AND incoming.score > game_records.score)
		     OR (game_records.lower_is_better = 1 AND incoming.score < game_records.score),
		     incoming.score, game_records.score)`,
		[key, userId, guestId, score, spec.lowerIsBetter ? 1 : 0, durationMs],
	);
	const board = await leaderboard(key, player);
	const improved = !before || (spec.lowerIsBetter ? score < before.score : score > before.score) || (score === before.score && durationMs < before.durationMs);
	return { improved, leaderboard: board };
}

function sendGameError(res: Response, error: unknown, next: NextFunction) {
	if (databaseMissing(error)) {
		res.status(503).json({ error: "小游戏数据表还没有初始化" });
		return;
	}
	const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: number }).status) : 0;
	if (status === 429) {
		res.status(429).json({ error: error instanceof Error ? error.message : "请求过于频繁" });
		return;
	}
	next(error);
}

export const gameRouter = Router();

gameRouter.get("/", async (req, res, next) => {
	try {
		const player = await resolvePlayer(req);
		res.json({
			games: PUBLIC_GAMES,
			player: player ? { playerKey: playerKey(player), name: player.name, avatar: player.avatar, isGuest: player.kind === "guest" } : null,
		});
	} catch (error) {
		sendGameError(res, error, next);
	}
});

gameRouter.get("/:game/leaderboard", async (req, res, next) => {
	try {
		const game = String(req.params.game ?? "");
		const difficulty = typeof req.query.difficulty === "string" ? req.query.difficulty : undefined;
		const key = gameKey(game, difficulty);
		if (!key || !GAME_SPECS[key]) {
			res.status(404).json({ error: "没有这个小游戏" });
			return;
		}
		res.json(await leaderboard(key, await resolvePlayer(req)));
	} catch (error) {
		sendGameError(res, error, next);
	}
});

gameRouter.post("/:game/scores", async (req, res, next) => {
	try {
		const game = String(req.params.game ?? "");
		const input = scoreInput.parse(req.body);
		const key = gameKey(game, input.difficulty);
		if (!key || !GAME_SPECS[key]) {
			res.status(404).json({ error: "没有这个小游戏" });
			return;
		}
		if (game === "minesweeper" && !input.difficulty) {
			res.status(400).json({ error: "请选择扫雷难度" });
			return;
		}
		const player = await resolvePlayer(req);
		if (!player) {
			res.status(400).json({ error: "缺少游客身份" });
			return;
		}
		const spec = GAME_SPECS[key];
		const score = spec.lowerIsBetter ? input.durationMs : input.score;
		const problem = validateScore(key, input.score, input.durationMs);
		if (problem) {
			res.status(400).json({ error: problem });
			return;
		}
		const limitKey = `score:${playerKey(player)}`;
		if (!allowRate(limitKey, 20, 10 * 60 * 1000) || !allowRate(`score-ip:${clientIp(req)}`, 40, 10 * 60 * 1000)) {
			res.status(429).json({ error: "提交成绩过于频繁，请稍后再试" });
			return;
		}
		const saved = await saveScore(key, player, score, input.durationMs);
		res.json({ saved: true, improved: saved.improved, leaderboard: saved.leaderboard });
	} catch (error) {
		sendGameError(res, error, next);
	}
});
