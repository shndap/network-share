const $ = (q) => document.querySelector(q);
const roomInput = null;
const joinBtn = null;
const nameInput = $("#name");
const saveIdentBtn = $("#saveIdent");
const incoming = $("#incoming");
const roomMap = document.querySelector("#roomMap");
const lockLayout = document.querySelector("#lockLayout");

let ws = null;
let clientId = null;
let roomId = "global";
let identity = { name: "", mac: "" };
let peers = [];
let nameCache = {};
const HARDCODED = [
  "Sahand",
  "Amirhossein",
  "M.Lashkari",
  "Matin Bzr",
  "Matin M.",
  "Aref",
  "Sina",
  "Pouria",
  "Parsa",
  "Mgh",
];
const ROOM_W = 725;
const ROOM_H = 513;
const DESK_W = 150;
const DESK_H = 150;

const CHUNK_SIZE = 256 * 1024;

function connect() {
  if (ws)
    try {
      ws.close();
    } catch {}
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${scheme}://${location.host}`);
  ws.addEventListener("open", () => {
    let savedClientId = "";
    try {
      savedClientId = localStorage.getItem("clientId") || "";
    } catch {}
    const hello = { type: "hello", room: roomId, identity };
    if (savedClientId) hello.clientId = savedClientId;
    ws.send(JSON.stringify(hello));
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    try {
      if (msg && msg.type) console.log("ws message:", msg.type, msg);
    } catch {}
    switch (msg.type) {
      case "welcome": {
        clientId = msg.clientId;
        try {
          localStorage.setItem("clientId", clientId);
        } catch {}
        if (msg.identity && typeof msg.identity.name === "string") {
          identity.name = msg.identity.name;
          if (nameInput) nameInput.value = identity.name;
        }
        rememberName(clientId, identity.name);
        upsertSelfInPeers();
        break;
      }
      case "peers":
        peers = normalizePeers(msg.peers);
        renderPeers();
        break;
      case "layout":
        applyLayout(msg.positions || {});
        break;
      case "layout_update":
        applyLayoutUpdate(msg.name, msg.x, msg.y);
        break;
      case "peer_left":
        peers = peers.filter((p) => p.clientId !== msg.clientId);
        renderPeers();
        break;
      case "relay":
        onRelay(msg.payload, msg.from, msg.fromName || "");
        break;
    }
  });
}

function readableSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0,
    n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

// removed old outgoing list UI

function onRelay(packet, from, fromName) {
  if (!packet) return;
  try {
    console.log("relay payload:", packet, "from:", from, "fromName:", fromName);
  } catch {}
  if (packet.kind === "text") {
    const sender = peers.find((p) => p.clientId === from);
    const fallbackName = sender && sender.name && sender.name.trim() ? sender.name.trim() : shortId(from);
    const senderName = fromName && fromName.trim() ? fromName.trim() : fallbackName;
    const li = document.createElement("li");
    li.className = "item";
    li.innerHTML = `<div>
        <div class="name">Text</div>
        <div class="meta">From: ${escapeHtml(senderName)}</div>
        <div class="text-body">${escapeHtml(String(packet.content || ""))}</div>
      </div>
      <div class="actions"><button class="copy">Copy</button></div>`;
    li.querySelector(".copy").onclick = () => {
      try { navigator.clipboard.writeText(String(packet.content || "")); } catch {}
    };
    incoming.prepend(li);
    return;
  }
  if (packet.kind === "file" && packet.phase === "offer") {
    const { transferId, name, size, mime } = packet;
    const sender = peers.find((p) => p.clientId === from);
    const fallbackName =
      sender && sender.name && sender.name.trim()
        ? sender.name.trim()
        : shortId(from);
    const senderName =
      fromName && fromName.trim() ? fromName.trim() : fallbackName;
    const li = document.createElement("li");
    li.className = "item";
    li.dataset.transferId = transferId;
    li.innerHTML = `<div>
            <div class="name">${escapeHtml(name)}</div>
            <div class="meta">From: ${escapeHtml(senderName)} — ${readableSize(
      size
    )} — ${mime || "application/octet-stream"}</div>
			<div class="progress"><div class="bar"></div></div>
		</div>
		<div class="actions"><button class="accept">Accept</button></div>`;
    const bar = li.querySelector(".bar");
    const accept = () => {
      ws.send(
        JSON.stringify({
          type: "relay",
          to: from,
          payload: { kind: "file", phase: "accept", transferId },
        })
      );
      li.querySelector(".actions").textContent = "Receiving...";
    };
    li.querySelector(".accept").onclick = accept;
    incoming.prepend(li);
    // auto-accept to ensure incoming always progresses
    accept();
  } else if (packet.kind === "file" && packet.phase === "chunk") {
    let li = incoming.querySelector(
      `li[data-transfer-id="${packet.transferId}"]`
    );
    if (!li) {
      li = document.createElement("li");
      li.className = "item";
      li.dataset.transferId = packet.transferId;
      li.innerHTML = `<div>
				<div class="name">${packet.name || "Incoming file"}</div>
				<div class="meta">${readableSize(packet.size || 0)} — ${
        packet.mime || "application/octet-stream"
      }</div>
				<div class="progress"><div class="bar"></div></div>
			</div>
			<div class="actions"></div>`;
      incoming.prepend(li);
    }
    let state = li._state;
    if (!state) {
      state = li._state = {
        chunks: [],
        received: 0,
        name: packet.name,
        size: packet.size,
        mime: packet.mime,
      };
    }
    state.chunks.push(new Uint8Array(packet.data));
    state.received += packet.data.length;
    const bar = li.querySelector(".bar");
    bar.style.width = `${Math.round((state.received / state.size) * 100)}%`;
  } else if (packet.kind === "file" && packet.phase === "complete") {
    const li = incoming.querySelector(
      `li[data-transfer-id="${packet.transferId}"]`
    );
    if (!li || !li._state) return;
    const { chunks, name, mime, size } = li._state;
    const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    li._url = url;
    const actions = li.querySelector(".actions");
    actions.innerHTML = "";
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open";
    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.download = name;
    downloadLink.className = "download";
    downloadLink.setAttribute("aria-label", "Download");
    downloadLink.title = "Download";
    downloadLink.innerHTML = `
			<svg class="download-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
				<path d="M12 3a1 1 0 0 1 1 1v8.586l2.293-2.293a1 1 0 1 1 1.414 1.414l-4.007 4.007a1.25 1.25 0 0 1-1.768 0L6.925 11.707a1 1 0 0 1 1.414-1.414L10.5 12.454V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"/>
			</svg>
		`;
    const cleanup = () => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
      if (li._state) {
        li._state.chunks = [];
        li._state.received = size;
      }
      li.remove();
    };
    openBtn.onclick = () => {
      const w = window.open(url, "_blank", "noopener");
      if (!w) alert("Popup blocked. Allow popups to open files.");
      cleanup();
    };
    actions.appendChild(openBtn);
    actions.appendChild(downloadLink);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 5 * 60 * 1000);
  }
}

async function sendFile(file, bar, to) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return alert("Not connected");
  try {
    const fromName =
      identity.name && identity.name.trim()
        ? identity.name.trim()
        : shortId(clientId);
    let toName = "everyone";
    if (to) {
      const target = peers.find((p) => p.clientId === to);
      toName =
        target && target.name && target.name.trim()
          ? target.name.trim()
          : shortId(to);
    }
    console.log(`sending ${file.name} from ${fromName} to ${toName}`);
  } catch {}
  const transferId = Math.random().toString(36).slice(2);
  ws.send(
    JSON.stringify({
      type: "relay",
      to: to || null,
      payload: {
        kind: "file",
        phase: "offer",
        transferId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      },
    })
  );
  const accepted = await waitForAccept(transferId, to);
  if (!accepted) return;
  const reader = file.stream().getReader();
  let sent = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    ws.send(
      JSON.stringify({
        type: "relay",
        to: to || null,
        payload: {
          kind: "file",
          phase: "chunk",
          transferId,
          data: Array.from(value),
          size: file.size,
          name: file.name,
          mime: file.type || "application/octet-stream",
        },
      })
    );
    sent += value.length;
    if (bar) bar.style.width = `${Math.round((sent / file.size) * 100)}%`;
  }
  ws.send(
    JSON.stringify({
      type: "relay",
      to: to || null,
      payload: { kind: "file", phase: "complete", transferId },
    })
  );
}

function waitForAccept(transferId, to) {
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (
          msg.type === "relay" &&
          (!to || msg.from === to) &&
          msg.payload &&
          msg.payload.kind === "file" &&
          msg.payload.phase === "accept" &&
          msg.payload.transferId === transferId
        ) {
          ws.removeEventListener("message", onMsg);
          resolve(true);
        }
      } catch {}
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => {
      ws.removeEventListener("message", onMsg);
      resolve(false);
    }, 30000);
  });
}

function renderPeers() {
  if (roomMap) renderRoomMap();
}

function renderRoomMap() {
  roomMap.innerHTML =
    '<div class="drop-hint">Drop files here to send to all</div>';
  if (lockLayout) roomMap.classList.toggle("locked", !!lockLayout.checked);
  const saved = loadPositionsByName();
  const usedClientIds = new Set();
  for (const name of HARDCODED) {
    const peer = peers.find(
      (p) => (p.name || "").trim() === name && !usedClientIds.has(p.clientId)
    );
    const chip = document.createElement("div");
    const online = !!peer;
    chip.className =
      "desk" +
      (peer && peer.clientId === clientId ? " self" : "") +
      (online ? " online" : "");
    chip.dataset.name = name;
    chip.dataset.clientId = online
      ? (usedClientIds.add(peer.clientId), peer.clientId)
      : "";
    chip.style.width = (DESK_W / ROOM_W) * 100 + "%";
    chip.style.height = (DESK_H / ROOM_H) * 100 + "%";
    const label = document.createElement("div");
    label.className = "label";
    label.innerHTML = `${name}<span class="sub">${
      online ? shortId(peer.clientId) : "offline"
    }</span>`;
    chip.appendChild(label);
    const pos = saved[name];
    if (pos) {
      chip.style.left = (pos.x / ROOM_W) * 100 + "%";
      chip.style.top = (pos.y / ROOM_H) * 100 + "%";
    } else {
      chip.style.left =
        ((Math.random() * (ROOM_W - DESK_W)) / ROOM_W) * 100 + "%";
      chip.style.top =
        ((Math.random() * (ROOM_H - DESK_H)) / ROOM_H) * 100 + "%";
    }
    chip.ondragover = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chip.classList.add("dragover");
    };
    chip.ondragleave = (e) => {
      e.stopPropagation();
      chip.classList.remove("dragover");
    };
    chip.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      chip.classList.remove("dragover");
      const to = chip.dataset.clientId || null;
      if (!to) return;
      chip.classList.add("flash");
      setTimeout(() => chip.classList.remove("flash"), 600);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) sendFiles(Array.from(files), to);
    // text to single recipient
    const dt = e.dataTransfer;
    try {
      const txt = dt && typeof dt.getData === "function" ? dt.getData("text") : "";
      if (txt && txt.trim()) sendText(txt, to);
    } catch {}
    const items = e.dataTransfer && e.dataTransfer.items;
    if (items) {
      for (const it of items) {
        if (it.kind === "string") {
          it.getAsString((s) => {
            if (s && s.trim()) sendText(s, to);
          });
        }
      }
    }
    };
    roomMap.appendChild(chip);
  }

  const guestPeers = peers.filter((p) => !usedClientIds.has(p.clientId));
  for (const g of guestPeers) {
    const circle = document.createElement("div");
    circle.className = "guest online";
    circle.style.width = ((DESK_W * 0.6) / ROOM_W) * 100 + "%";
    circle.style.height = ((DESK_W * 0.6) / ROOM_W) * 100 + "%";
    const label = document.createElement("div");
    label.className = "label";
    const nm = g.name && g.name.trim() ? g.name.trim() : "Guest";
    label.innerHTML = `${nm}<span class="sub">${shortId(g.clientId)}</span>`;
    circle.appendChild(label);
    let tries = 50;
    while (tries-- > 0) {
      const x = Math.random() * (ROOM_W - DESK_W);
      const y = Math.random() * (ROOM_H - DESK_H);
      const rect = { x, y, w: DESK_W, h: DESK_H };
      const overlaps = usedClientIds.has(g.clientId);
      if (!overlaps) {
        circle.style.left = (x / ROOM_W) * 100 + "%";
        circle.style.top = (y / ROOM_H) * 100 + "%";
        usedClientIds.add(g.clientId);
        break;
      }
    }
    roomMap.appendChild(circle);
  }

  roomMap.ondragover = (e) => {
    e.preventDefault();
    roomMap.classList.add("dragover");
    roomMap.classList.add("broadcast");
  };
  roomMap.ondragleave = () => {
    roomMap.classList.remove("dragover");
    roomMap.classList.remove("broadcast");
  };
  roomMap.ondrop = (e) => {
    e.preventDefault();
    roomMap.classList.remove("dragover");
    roomMap.classList.add("flash");
    setTimeout(() => roomMap.classList.remove("flash"), 600);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) sendFiles(Array.from(files), null);
    // text broadcast
    const dt = e.dataTransfer;
    try {
      const txt = dt && typeof dt.getData === "function" ? dt.getData("text") : "";
      if (txt && txt.trim()) sendText(txt, null);
    } catch {}
    const items = e.dataTransfer && e.dataTransfer.items;
    if (items) {
      for (const it of items) {
        if (it.kind === "string") {
          it.getAsString((s) => {
            if (s && s.trim()) sendText(s, null);
          });
        }
      }
    }
  };
}

function makeDraggable(el) {
  let isDown = false;
  let startX = 0,
    startY = 0,
    baseLeft = 0,
    baseTop = 0;
  el.addEventListener("mousedown", (e) => {
    if (lockLayout && lockLayout.checked) return;
    isDown = true;
    startX = e.clientX;
    startY = e.clientY;
    baseLeft = el.offsetLeft;
    baseTop = el.offsetTop;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp, { once: true });
  });
  function onMove(e) {
    if (true) return;
    if (!isDown) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const nx = baseLeft + dx;
    const ny = baseTop + dy;
    const maxX = roomMap.clientWidth - el.clientWidth;
    const maxY = roomMap.clientHeight - el.clientHeight;
    el.style.left = Math.max(0, Math.min(nx, maxX)) + "px";
    el.style.top = Math.max(0, Math.min(ny, maxY)) + "px";
  }
  function onUp() {
    if (true) return;
    isDown = false;
    document.removeEventListener("mousemove", onMove);
    savePositionByName(el);
  }
  // support file dropping directly on a chip to target send
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("dragover");
  });
  el.addEventListener("dragleave", () => el.classList.remove("dragover"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    sendFiles(Array.from(files), el.dataset.clientId || null);
  });
}

function savePositionByName(el) {
  const rect = roomMap.getBoundingClientRect();
  const xPx = el.offsetLeft;
  const yPx = el.offsetTop;
  const x = Math.round((xPx / rect.width) * ROOM_W);
  const y = Math.round((yPx / rect.height) * ROOM_H);
  const positions = loadPositionsByName();
  positions[el.dataset.name] = { x, y };
  try {
    localStorage.setItem("positionsByName", JSON.stringify(positions));
  } catch {}
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log("sending layout_update", el.dataset.name, x, y);
      ws.send(
        JSON.stringify({ type: "layout_update", name: el.dataset.name, x, y })
      );
    }
  } catch {}
}

function loadPositionsByName() {
  try {
    return JSON.parse(localStorage.getItem("positionsByName") || "{}");
  } catch {
    return {};
  }
}

function applyLayout(positions) {
  try {
    localStorage.setItem("positionsByName", JSON.stringify(positions || {}));
  } catch {}
  console.log("apply layout", positions);
  renderPeers();
}

function applyLayoutUpdate(name, x, y) {
  if (!name || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const positions = loadPositionsByName();
  positions[name] = { x, y };
  try {
    localStorage.setItem("positionsByName", JSON.stringify(positions));
  } catch {}
  console.log("apply layout_update", name, x, y);
  // live update existing desk without full re-render
  const desk =
    roomMap && roomMap.querySelector(`.desk[data-name="${CSS.escape(name)}"]`);
  if (desk) {
    desk.style.left = (x / ROOM_W) * 100 + "%";
    desk.style.top = (y / ROOM_H) * 100 + "%";
  } else {
    renderPeers();
  }
  // Guests: peers whose names are not in HARDCODED
  const guestPeers = peers.filter((p) => !usedClientIds.has(p.clientId));
  const usedRects = HARDCODED.map((n) => saved[n]).filter(Boolean);
  console.log("guestPeers", guestPeers);
  for (const g of guestPeers) {
    const circle = document.createElement("div");
    circle.className = "guest online";
    circle.style.width = ((DESK_W * 0.1) / ROOM_W) * 100 + "%";
    circle.style.height = ((DESK_W * 0.1) / ROOM_W) * 100 + "%";
    const label = document.createElement("div");
    label.className = "label";
    const nm = g.name && g.name.trim() ? g.name.trim() : shortId(g.clientId);
    label.innerHTML = `${nm}<span class="sub">${shortId(g.clientId)}</span>`;
    circle.appendChild(label);
    // find a random non-overlapping spot
    let tries = 50;
    while (tries-- > 0) {
      const x = Math.random() * (ROOM_W - DESK_W);
      const y = Math.random() * (ROOM_H - DESK_H);
      const rect = { x, y, w: DESK_W, h: DESK_H };
      const overlaps = usedRects.some(
        (r) =>
          r &&
          Math.abs(r.x + DESK_W / 2 - (x + DESK_W / 2)) < DESK_W &&
          Math.abs(r.y + DESK_H / 2 - (y + DESK_H / 2)) < DESK_H
      );
      if (!overlaps) {
        circle.style.left = (x / ROOM_W) * 100 + "%";
        circle.style.top = (y / ROOM_H) * 100 + "%";
        usedRects.push({ x, y });
        break;
      }
    }
    roomMap.appendChild(circle);
  }
}

if (lockLayout) lockLayout.addEventListener("change", () => renderRoomMap());

async function sendFiles(files, toClientId) {
  for (const f of files) await sendFile(f, null, toClientId);
}

function sendText(text, to) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const clean = toPlainText(String(text || ''))
  if (!clean) return
  try {
    const fromName = identity.name && identity.name.trim() ? identity.name.trim() : shortId(clientId);
    const toName = to ? (peers.find(p => p.clientId === to)?.name || shortId(to)) : 'everyone';
    console.log(`sending text from ${fromName} to ${toName}:`, clean.slice(0, 80));
  } catch {}
  ws.send(JSON.stringify({ type: 'relay', to: to || null, payload: { kind: 'text', content: clean } }))
}

function toPlainText(s) {
  try {
    // Prefer text/plain; if HTML-ish, strip tags safely
    if (/<[a-z][\s\S]*>/i.test(s)) {
      const parser = new DOMParser()
      const doc = parser.parseFromString(s, 'text/html')
      const t = doc?.body?.textContent || ''
      return t.replace(/\u00A0/g, ' ').trim()
    }
    return s.replace(/\u00A0/g, ' ').trim()
  } catch { return String(s || '').trim() }
}

function normalizePeers(list) {
  if (!Array.isArray(list)) return [];
  const normalized = list
    .map((p) => {
      if (!p) return null;
      if (typeof p === "string")
        return { clientId: p, name: "", mac: "", ip: "" };
      return {
        clientId: p.clientId || "",
        name: typeof p.name === "string" ? p.name : "",
        mac: typeof p.mac === "string" ? p.mac : "",
        ip: typeof p.ip === "string" ? p.ip : "",
        host: typeof p.host === "string" ? p.host : "",
      };
    })
    .filter(Boolean);
  const deduped = dedupeByClientId(normalized);
  for (const p of deduped) {
    if (p.name && p.name.trim()) rememberName(p.clientId, p.name.trim());
    else if (nameCache[p.clientId]) p.name = nameCache[p.clientId];
  }
  return deduped;
}

function dedupeByClientId(list) {
  const map = new Map();
  for (const p of list) {
    if (!p.clientId) continue;
    const existing = map.get(p.clientId);
    if (!existing) {
      map.set(p.clientId, p);
      continue;
    }
    const score = (x) =>
      (x.name && x.name.trim() ? 2 : 0) + (x.host && x.host.trim() ? 1 : 0);
    if (score(p) >= score(existing)) map.set(p.clientId, { ...existing, ...p });
  }
  return Array.from(map.values());
}

function displayName(p) {
  console.log(p);
  const nm =
    p && typeof p.name === "string" && p.name.trim() ? p.name.trim() : "";
  const id = p && typeof p.clientId === "string" ? p.clientId : "";
  const host =
    p && typeof p.host === "string" && p.host.trim() ? p.host.trim() : "";
  return nm || host || shortId(id);
}

function shortId(id) {
  if (!id) return "(unknown)";
  return id.slice(0, 6);
}

function rememberName(id, name) {
  if (!id || !name || !name.trim()) return;
  nameCache[id] = name.trim();
  try {
    localStorage.setItem("nameCache", JSON.stringify(nameCache));
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        c
      ])
  );
}

// removed old global dropzone and file picker

// no room; auto-connect on load

if (window.localStorage) {
  try {
    const saved = JSON.parse(localStorage.getItem("identity") || "{}");
    if (saved && (saved.name || saved.mac)) {
      identity = { name: saved.name || "", mac: saved.mac || "" };
      if (nameInput) nameInput.value = identity.name;
    }
    const savedNames = JSON.parse(localStorage.getItem("nameCache") || "{}");
    if (savedNames && typeof savedNames === "object") nameCache = savedNames;
  } catch {}
}

if (saveIdentBtn)
  saveIdentBtn.addEventListener("click", () => {
    identity = { name: nameInput?.value?.trim() || "", mac: "" };
    try {
      localStorage.setItem("identity", JSON.stringify(identity));
    } catch {}
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "identify", identity }));
      rememberName(clientId, identity.name);
      upsertSelfInPeers();
    } else {
      connect();
    }
  });

function upsertSelfInPeers() {
  if (!clientId) return;
  let found = false;
  peers = (peers || []).map((p) => {
    if (p && p.clientId === clientId) {
      found = true;
      return {
        ...p,
        name: identity.name || p.name,
        mac: identity.mac || p.mac,
      };
    }
    return p;
  });
  if (!found)
    peers.push({
      clientId,
      name: identity.name || "",
      mac: identity.mac || "",
      ip: "",
      host: "",
    });
  renderPeers();
}

// removed defaultReceiver logic

connect();
