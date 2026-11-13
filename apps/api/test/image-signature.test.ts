import assert from "node:assert/strict";
import test from "node:test";
import { imageExtensionForMime, sniffImageMime } from "../src/imageSignature.js";

test("sniffImageMime accepts real image headers and rejects html disguised as an image", () => {
	assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
	assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
	assert.equal(sniffImageMime(Buffer.from("GIF89a", "ascii")), "image/gif");
	const webp = Buffer.alloc(12);
	webp.write("RIFF", 0, "ascii");
	webp.write("WEBP", 8, "ascii");
	assert.equal(sniffImageMime(webp), "image/webp");
	const avif = Buffer.alloc(12);
	avif.write("ftyp", 4, "ascii");
	avif.write("avif", 8, "ascii");
	assert.equal(sniffImageMime(avif), "image/avif");
	assert.equal(sniffImageMime(Buffer.from("<html><script>alert(1)</script></html>", "utf8")), "");
	assert.equal(sniffImageMime(Buffer.from("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8")), "");
});

test("imageExtensionForMime only returns extensions for sniffed image types", () => {
	assert.equal(imageExtensionForMime("image/jpeg"), ".jpg");
	assert.equal(imageExtensionForMime("image/png"), ".png");
	assert.equal(imageExtensionForMime("image/gif"), ".gif");
	assert.equal(imageExtensionForMime("image/webp"), ".webp");
	assert.equal(imageExtensionForMime("image/avif"), ".avif");
	assert.equal(imageExtensionForMime("text/html"), "");
	assert.equal(imageExtensionForMime("image/svg+xml"), "");
});
