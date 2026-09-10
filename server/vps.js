/**
 * StickerPull VPS bridge (it sends the data to the termux phone hosted database and read them)
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const url = require("url");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = parseInt(process.env.PORT || "6969", 10);
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
if (!BRIDGE_SECRET || BRIDGE_SECRET.length < 16) {
    console.error("[VPS] BRIDGE_SECRET is required.");
    process.exit(1);
}
const MAX_BODY = parseInt(process.env.MAX_BODY);
const BLACKLIST_MS = parseInt(process.env.BLACKLIST_MS);
const RATE_CAPACITY = parseInt(process.env.RATE_CAPACITY);
const RATE_REFILL_PER_SEC = parseFloat(process.env.RATE_REFILL_PER_SEC);
const ABUSE_LIMIT = parseInt(process.env.ABUSE_LIMIT);
const ABUSE_WINDOW_MS = parseInt(process.env.ABUSE_WINDOW_MS);
const WS_MAX_PER_IP = parseInt(process.env.WS_MAX_PER_IP);
const WS_MAX_MSG_BYTES = parseInt(process.env.WS_MAX_MSG_BYTES);
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS);
const GET_DEDUPE_MS = parseInt(process.env.GET_DEDUPE_MS);
// Only enable TRUST_PROXY if your hoster's reverse proxy wipes/sets X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

// ── Header token (anti-tamper) ───────────────────────────────────────
// The plugin sends this header on every request
const HEADER_TOKEN = process.env.HEADER_TOKEN || "sp-v1";

// ── Discord snowflake validation ─────────────────────────────────────
const DISCORD_EPOCH = 1420070400000n; // 2015-01-01

function isValidSnowflake(value) {
    if (value == null) return false;
    const s = String(value).trim();
    if (!/^\d{17,20}$/.test(s)) return false;
    try {
        const ts = Number((BigInt(s) >> 22n) + DISCORD_EPOCH);
        if (ts < Number(DISCORD_EPOCH)) return false;
        if (ts > Date.now() + 3600_000) return false;
        return true;
    } catch {
        return false;
    }
}

// ── Allowed fields (strict whitelist) ────────────────────────────────
const POST_FIELDS = new Set([
    "guild_id", "guildId",
    "channel_id", "channelId",
    "message_id", "messageId",
    "sticker_id", "stickerId",
    "sticker_url", "stickerUrl",
    "owner_id", "ownerId",
    "format_type", "formatType",
    "rel_x", "relX", "x",
    "rel_y", "relY", "y",
    "window_w", "windowW",
    "window_h", "windowH",
    "size",
]);
const PATCH_FIELDS = new Set([
    "rel_x", "relX", "x",
    "rel_y", "relY", "y",
    "owner_id", "ownerId",
    "message_id", "messageId",
    "channel_id", "channelId",
    "guild_id", "guildId",
    "window_w", "windowW",
    "window_h", "windowH",
]);
const GET_PARAMS = new Set(["guildId", "guild_id", "channelId", "channel_id", "messageId", "message_id"]);

function hasUnknownFields(obj, allowed) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return true;
    const keys = Object.keys(obj);
    if (keys.length === 0) return true;
    return keys.some((k) => !allowed.has(k));
}

// ── IP helpers ────────────────────────────────────────────────────────
function clientIp(req) {
    if (TRUST_PROXY) {
        const cf = req.headers["cf-connecting-ip"];
        if (cf) return String(cf).trim();
        const xf = req.headers["x-forwarded-for"];
        if (xf) {
            const first = String(xf).split(",")[0].trim();
            if (first) return first;
        }
    }
    return String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function safeEquals(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ── Rate limiting (token bucket) + abuse blacklist ────────────────────
const blacklist = new Map(); // ip → bannedUntil
const buckets = new Map(); // ip → { tokens, ts }
const abuse = new Map(); // ip → { count, first }
const wsConns = new Map(); // ip → active WS connections

function isBlacklisted(ip) {
    const until = blacklist.get(ip);
    if (until) {
        if (Date.now() < until) return true;
        blacklist.delete(ip);
    }
    return false;
}

function banIp(ip) {
    const until = Date.now() + BLACKLIST_MS;
    blacklist.set(ip, until);
    buckets.delete(ip);
    abuse.delete(ip);
    console.warn(`[VPS] IP blacklisted for ${BLACKLIST_MS / 1000}s: ${ip}`);
}

function tokenBucket(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b) {
        b = { tokens: RATE_CAPACITY, ts: now };
        buckets.set(ip, b);
    }
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + ((now - b.ts) / 1000) * RATE_REFILL_PER_SEC);
    b.ts = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
}

function recordAbuse(ip) {
    const now = Date.now();
    let a = abuse.get(ip);
    if (!a || now - a.first > ABUSE_WINDOW_MS) {
        a = { count: 1, first: now };
        abuse.set(ip, a);
    } else {
        a.count++;
    }
    if (a.count >= ABUSE_LIMIT) banIp(ip);
}

// Clean stale state
setInterval(() => {
    const now = Date.now();
    for (const [ip, until] of blacklist) if (now > until) blacklist.delete(ip);
    for (const [ip, b] of buckets) if (now - b.ts > 600_000) buckets.delete(ip);
    for (const [ip, a] of abuse) if (now - a.first > ABUSE_WINDOW_MS) abuse.delete(ip);
}, 60_000);

// ── Origin check ─────────────────────────────────────────────────────
const DEFAULT_ALLOWED = ["discord.com", "discordapp.com", "discordapp.net"];
function isOriginAllowed(origin) {
    if (!origin) return true; // Electron fetch often omits Origin
    try {
        const host = new URL(origin).hostname;
        if (DEFAULT_ALLOWED.some((d) => host === d || host.endsWith("." + d))) return true;
        const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (extra.some((d) => host === d || host.endsWith("." + d))) return true;
    } catch {}
    return false;
}

// ── Bridge connection (the Termux phone) ─────────────────────────────
let bridge = null;
const pending = new Map();

function isBridgeConnected() {
    return bridge && bridge.ws.readyState === 1;
}

function sendToBridge(msg) {
    if (!isBridgeConnected()) return false;
    bridge.ws.send(JSON.stringify(msg));
    return true;
}

function json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
}

// ── HTTP server (plugin → vps) ─────────────────────────────────────
const httpServer = http.createServer(async (req, res) => {
    const ip = clientIp(req);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-stickerpull");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const parsed = url.parse(req.url, true);

    // Health endpoint (public, light)
    if (parsed.pathname === "/api/health") {
        return json(res, 200, { ok: true, relay: true, bridge: isBridgeConnected(), uptime: process.uptime() | 0 });
    }

    // All /api/... requests must carry the header token
    const headerOk = parsed.pathname.startsWith("/api/") && req.headers["x-stickerpull"] === HEADER_TOKEN;
    if (!headerOk) {
        recordAbuse(ip);
        return json(res, 403, { error: "Missing or invalid x-stickerpull header" });
    }

    // Origin check
    const origin = req.headers.origin || "";
    if (origin && !isOriginAllowed(origin)) {
        recordAbuse(ip);
        return json(res, 403, { error: "Origin not allowed" });
    }

    // Blacklist / token bucket (lenient for normal bursts; no hard bans here)
    if (isBlacklisted(ip)) {
        return json(res, 403, { error: "IP blacklisted" });
    }
    if (!tokenBucket(ip)) {
        res.setHeader("Retry-After", Math.ceil(1000 / RATE_REFILL_PER_SEC));
        return json(res, 429, { error: "Rate limit exceeded. Slow down." });
    }

    // Bridge check
    if (!isBridgeConnected()) {
        return json(res, 502, { error: "Termux server not connected" });
    }

    // Read body with size limit
    const bodyStr = await readBody(req);
    if (bodyStr === null) {
        return json(res, 413, { error: "Payload too large (max 10 KB)" });
    }

    let jsonBody = null;
    if (bodyStr.length > 0) {
        try { jsonBody = JSON.parse(bodyStr); } catch {
            recordAbuse(ip);
            return json(res, 400, { error: "Invalid JSON body" });
        }
    }

    // ── Per-endpoint validation ──
    const method = req.method;
    const path = parsed.pathname;
    const query = parsed.query || {};

    if (method === "POST" && path === "/api/stickers") {
        // Strict whitelist + required sticker data
        if (hasUnknownFields(jsonBody, POST_FIELDS)) {
            recordAbuse(ip);
            return json(res, 400, { error: "Unknown fields in payload" });
        }
        const cid = jsonBody.channel_id ?? jsonBody.channelId;
        const mid = jsonBody.message_id ?? jsonBody.messageId;
        const sid = jsonBody.sticker_id ?? jsonBody.stickerId;
        const oid = jsonBody.owner_id ?? jsonBody.ownerId;
        const rx = jsonBody.rel_x ?? jsonBody.relX ?? jsonBody.x;
        const ry = jsonBody.rel_y ?? jsonBody.relY ?? jsonBody.y;
        if (!isValidSnowflake(cid)) return json(res, 400, { error: "Invalid channel id" });
        // message_id is normally a snowflake, but the plugin falls back to
        // `fallback-<timestamp>` when the DOM lacks a usable message id.
        if (!isValidSnowflake(mid) && !/^fallback-\d+$/.test(String(mid))) {
            return json(res, 400, { error: "Invalid message id" });
        }
        if (sid != null && !isValidSnowflake(sid)) return json(res, 400, { error: "Invalid sticker id" });
        if (oid != null && !isValidSnowflake(oid)) return json(res, 400, { error: "Invalid user id" });
        if (rx == null || ry == null) return json(res, 400, { error: "Missing rel_x or rel_y" });
        if (!jsonBody.sticker_url && !sid) return json(res, 400, { error: "Missing sticker_url or sticker_id" });
        // sticker_url must be a Discord CDN link
        if (jsonBody.sticker_url && !String(jsonBody.sticker_url).includes("stickers/")) {
            return json(res, 400, { error: "sticker_url must be a Discord CDN stickers link" });
        }
        if (jsonBody.size != null) {
            const nsz = Number(jsonBody.size);
            if (!Number.isInteger(nsz) || nsz < 1 || nsz > 120) {
                return json(res, 400, { error: "Sticker size must be between 1 and 120" });
            }
        }
    } else if (method === "PATCH" && /^\/api\/stickers\/\d+$/.test(path)) {
        if (hasUnknownFields(jsonBody, PATCH_FIELDS)) {
            recordAbuse(ip);
            return json(res, 400, { error: "Unknown fields in payload" });
        }
        const oid = jsonBody.owner_id ?? jsonBody.ownerId;
        const mid = jsonBody.message_id ?? jsonBody.messageId;
        const cid = jsonBody.channel_id ?? jsonBody.channelId;
        if (oid != null && !isValidSnowflake(oid)) return json(res, 400, { error: "Invalid user id" });
        if (mid != null && !isValidSnowflake(mid) && !/^fallback-\d+$/.test(String(mid))) {
            return json(res, 400, { error: "Invalid message id" });
        }
        if (cid != null && !isValidSnowflake(cid)) return json(res, 400, { error: "Invalid channel id" });
    } else if (method === "DELETE" && /^\/api\/stickers\/\d+$/.test(path)) {
        const oid = query.ownerId ?? query.owner_id;
        if (oid != null && !isValidSnowflake(oid)) return json(res, 400, { error: "Invalid user id" });
    } else if (method === "GET" && path === "/api/stickers") {
        const qKeys = Object.keys(query);
        if (qKeys.some((k) => !GET_PARAMS.has(k))) {
            recordAbuse(ip);
            return json(res, 400, { error: "Unknown query parameter" });
        }
        if (query.channelId && !isValidSnowflake(query.channelId)) return json(res, 400, { error: "Invalid channel id" });
        if (query.channel_id && !isValidSnowflake(query.channel_id)) return json(res, 400, { error: "Invalid channel id" });
    }

    // Forwards to phone; path already validated to be an actual API route.
    return forwardToPhone(res, method, path, query, jsonBody);
});

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                req.destroy();
                return resolve(null);
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", () => resolve(null));
    });
}

// ── Request forwarding + single-flight GET dedupe ─────────────────────
const getDedupe = new Map(); // flightKey → { timer, responders: Set }

function broadcastFlight(flightKey, status, body) {
    if (!flightKey) return;
    const entry = getDedupe.get(flightKey);
    if (!entry) return;
    clearTimeout(entry.timer);
    getDedupe.delete(flightKey);
    for (const cb of entry.responders) {
        try { cb(status, body); } catch {}
    }
}

function flushDedupeAll(status, body) {
    for (const key of [...getDedupe.keys()]) broadcastFlight(key, status, body);
}

function sendResponse(res, status, respBody) {
    const payload = typeof respBody === "string" ? respBody : JSON.stringify(respBody);
    res.writeHead(status, {
        "Content-Type": typeof respBody === "string" ? "text/plain" : "application/json",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
}

function forwardToPhone(res, method, path, query, jsonBody) {
    let flightKey = null;
    if (method === "GET" && path === "/api/stickers") {
        flightKey = JSON.stringify(query);
        const existing = getDedupe.get(flightKey);
        if (existing) {
            existing.responders.add((status, body) => sendResponse(res, status, body));
            return;
        }
    }

    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
        pending.delete(requestId);
        broadcastFlight(flightKey, 504, { error: "Termux response timeout" });
        sendResponse(res, 504, { error: "Termux response timeout" });
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, {
        resolve: (status, respBody) => {
            clearTimeout(timeout);
            pending.delete(requestId);
            broadcastFlight(flightKey, status, respBody);
            sendResponse(res, status, respBody);
        },
    });

    if (flightKey) {
        getDedupe.set(flightKey, {
            timer: setTimeout(() => getDedupe.delete(flightKey), GET_DEDUPE_MS + REQUEST_TIMEOUT_MS),
            responders: new Set(),
        });
    }

    if (!sendToBridge({ type: "request", id: requestId, method, path, query, body: jsonBody })) {
        clearTimeout(timeout);
        pending.delete(requestId);
        broadcastFlight(flightKey, 502, { error: "Termux disconnected mid-request" });
        return sendResponse(res, 502, { error: "Termux disconnected mid-request" });
    }
}

// ── WebSocket server (phone → vps), SAME port as HTTP ──────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MSG_BYTES });

httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
    });
});

// Heartbeat: detect half-dead mobile connections that stop pong-ing.
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) {
            console.warn("[VPS] Terminating dead bridge connection");
            try { ws.terminate(); } catch {}
            continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    }
}, HEARTBEAT_MS);
heartbeat.unref?.();

wss.on("connection", (ws, req) => {
    const ip = clientIp(req);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    const n = wsConns.get(ip) || 0;
    if (n >= WS_MAX_PER_IP) {
        console.warn(`[VPS] Too many WS connections from ${ip}`);
        ws.close(4004, "Too many connections");
        return;
    }
    wsConns.set(ip, n + 1);
    console.log(`[VPS] WebSocket connection from ${ip} (${n + 1} active)`);

    let authenticated = false;
    const authTimer = setTimeout(() => {
        if (!authenticated) {
            console.log(`[VPS] Auth timeout from ${ip}`);
            ws.close(4001, "Auth timeout");
        }
    }, 10_000);

    ws.on("message", (raw) => {
        if (raw.length > WS_MAX_MSG_BYTES) {
            ws.close(4009, "Message too large");
            return;
        }
        let msg;
        try { msg = JSON.parse(String(raw)); } catch {
            recordAbuse(ip);
            return;
        }

        if (!authenticated) {
            if (msg.type !== "auth") {
                ws.close(4002, "Expected auth message");
                return;
            }
            if (typeof msg.token !== "string" || !safeEquals(msg.token, BRIDGE_SECRET)) {
                console.log(`[VPS] Auth failed from ${ip}`);
                recordAbuse(ip);
                ws.close(4003, "Invalid token");
                return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            if (bridge && bridge.ws !== ws) {
                try { bridge.ws.close(4005, "Replaced by new bridge"); } catch {}
            }
            bridge = { ws, alive: true };
            console.log(`[VPS] Termux bridge authenticated from ${ip}`);
            ws.send(JSON.stringify({ type: "auth_ok" }));
            return;
        }

        if (msg.type === "response" || msg.type === "error") {
            const p = pending.get(msg.id);
            if (p) {
                const status = msg.status || (msg.type === "error" ? 500 : 200);
                p.resolve(status, msg.body || { error: "Empty response" });
            }
        }
    });

    ws.on("close", () => {
        clearTimeout(authTimer);
        wsConns.set(ip, Math.max(0, (wsConns.get(ip) || 1) - 1));
        if ((wsConns.get(ip) || 0) === 0) wsConns.delete(ip);
        if (bridge && bridge.ws === ws) {
            bridge = null;
            console.log("[VPS] Termux bridge disconnected");
        }
        for (const [id, p] of pending) {
            p.resolve(502, { error: "Termux disconnected" });
            pending.delete(id);
        }
        flushDedupeAll(502, { error: "Termux disconnected" });
    });

    ws.on("error", (err) => {
        console.warn("[VPS] WebSocket error:", err.message);
    });
});

// ── Start ────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`[VPS] HTTP + WebSocket listening on port ${PORT}`);
    console.log(`[VPS] Plugin connects here:  http://<this-host>:${PORT}`);
    console.log(`[VPS] Phone connects here:   ws://<this-host>:${PORT}`);
});

process.on("SIGINT", () => {
    console.log("\n[VPS] Shutting down...");
    if (bridge) bridge.ws.close();
    wss.close();
    httpServer.close();
    process.exit(0);
});
