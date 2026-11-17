import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import { encodePumlSource, PUML_MAX_SOURCE_BYTES } from "../src/puml.ts";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** Independent decoder, written from the PlantUML URL format, not from our encoder. */
function decode(encoded: string) {
	const bytes: number[] = [];
	for (let index = 0; index < encoded.length; index += 4) {
		const values = [0, 1, 2, 3].map((offset) => {
			const char = encoded[index + offset];
			return char === undefined ? 0 : ALPHABET.indexOf(char);
		});
		bytes.push((values[0] << 2) | (values[1] >> 4));
		if (encoded[index + 2] !== undefined) bytes.push(((values[1] & 15) << 4) | (values[2] >> 2));
		if (encoded[index + 3] !== undefined) bytes.push(((values[2] & 3) << 6) | values[3]);
	}
	return inflateRawSync(Buffer.from(bytes)).toString("utf8");
}

test("encodePumlSource round-trips through the PlantUML URL format", () => {
	const source = "@startuml\nAlice -> Bob: 认证请求\nnote right: 中文与符号 ☕\n@enduml";
	assert.equal(decode(encodePumlSource(source)), source);
});

test("encodePumlSource stays stable for a reference diagram", () => {
	// Captured from a real PlantUML 1.2025.10 server; a change here means the URL
	// format shifted, which would break every posted source.
	assert.equal(
		encodePumlSource("@startuml\nBob -> Alice : hello\n@enduml"),
		"SoWkIImgAStDuNBAJrBGjLDmpCbCJbMmKiX8pSd9vt98pKifpSq100",
	);
});

test("a blank diagram still encodes to a non-empty payload", () => {
	const encoded = encodePumlSource("@startuml\n@enduml");
	assert.ok(encoded.length > 0);
	assert.equal(decode(encoded), "@startuml\n@enduml");
});

test("the source cap matches the documented 64 KB", () => {
	assert.equal(PUML_MAX_SOURCE_BYTES, 64 * 1024);
});
