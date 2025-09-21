# Network Share

Room-based WebSocket file sharing with drag-and-drop UI.

## Run

1. Install Node.js 18+
2. Install deps: `npm i`
3. Start: `npm run dev`
4. Open `http://localhost:18080` in two browsers (or devices on LAN)

## Protocol

WebSocket JSON messages within a room.

- `hello { room, clientId? }` → server replies `welcome { room, clientId }` and broadcasts `peers` updates
- `relay { payload }` → broadcast to all peers in room except sender

File transfer payloads (app-level):

- Offer: `{ kind: 'file', phase: 'offer', transferId, name, size, mime }`
- Accept: `{ kind: 'file', phase: 'accept', transferId }`
- Chunk: `{ kind: 'file', phase: 'chunk', transferId, data: number[], size, name, mime }`
- Complete: `{ kind: 'file', phase: 'complete', transferId }`

Notes: Chunks are small arrays for simplicity; for large files consider WebRTC or binary frames.


