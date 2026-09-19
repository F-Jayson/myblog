# User Tools And Shared Space

## Scope

Authenticated users have a small-tools entry in the site sidebar. It provides an image host, an online clipboard, a container-backed compiler, a user centre and a space-management view. The image host and clipboard support private ownership, optional public sharing, public links and view counters. The compiler runs submitted code in a short-lived, network-isolated Docker container with resource limits, and supports syntax highlighting, formatting, standard input and line breakpoints. Python, JavaScript and TypeScript use real line tracing for breakpoints; other supported languages return run diagnostics. The user centre supports profile updates, and administrators can inspect and manage each user's stored data.

## Shared 30MB quota

Each `comment_users` account owns one shared quota of `30 * 1024 * 1024` bytes. The quota is calculated from all rows in `user_storage_items`, all `user_clipboards` bodies and all rows in `comment_user_stickers`.

`user_storage_items` holds image-host files and authenticated-user image data such as avatars and comment images. `user_clipboards` holds editable text separately so a body can be updated without changing file metadata. Personal stickers remain in their existing table for comment compatibility, but are included in the same quota calculation.

Clipboard byte usage is `Buffer.byteLength(content, "utf8")`; this deliberately measures actual UTF-8 bytes rather than JavaScript character count. File byte usage must use the uploaded file's real byte length. All new quota-consuming writes start a transaction and lock the owner user row with `SELECT ... FOR UPDATE` before reading usage, so concurrent uploads or edits for one user cannot both pass the remaining-space check.

The current space response reports the total, remaining bytes and these categories: all tracked images, image-host images, authenticated comment images, avatars, clipboard bodies and personal stickers. The image total is a parent total; the subcategories are explanatory and must not be added to it again.

## Data model

`user_storage_items` contains owner, kind, display name, storage URL/key, MIME type, byte size, publication state, nullable opaque public token, view count and timestamps. `user_clipboards` contains owner, title, long-text content, content type (`text`, `markdown` or `code`), optional highlight language, UTF-8 byte size, publication state, opaque public token, view count and timestamps. Both reference `comment_users(id)` with `ON DELETE CASCADE` and index owner/date plus public token lookup. Public clipboard links open `/share/:token` for a rendered preview; the JSON payload remains at `/api/public/resources/:token`.

Public tokens are 32 random bytes encoded as base64url (43 characters) and are unique at database level. Enabling public access creates a token only when none exists; repeatedly saving public access keeps the current link. Disabling public access clears the token, immediately invalidating the old link. Public reads must always require both the token and `is_public = true`, then atomically increment the appropriate view counter.

## Access and profile rules

Image host, clipboard, user centre and space APIs require an authenticated comment-user session. Private image files must be served through an owner-authorised endpoint instead of a publicly mounted upload path. Public-resource routes expose only an item whose publication flag is enabled. API responses must not expose password hashes, session tokens or raw email-verification codes.

Users can update avatar, nickname, account, email and password. When the comment email setting `emailRegistrationEnabled` is enabled, changing account, email or password requires a valid email verification code for the account's verified/current email flow. Avatar and nickname changes do not require that code. Verification codes are hashed, expire after 15 minutes, have a five-attempt limit and are deleted after successful verification.

The public auth routes also honor the site feature switches. When registration is disabled, the code-request and register endpoints are rejected. When login is disabled, both login routes are rejected, and registration returns the created account without opening a login session.

## Site feature switches

The administrator opens `站点设置` and clicks `功能开关` to edit the switches in the existing admin workspace. This is an in-page section, so the left admin navigation remains visible. Saving uses `PATCH /api/admin/features`; the public frontend reads the current values from `GET /api/features`. The eight switches are:

- `commentsEnabled`: comment listing, submission, comment images and stickers.
- `registrationEnabled`: new account registration and registration email-code requests.
- `loginEnabled`: new login sessions. Existing sessions are not revoked automatically when this switch is turned off.
- `imageHostingEnabled`: authenticated image-host uploads, image visibility changes and image files.
- `clipboardEnabled`: authenticated clipboard create, edit, visibility, read and delete operations.
- `userCenterEnabled`: user profile, shared-space summary and authenticated user-tool APIs.
- `publicResourcesEnabled`: public image and clipboard links under `/api/public/resources/:token`; disabling it blocks public reads without deleting stored data.
- `compilerEnabled`: authenticated compiler language listing, execution, formatting and debugging endpoints.

The backend checks these switches on every relevant request, while the frontend hides disabled sidebar entries and shows an unavailable state for a directly opened route. Turning a switch off keeps existing records intact; turning it on makes the corresponding controls available again. The switches are stored as the `features` JSON value in `site_settings`, and missing keys default to enabled for backwards compatibility.

## Storage and deletion

User-owned images should be written beneath a private user-storage directory and recorded only after the quota transaction succeeds. If file writing precedes the database record, the upload handler must remove the new file on a failed quota/database write. Conversely, deleting a resource should first return its storage key from the repository, delete the database row, then remove only that validated user-storage file. Administrators use the same deletion path. User deletion cascades database records; operational cleanup must additionally remove the corresponding private directory and legacy personal-sticker files when applicable.

## API surface

The implementation exposes, or should expose, the following groups:

- Authenticated user: space summary; image upload/list/file/read/visibility/delete; clipboard create/list/read/update/delete; profile read/update; email-code send/verify.
- Authenticated compiler: `GET /api/compiler/languages`; `POST /api/compiler/run`, `/debug` and `/format` (the `/api/user/compiler/*` aliases are also available).
- Public: `GET /api/public/resources/:token` for an enabled image or clipboard, with a view-count increment.
- Administrator: user-space list with account/nickname/email filtering; one user's resources and quota summary; user activation/ban changes; resource, clipboard and personal-sticker deletion.

Exact request-path names are defined by `apps/api/src/server.ts`; all mutation routes must use the authenticated session principal rather than a client-supplied owner id.

## Migration and deployment

Apply `database/schema.sql` with `pnpm db:migrate`, then run `pnpm db:seed` as normal. New tables are declared with `CREATE TABLE IF NOT EXISTS`, so existing installations gain them without altering legacy comment tables. Create the configured private upload directory with write access for the API service, and ensure it is not exposed by the web server's static upload mapping.

## Administration and anonymous compatibility

The admin space screen shows each user’s quota usage, category breakdown, stored images, clipboards, stickers, public/private state and view counters. It supports account-level activation/ban and content deletion. It must preserve the same ownership checks as user actions.

Legacy anonymous comment images, anonymous avatars and pre-login uploads continue using their current public/legacy path for backwards compatibility and do not consume an account quota because no account can own them. Once an authenticated upload is wired to the new storage API, comment images, avatars and personal stickers must record their actual bytes in the shared account quota. Existing legacy files are not retroactively charged unless migrated into a user-owned record.

## Verification checklist

- Create simultaneous uploads or clipboard edits for one user and confirm the total never exceeds 30MB.
- Confirm Chinese and emoji clipboard content uses UTF-8 byte accounting.
- Confirm a private resource returns no public content; disable public access and confirm its old link stops working.
- Confirm public image and clipboard reads increment the displayed view count.
- Confirm user profile sensitive changes require a valid code only when the setting is enabled.
- Confirm user and administrator deletes remove metadata and the validated associated file, while account deletion cleans user-owned storage.
- Run database migration/seed, API and web type checks/builds, and `git diff --check` before deployment.
