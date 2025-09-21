import express from 'express'
import http from 'http'
import { WebSocketServer } from 'ws'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as dns } from 'dns'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

app.use(express.static(path.join(__dirname, '..', 'web')))

const server = http.createServer(app)
const wss = new WebSocketServer({ server })
wss.on('error', (err) => {
	if (err && err.code === 'EADDRINUSE') return
	console.error('WebSocketServer error:', err)
})

// rooms: roomId -> Set of sockets
const rooms = new Map()
// roomId -> { [name: string]: { x:number, y:number } }
const layouts = new Map()
// Default fixed layout (virtual units 725x513)
const DEFAULT_LAYOUT = {
	"Mgh": { x: 0, y: 0 },
	"Matin Bzr": { x: 391, y: 151 },
	"Aref": { x: 151, y: 363 },
	"Sahand": { x: 543, y: 152 },
	"Sina": { x: 0, y: 363 },
	"Pouria": { x: 152, y: 0 },
	"Amirhossein": { x: 543, y: 0 },
	"Matin M.": { x: 473, y: 363 },
	"M.Lashkari": { x: 393, y: 0 },
	"Parsa": { x: 76, y: 212 }
}

function ensureRoom(roomId) {
	if (!rooms.has(roomId)) rooms.set(roomId, new Set())
	return rooms.get(roomId)
}

function broadcast(roomId, data, except) {
	const room = rooms.get(roomId)
	if (!room) return
	for (const ws of room) {
		if (ws !== except && ws.readyState === ws.OPEN) {
			try { ws.send(data) } catch {}
		}
	}
}

function sendToClientId(roomId, targetClientId, data) {
	const room = rooms.get(roomId)
	if (!room) return
	for (const ws of room) {
		if (ws._clientId === targetClientId && ws.readyState === ws.OPEN) {
			try { ws.send(data) } catch {}
			break
		}
	}
}

async function resolveHost(ws, roomId) {
	try {
		const ip = ws?._socket?.remoteAddress
		if (!ip) return
		const hosts = await dns.reverse(ip)
		if (Array.isArray(hosts) && hosts[0]) {
			ws._identity = ws._identity || {}
			ws._identity.host = hosts[0]
			const peers = [...ensureRoom(roomId)].map((s) => s._identity).filter(Boolean)
			broadcast(roomId, JSON.stringify({ type: 'peers', peers }), null)
		}
	} catch {}
}

function ensureLayout(roomId) {
	if (!layouts.has(roomId)) {
		const base = roomId === 'global' ? JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) : {}
		layouts.set(roomId, base)
	}
	return layouts.get(roomId)
}

function normalizeIdentity(identity) {
	if (!identity) return null
	const clientId = String(identity.clientId || '')
	const name = String(identity.name || '').trim()
	const host = String(identity.host || '').trim()
	const mac = String(identity.mac || '')
	const ip = String(identity.ip || '')
	const finalName = name || host || clientId
	return { clientId, name: finalName, mac, ip, host }
}

function safeParse(msg) {
	try { return JSON.parse(msg) } catch { return null }
}

wss.on('connection', (ws) => {
	let roomId = null
	let clientId = null

	ws.on('message', (message) => {
		const data = typeof message === 'string' ? message : message.toString()
		const packet = safeParse(data)
		if (!packet || typeof packet.type !== 'string') return

			switch (packet.type) {
			case 'hello': {
				roomId = 'global'
				clientId = String(packet.clientId || Math.random().toString(36).slice(2))
				const identity = {
					clientId,
					name: String(packet.identity?.name || ''),
					mac: String(packet.identity?.mac || ''),
						ip: ws?._socket?.remoteAddress || '',
					host: ''
				}
					const room = ensureRoom(roomId)
					// ensure single active socket per clientId in this room
					for (const s of [...room]) {
						if (s !== ws && s._clientId === clientId) {
							try { s.close() } catch {}
							room.delete(s)
						}
					}
					room.add(ws)
				ws._clientId = clientId
				ws._identity = identity
				ws.send(JSON.stringify({ type: 'welcome', room: roomId, clientId, identity: normalizeIdentity(identity) }))
				// send current layout to this client
				try { ws.send(JSON.stringify({ type: 'layout', positions: ensureLayout(roomId) })) } catch {}
				const peers = [...room].map((s) => normalizeIdentity(s._identity)).filter(Boolean)
				broadcast(roomId, JSON.stringify({ type: 'peers', peers }), null)
				resolveHost(ws, roomId)
				break
			}
			case 'identify': {
					if (!roomId) return
					const name = typeof packet.identity?.name === 'string' ? packet.identity.name : ''
					const mac = typeof packet.identity?.mac === 'string' ? packet.identity.mac : ''
				ws._identity = { clientId, name, mac, ip: ws?._socket?.remoteAddress || ws._identity?.ip || '', host: ws._identity?.host || '' }
				broadcast(roomId, JSON.stringify({ type: 'peers', peers: [...ensureRoom(roomId)].map(s => normalizeIdentity(s._identity)).filter(Boolean) }), null)
					resolveHost(ws, roomId)
					break
			}
			case 'peers': {
				// client cannot set peers, ignore
				break
			}
			case 'relay': {
				if (!roomId) return
				const to = packet.to ? String(packet.to) : null
				const envelope = { type: 'relay', from: clientId, fromName: (ws._identity && ws._identity.name) || '', to, payload: packet.payload }
				if (to) sendToClientId(roomId, to, JSON.stringify(envelope))
				else broadcast(roomId, JSON.stringify(envelope), ws)
				break
			}
			case 'layout_update': {
				// Layout is fixed; ignore updates from clients
				break
			}
			default: {
				break
			}
		}
	})

	ws.on('close', () => {
		if (!roomId) return
		const room = rooms.get(roomId)
		if (!room) return
		room.delete(ws)
		if (room.size === 0) rooms.delete(roomId)
		else {
			broadcast(roomId, JSON.stringify({ type: 'peer_left', clientId }), null)
			const peers = [...room].map((s) => normalizeIdentity(s._identity)).filter(Boolean)
			broadcast(roomId, JSON.stringify({ type: 'peers', peers }), null)
		}
	})
})

const BASE_PORT = Number(process.env.PORT) || 18080
let attempts = 0
function startListen(port) {
	server.once('error', (err) => {
		if (err && err.code === 'EADDRINUSE' && attempts < 10) {
			attempts++
			const next = port + 1
			console.log(`Port ${port} in use, trying ${next}...`)
			startListen(next)
		} else {
			console.error('Failed to start server:', err)
			process.exit(1)
		}
	})
	server.listen(port, () => {
		console.log(`networkshare listening on http://localhost:${port}`)
	})
}
startListen(BASE_PORT)


