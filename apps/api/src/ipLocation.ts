import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { IPv4, IPv6, loadContentFromFile, newWithBuffer, type Searcher } from "ip2region.js";
import * as ip2region from "ip2region.js";

export type IpLocationType = "public" | "private" | "loopback" | "unknown" | "invalid";

export type IpLocation = {
	ip: string;
	type: IpLocationType;
	label: string;
	country: string;
	region: string;
	city: string;
	isp: string;
	isPrivate: boolean;
};

type DatabaseKind = "v4" | "v6";

const CACHE_LIMIT = 5_000;
const cache = new Map<string, IpLocation>();
const warned = new Set<string>();
const searchers = new Map<DatabaseKind, Searcher | null>();

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const privateSpace = new BlockList();
privateSpace.addSubnet("10.0.0.0", 8, "ipv4");
privateSpace.addSubnet("172.16.0.0", 12, "ipv4");
privateSpace.addSubnet("192.168.0.0", 16, "ipv4");
privateSpace.addSubnet("169.254.0.0", 16, "ipv4");
privateSpace.addSubnet("100.64.0.0", 10, "ipv4");
privateSpace.addSubnet("fc00::", 7, "ipv6");
privateSpace.addSubnet("fe80::", 10, "ipv6");

function databasePath(kind: DatabaseKind) {
	const override = kind === "v4" ? process.env.IP2REGION_V4_XDB : process.env.IP2REGION_V6_XDB;
	if (override?.trim()) return override.trim();
	const fileName = kind === "v4" ? "ip2region_v4.xdb" : "ip2region_v6.xdb";
	return fileURLToPath(new URL(`../../../data/ip2region/${fileName}`, import.meta.url));
}

function warnOnce(key: string, message: string) {
	if (warned.has(key)) return;
	warned.add(key);
	console.warn(message);
}

function searcherFor(kind: DatabaseKind) {
	if (searchers.has(kind)) return searchers.get(kind) ?? null;
	const dbPath = databasePath(kind);
	if (!existsSync(dbPath)) {
		searchers.set(kind, null);
		warnOnce(dbPath, `[ip-location] ${kind} database not found: ${dbPath}`);
		return null;
	}
	try {
		const verify = (ip2region as { verifyFromFile?: (path: string) => void }).verifyFromFile;
		verify?.(dbPath);
		const version = kind === "v4" ? IPv4 : IPv6;
		const searcher = newWithBuffer(version, loadContentFromFile(dbPath));
		searchers.set(kind, searcher);
		console.log(`[ip-location] loaded ${kind} database from ${dbPath}`);
		return searcher;
	} catch (error) {
		searchers.set(kind, null);
		const message = error instanceof Error ? error.message : String(error);
		warnOnce(dbPath, `[ip-location] failed to load ${kind} database ${dbPath}: ${message}`);
		return null;
	}
}

function remember(location: IpLocation) {
	if (cache.has(location.ip)) cache.delete(location.ip);
	cache.set(location.ip, location);
	if (cache.size <= CACHE_LIMIT) return location;
	const oldest = cache.keys().next().value;
	if (oldest) cache.delete(oldest);
	return location;
}

function location(ip: string, type: IpLocationType, label: string, extra: Partial<Pick<IpLocation, "country" | "region" | "city" | "isp">> = {}): IpLocation {
	return remember({
		ip,
		type,
		label,
		country: extra.country ?? "",
		region: extra.region ?? "",
		city: extra.city ?? "",
		isp: extra.isp ?? "",
		isPrivate: type === "private" || type === "loopback",
	});
}

export function normalizeClientIp(value: string) {
	let ip = value.trim();
	if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
	const zone = ip.indexOf("%");
	if (zone >= 0) ip = ip.slice(0, zone);
	if (ip.startsWith("::ffff:")) {
		const mapped = ip.slice("::ffff:".length);
		if (isIP(mapped) === 4) return mapped;
	}
	return ip;
}

function cleanField(value: string | undefined) {
	const text = (value ?? "").trim();
	return !text || text === "0" ? "" : text;
}

function parseRegion(raw: string) {
	const parts = raw.split("|").map((part) => part.trim());
	let country = "";
	let region = "";
	let city = "";
	let isp = "";
	if (parts.length >= 5 && /^[A-Za-z]{2}$/u.test(parts[4] ?? "")) {
		country = cleanField(parts[0]);
		region = cleanField(parts[1]);
		city = cleanField(parts[2]);
		isp = cleanField(parts[3]);
	} else if (parts.length >= 4 && cleanField(parts[1]) === "" && (cleanField(parts[2]) || cleanField(parts[3]))) {
		country = cleanField(parts[0]);
		region = cleanField(parts[2]);
		city = cleanField(parts[3]);
		isp = cleanField(parts[4]);
	} else {
		country = cleanField(parts[0]);
		region = cleanField(parts[1]);
		city = cleanField(parts[2]);
		isp = cleanField(parts[3]);
	}
	if (region && city && (region === city || city.startsWith(region))) city = region === city ? "" : city;
	const place = country === "中国" ? [region, city] : [country, region, city];
	const label = [...new Set(place.filter(Boolean))].join(" ");
	return { country, region, city, isp, label };
}

export async function locateIp(value: string): Promise<IpLocation> {
	const ip = normalizeClientIp(value);
	const cached = cache.get(ip);
	if (cached) {
		cache.delete(ip);
		cache.set(ip, cached);
		return cached;
	}
	const family = isIP(ip);
	if (!ip || family === 0) return location(ip, "invalid", "无效地址");
	const kind = family === 4 ? "ipv4" : "ipv6";
	if (loopback.check(ip, kind)) return location(ip, "loopback", "本机");
	if (privateSpace.check(ip, kind)) return location(ip, "private", "内网");

	const searcher = searcherFor(family === 4 ? "v4" : "v6");
	if (!searcher) return location(ip, "unknown", "位置未知");
	try {
		const raw = String(await searcher.search(ip)).trim();
		if (!raw) return location(ip, "unknown", "位置未知");
		const parsed = parseRegion(raw);
		if (!parsed.label || parsed.label === "内网IP") return location(ip, "private", "内网");
		return location(ip, "public", parsed.label, parsed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnOnce(`search:${ip}`, `[ip-location] lookup failed for ${ip}: ${message}`);
		return location(ip, "unknown", "位置未知");
	}
}

export async function displayIpLocation(stored: unknown, ip: unknown) {
	const saved = typeof stored === "string" ? stored.trim() : "";
	if (saved) return saved;
	const located = await locateIp(typeof ip === "string" ? ip : "");
	if (located.type === "unknown" || located.type === "invalid" || !located.label) return null;
	return located.label;
}

export function warmIpLocation() {
	searcherFor("v4");
	searcherFor("v6");
}
