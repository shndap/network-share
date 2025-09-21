# NetworkShare

Simple LAN file sharing with a visual “room” map. Drop files onto a person to send to them, or onto the floor to broadcast to everyone.

## Features

- Drag-and-drop sending: drop on a desk (targeted) or floor (broadcast)
- Incoming panel with progress, Open, and SVG Download
- Fixed seating layout (725x513), 150x150 desks; extra users appear as guest circles
- Names: each client sets a display name; peers are normalized and shown consistently
- WebSocket relay with chunked transfer (no external services)

## Quick start

1) Requirements: Node.js 18+

2) Install

```bash
npm i
```

3) Run

```bash
npm run dev
```

Open `http://localhost:18080` in two browsers/devices on the same network.

If port 18080 is taken, the server will try the next ports.

## How it works

- Server serves static UI and a WebSocket endpoint
- Messages
  - `hello { clientId?, identity }` → `welcome { clientId, identity }`, `peers`, `layout`
  - `relay { to?, payload }` → forwarded to `to` or broadcast to others
  - `layout_update` is ignored (layout is fixed server-side)
- File payloads
  - offer: `{ kind: 'file', phase: 'offer', transferId, name, size, mime }`
  - accept: `{ kind: 'file', phase: 'accept', transferId }`
  - chunk: `{ kind: 'file', phase: 'chunk', transferId, data: number[], size, name, mime }`
  - complete: `{ kind: 'file', phase: 'complete', transferId }`

Notes: This uses JSON frames. For huge files or many clients, consider binary frames or WebRTC.

## Security

LAN only by default. If exposing on the internet:

- Use HTTPS + WSS and a reverse proxy that supports WebSockets
- Restrict access (VPN, auth) as needed

## License

MIT
