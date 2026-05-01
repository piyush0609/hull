# RFC: Share Page Comments

## Summary

Add collaborative comments directly on shared HTML pages.

Supported in V1:

- authenticated comments only
- artifact-level comments
- element-level comments
- text-selection comments
- replies
- resolve / reopen
- edit own messages
- delete own messages
- delete own threads

Comments are visible on the shared page UI itself.

## Goals

- Let anyone with page access discuss the shared artifact from the page itself
- Avoid owner-only restrictions for discussion
- Support both general comments and anchored comments
- Keep the data model portable across Cloudflare D1 and Vercel Postgres

## Non-goals

- anonymous comments
- mentions / notifications
- file attachments
- realtime websockets
- fine-grained moderation roles

## Roles and Access

Two different kinds of access matter here:

1. Page access
- the viewer can open the shared artifact page
- this can come from a public share link, a password-protected share, or a legacy signed link

2. Comment identity
- the viewer provides a valid toss token
- this identifies them as an authenticated toss user

Rules:

- anyone with page access can read threads
- only authenticated toss users can create, reply, edit, delete, resolve, or reopen
- anyone with page access and a valid toss token can resolve or reopen
- message edit/delete is limited to the message author or admin
- thread delete is limited to the thread creator or admin

## Data Model

Use a thread model.

### `comment_threads`

- `id`
- `artifact_id`
- `created_by_token_hash`
- `created_by_label`
- `scope_type` -> `artifact | element | selection`
- `anchor_json`
- `status` -> `open | resolved`
- `resolved_by_token_hash`
- `resolved_by_label`
- `resolved_at`
- `deleted_at`
- `deleted_by_token_hash`
- `created_at`
- `updated_at`

### `comment_messages`

- `id`
- `thread_id`
- `author_token_hash`
- `author_label`
- `body`
- `created_at`
- `updated_at`
- `deleted_at`
- `deleted_by_token_hash`

## Anchors

### Artifact-level

```json
{
  "scopeType": "artifact"
}
```

### Element-level

```json
{
  "scopeType": "element",
  "anchor": {
    "selector": "#pricing-card",
    "textSnippet": "Pro plan",
    "rect": { "x": 420, "y": 180, "width": 220, "height": 90 }
  }
}
```

### Selection-level

```json
{
  "scopeType": "selection",
  "anchor": {
    "selector": "main p:nth-of-type(2)",
    "selectedText": "Faster builds for every branch",
    "textSnippet": "Faster builds for every branch with preview URLs",
    "rect": { "x": 120, "y": 260, "width": 240, "height": 18 },
    "startOffset": 0,
    "endOffset": 30
  }
}
```

`anchor_json` is intentionally flexible so the UI can improve anchor recovery later.

## API

### Read threads

`GET /artifacts/:artifactId/comment-threads`

Requires:
- valid viewer access token from the rendered share page

Optional:
- `Authorization: Bearer <toss-token>`

Returns:
- threads
- nested messages
- current viewer permissions when authenticated

### Create thread

`POST /artifacts/:artifactId/comment-threads`

Body:

```json
{
  "body": "CTA spacing feels off",
  "scopeType": "element",
  "anchor": {
    "selector": ".cta-button",
    "textSnippet": "Start free"
  }
}
```

Requires:
- viewer access token
- authenticated toss token

### Reply

`POST /comment-threads/:threadId/messages`

### Edit message

`PATCH /comment-messages/:messageId`

### Delete message

`DELETE /comment-messages/:messageId`

### Delete thread

`DELETE /comment-threads/:threadId`

### Resolve

`POST /comment-threads/:threadId/resolve`

### Reopen

`POST /comment-threads/:threadId/reopen`

## Share Page UI

The comment UI is injected into served HTML pages.

Main pieces:

- right sidebar
- token connect box
- add general comment
- add element comment mode
- add selection comment mode
- open/resolved filters
- reply editor
- resolve / reopen
- edit / delete controls for owned messages
- small page pins for element / selection anchors

## Auth Model In Browser

The share page embeds a short-lived viewer token for the specific artifact.

The browser sends:

- `X-Toss-Viewer: <viewer-token>` for read and write requests
- `Authorization: Bearer <toss-token>` for authenticated mutations

This avoids depending on browser cookies for comment authorization and keeps the share page self-contained.

## Backend Notes

Cloudflare:

- D1 stores comment rows
- existing worker API grows comment routes

Vercel:

- Postgres stores comment rows
- existing edge API grows matching comment routes

## Open Follow-ups

- mention system
- notification delivery
- more robust text-anchor recovery when the DOM changes
- attachment support
- read-only audit history for edits and deletes
