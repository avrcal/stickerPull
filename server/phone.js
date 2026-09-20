/**
 * StickerPull server (termux + vps)
 */

const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");
const { spawn } = require("child_process");
const mysql = require("mysql2/promise");
const tar = require("tar");
const { Client } = require("ssh2");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ── Config ─────────────────────────────────────────────────────────────
const MYSQL_URL = process.env.MYSQL_URL || null;
const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT || "8008", 10);
const MYSQL_USER = process.env.MYSQL_USER || "root";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "";
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || "stickers";

const VPS_HOST = process.env.VPS_HOST || "";
const VPS_USER = process.env.VPS_USER || "ubuntu";
const VPS_SSH_PORT = parseInt(process.env.VPS_SSH_PORT || "22", 10);
const VPS_SSH_KEY = process.env.VPS_SSH_KEY || "";
const VPS_SSH_PASSPHRASE = process.env.VPS_SSH_KEY_PASSPHRASE || undefined;

const FRP_VERSION = process.env.FRP_VERSION || "0.61.1";
const FRP_PHONE_ARCH = process.env.FRP_PHONE_ARCH || phoneArch();
const FRP_SERVER_PORT = parseInt(process.env.FRP_SERVER_PORT || "7000", 10);
const FRP_LOCAL_PORT = parseInt(process.env.FRP_LOCAL_PORT || "18080", 10);
const FRP_REMOTE_PORT = parseInt(process.env.FRP_REMOTE_PORT || "20297", 10);

const MAX_BODY = parseInt(process.env.MAX_BODY || "10240", 10);
const RATE_CAPACITY = parseInt(process.env.RATE_CAPACITY || "400", 10);
const RATE_REFILL_PER_SEC = parseFloat(process.env.RATE_REFILL_PER_SEC || "4");
const ABUSE_LIMIT = parseInt(process.env.ABUSE_LIMIT || "25", 10);
const ABUSE_WINDOW_MS = parseInt(process.env.ABUSE_WINDOW_MS || "30000", 10);
const BLACKLIST_MS = parseInt(process.env.BLACKLIST_MS || "600000", 10);
const GET_DEDUPE_MS = parseInt(process.env.GET_DEDUPE_MS || "1500", 10);
const HEADER_TOKEN = process.env.HEADER_TOKEN || "sp-v1";

let FRP_TOKEN = process.env.FRP_TOKEN || "";
if (!FRP_TOKEN) {
    FRP_TOKEN = crypto.randomBytes(24).toString("hex");
    try { fs.appendFileSync(path.join(__dirname, ".env"), `\nFRP_TOKEN=${FRP_TOKEN}\n`); }
    catch {}
    console.log("[termux] Generated a new FRP_TOKEN and saved it to termux/.env");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function phoneArch() {
    const map = { arm64: "arm64", x64: "amd64", arm: "armv7", ia32: "386" };
    return map[process.arch] || process.arch;
}

// ── MySQL setup (mysql2 pool) ──────────────────────────────────────────
let pool;

async function initDb() {
    pool = MYSQL_URL
        ? mysql.createPool(MYSQL_URL)
        : mysql.createPool({
              host: MYSQL_HOST,
              port: MYSQL_PORT,
              user: MYSQL_USER,
              password: MYSQL_PASSWORD,
              database: MYSQL_DATABASE,
              connectionLimit: 10,
              waitForConnections: true,
              queueLimit: 100,
          });

    let connected = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
        try {
            const conn = await pool.getConnection();
            await conn.query("SELECT 1");
            conn.release();
            connected = true;
            break;
        } catch (e) {
            console.warn(`[termux] MySQL connection attempt ${attempt}/10 failed: ${e.message}`);
            await sleep(2000);
        }
    }
    if (!connected) {
        console.error(`[termux] Could not connect to MySQL at ${MYSQL_HOST}:${MYSQL_PORT} (database '${MYSQL_DATABASE}').`);
        console.error("[termux] Create the database first: CREATE DATABASE IF NOT EXISTS stickers;");
        process.exit(1);
    }

    await migrate();
    console.log("[termux] MySQL ready");
}

async function migrate() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS stickers (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            psid INT,
            guild_id VARCHAR(32),
            channel_id VARCHAR(32) NOT NULL,
            message_id VARCHAR(64) NOT NULL,
            sticker_id VARCHAR(32),
            sticker_url VARCHAR(512),
            owner_id VARCHAR(32),
            format_type INT,
            rel_x DOUBLE NOT NULL,
            rel_y DOUBLE NOT NULL,
            window_w INT,
            window_h INT,
            size INT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
    `);

    try {
        const [cols] = await pool.query(
            `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stickers'`
        );
        const names = new Set(cols.map((c) => c.name));

        if (!names.has("psid")) {
            console.log("[termux] Migrating DB: adding psid column");
            await pool.query("ALTER TABLE stickers ADD COLUMN psid INT");
            const [chs] = await pool.query("SELECT DISTINCT channel_id FROM stickers");
            for (const ch of chs) {
                const [rows] = await pool.query("SELECT id FROM stickers WHERE channel_id = ? ORDER BY id", [ch.channel_id]);
                for (let i = 0; i < rows.length; i++) {
                    await pool.query("UPDATE stickers SET psid = ? WHERE id = ?", [i + 1, rows[i].id]);
                }
            }
        }
        if (!names.has("sticker_url")) {
            console.log("[termux] Migrating DB: adding sticker_url column");
            await pool.query("ALTER TABLE stickers ADD COLUMN sticker_url VARCHAR(512)");
            const [rows] = await pool.query("SELECT id, sticker_id, format_type FROM stickers WHERE sticker_url IS NULL OR sticker_url = ''");
            for (const r of rows) {
                if (!r.sticker_id) continue;
                let url = `https://cdn.discordapp.com/stickers/${r.sticker_id}.png?size=160&lossless=true`;
                if (r.format_type === 4) url = `https://media.discordapp.net/stickers/${r.sticker_id}.gif?size=160&lossless=true`;
                try { await pool.query("UPDATE stickers SET sticker_url = ? WHERE id = ?", [url, r.id]); } catch {}
            }
        }
        if (!names.has("owner_id")) {
            console.log("[termux] Migrating DB: adding owner_id column (existing rows stay public)");
            await pool.query("ALTER TABLE stickers ADD COLUMN owner_id VARCHAR(32)");
        }
        if (!names.has("size")) {
            console.log("[termux] Migrating DB: adding size column");
            await pool.query("ALTER TABLE stickers ADD COLUMN size INT");
            await pool.query("UPDATE stickers SET size = 88 WHERE size IS NULL");
        }
    } catch (e) {
        console.warn("[termux] migration check failed", e);
    }

    const indexes = [
        "CREATE INDEX idx_channel ON stickers(channel_id)",
        "CREATE INDEX idx_guild_channel ON stickers(guild_id, channel_id)",
        "CREATE INDEX idx_message ON stickers(message_id)",
        "CREATE INDEX idx_psid ON stickers(channel_id, psid)",
        "CREATE INDEX idx_owner ON stickers(owner_id)",
    ];
    for (const sql of indexes) {
        try { await pool.query(sql); } catch (e) { console.warn("[termux] index creation failed (non-fatal)", e.message); }
    }
}

// ── DB helper wrappers ─────────────────────────────────────────────────
async function run(sql, params = []) {
    const [result] = await pool.execute(sql, params);
    return { lastInsertRowid: result.insertId, changes: result.affectedRows };
}

async function all(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows;
}

async function get(sql, params = []) {
    const [rows] = await pool.execute(sql, params);
    return rows[0] || null;
}

// ── Protections (ported from the old relay.js) ─────────────────────────
const DISCORD_EPOCH = 1420070400000n;

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

const DEFAULT_ALLOWED = ["discord.com", "discordapp.com", "discordapp.net"];
function isOriginAllowed(origin) {
    if (!origin) return true;
    try {
        const host = new url.URL(origin).hostname;
        if (DEFAULT_ALLOWED.some((d) => host === d || host.endsWith("." + d))) return true;
    } catch {}
    return false;
}

const blacklist = new Map();
const buckets = new Map();
const abuse = new Map();

function isBlacklisted(ip) {
    const until = blacklist.get(ip);
    if (until) {
        if (Date.now() < until) return true;
        blacklist.delete(ip);
    }
    return false;
}

function banIp(ip) {
    blacklist.set(ip, Date.now() + BLACKLIST_MS);
    buckets.delete(ip);
    abuse.delete(ip);
    console.warn(`[termux] IP blacklisted for ${BLACKLIST_MS / 1000}s: ${ip}`);
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

setInterval(() => {
    const now = Date.now();
    for (const [ip, until] of blacklist) if (now > until) blacklist.delete(ip);
    for (const [ip, b] of buckets) if (now - b.ts > 600_000) buckets.delete(ip);
    for (const [ip, a] of abuse) if (now - a.first > ABUSE_WINDOW_MS) abuse.delete(ip);
}, 60_000);

// GET single-flight dedupe (N viewers of one channel → 1 DB query)
const getDedupe = new Map();

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

// ── HTTP helpers ───────────────────────────────────────────────────────
function json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(obj));
}

function allJson(res, status, bodyStr, contentType) {
    res.writeHead(status, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" });
    res.end(bodyStr);
}

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

// ── Core request handling (the API) ────────────────────────────────────
async function handleApi(method, pathName, query, body) {
    // health (public, light)
    if (method === "GET" && pathName === "/api/health") {
        return {
            status: 200,
            contentType: "application/json",
            body: {
                ok: true,
                termux: true,
                relay: true,
                bridge: true,
                db: "mysql",
                host: MYSQL_HOST,
                database: MYSQL_DATABASE,
                tunnel: "frp",
                vps: VPS_HOST,
                uptime: process.uptime() | 0,
            },
        };
    }

    if (method === "POST" && pathName === "/api/stickers") {
        const b = body || {};
        if (hasUnknownFields(b, POST_FIELDS)) return { status: 400, body: { error: "Unknown fields in payload" } };
        const cid = b.channel_id ?? b.channelId;
        const mid = b.message_id ?? b.messageId;
        const sid = b.sticker_id ?? b.stickerId;
        const oid = b.owner_id ?? b.ownerId;
        const rx = b.rel_x ?? b.relX ?? b.x;
        const ry = b.rel_y ?? b.relY ?? b.y;
        if (!isValidSnowflake(cid)) return { status: 400, body: { error: "Invalid channel id" } };
        if (!isValidSnowflake(mid) && !/^fallback-\d+$/.test(String(mid))) return { status: 400, body: { error: "Invalid message id" } };
        if (sid != null && !isValidSnowflake(sid)) return { status: 400, body: { error: "Invalid sticker id" } };
        if (oid != null && !isValidSnowflake(oid)) return { status: 400, body: { error: "Invalid user id" } };
        if (rx == null || ry == null) return { status: 400, body: { error: "Missing rel_x or rel_y" } };
        if (!b.sticker_url && !sid) return { status: 400, body: { error: "Missing sticker_url or sticker_id" } };
        if (b.sticker_url && !String(b.sticker_url).includes("stickers/")) return { status: 400, body: { error: "sticker_url must be a Discord CDN stickers link" } };
        if (b.size != null) {
            const nsz = Number(b.size);
            if (!Number.isInteger(nsz) || nsz < 1 || nsz > 120) return { status: 400, body: { error: "Sticker size must be between 1 and 120" } };
        }

        let finalStickerUrl = b.sticker_url ?? null;
        if (!finalStickerUrl && sid) {
            finalStickerUrl = `https://cdn.discordapp.com/stickers/${sid}.png?size=160&lossless=true`;
            if (b.format_type === 4) finalStickerUrl = `https://media.discordapp.net/stickers/${sid}.gif?size=160&lossless=true`;
        }
        const finalRelX = Math.max(0, Math.min(1, Number(rx)));
        const finalRelY = Math.max(-5, Math.min(20, Number(ry)));

        try {
            const row = await get(`SELECT COALESCE(MAX(psid),0) as maxPsid FROM stickers WHERE channel_id = ?`, [String(cid)]);
            const psid = ((row && row.maxPsid) || 0) + 1;
            const result = await run(
                `INSERT INTO stickers (psid, guild_id, channel_id, message_id, sticker_id, sticker_url, owner_id, format_type, rel_x, rel_y, window_w, window_h, size)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [psid, b.guild_id ?? b.guildId ?? null, String(cid), String(mid), sid ? String(sid) : null, finalStickerUrl, oid ? String(oid) : null, b.format_type ?? null, finalRelX, finalRelY, b.window_w ?? null, b.window_h ?? null, Number(b.size ?? 88)]
            );
            const id = result.lastInsertRowid;
            const row2 = await get(`SELECT * FROM stickers WHERE id = ?`, [id]);
            return { status: 201, body: row2 };
        } catch (e) {
            console.error("[termux] POST /api/stickers error", e);
            return { status: 500, body: { error: String(e.message || e) } };
        }
    }

    if (method === "GET" && pathName === "/api/stickers") {
        const gId = query.guild_id ?? query.guildId;
        const cId = query.channel_id ?? query.channelId;
        const mId = query.message_id ?? query.messageId;
        let sql = "SELECT * FROM stickers WHERE 1=1";
        const params = [];
        if (gId) {
            if (String(gId).toLowerCase() === "dm" || String(gId).toLowerCase() === "null") sql += " AND guild_id IS NULL";
            else { sql += " AND guild_id = ?"; params.push(String(gId)); }
        }
        if (cId) { sql += " AND channel_id = ?"; params.push(String(cId)); }
        if (mId) { sql += " AND message_id = ?"; params.push(String(mId)); }
        sql += " ORDER BY created_at ASC";
        try {
            const rows = await all(sql, params);
            return { status: 200, body: rows };
        } catch (e) {
            console.error("[termux] GET /api/stickers error", e);
            return { status: 500, body: { error: String(e.message || e) } };
        }
    }

    const idMatch = pathName.match(/^\/api\/stickers\/(\d+)$/);

    if (method === "GET" && idMatch) {
        try {
            const row = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!row) return { status: 404, body: { error: "Not found" } };
            return { status: 200, body: row };
        } catch (e) {
            return { status: 500, body: { error: String(e.message || e) } };
        }
    }

    if (method === "PATCH" && idMatch) {
        const b = body || {};
        if (hasUnknownFields(b, PATCH_FIELDS)) return { status: 400, body: { error: "Unknown fields in payload" } };
        const oid = b.owner_id ?? b.ownerId;
        const mid = b.message_id ?? b.messageId;
        const cid = b.channel_id ?? b.channelId;
        if (oid != null && !isValidSnowflake(oid)) return { status: 400, body: { error: "Invalid user id" } };
        if (mid != null && !isValidSnowflake(mid) && !/^fallback-\d+$/.test(String(mid))) return { status: 400, body: { error: "Invalid message id" } };
        if (cid != null && !isValidSnowflake(cid)) return { status: 400, body: { error: "Invalid channel id" } };
        try {
            const existing = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!existing) return { status: 404, body: { error: "Not found" } };
            if (existing.owner_id && oid && String(existing.owner_id) !== String(oid)) {
                return { status: 403, body: { error: "Only the owner can move this sticker" } };
            }
            const newRelX = b.rel_x ?? b.relX ?? b.x;
            const newRelY = b.rel_y ?? b.relY ?? b.y;
            const newWindowW = b.window_w ?? b.windowW;
            const newWindowH = b.window_h ?? b.windowH;
            const newMessageId = b.message_id ?? b.messageId;
            const newChannelId = b.channel_id ?? b.channelId;
            const newGuildId = b.guild_id ?? b.guildId;

            if (newRelX == null && newRelY == null && newMessageId == null && newChannelId == null && newGuildId == null && newWindowW == null && newWindowH == null) {
                return { status: 400, body: { error: "Nothing to update" } };
            }
            const updates = [];
            const params = [];
            if (newRelX != null) { updates.push("rel_x = ?"); params.push(Math.max(0, Math.min(1, Number(newRelX)))); }
            if (newRelY != null) { updates.push("rel_y = ?"); params.push(Math.max(-5, Math.min(20, Number(newRelY)))); }
            if (newWindowW != null) { updates.push("window_w = ?"); params.push(Number(newWindowW)); }
            if (newWindowH != null) { updates.push("window_h = ?"); params.push(Number(newWindowH)); }
            if (newMessageId != null) { updates.push("message_id = ?"); params.push(String(newMessageId)); }
            if (newChannelId != null) { updates.push("channel_id = ?"); params.push(String(newChannelId)); }
            if (newGuildId !== undefined) { updates.push("guild_id = ?"); params.push(newGuildId ? String(newGuildId) : null); }
            if (!updates.length) return { status: 400, body: { error: "No valid fields" } };

            params.push(idMatch[1]);
            const result = await run(`UPDATE stickers SET ${updates.join(", ")} WHERE id = ?`, params);
            if (!result.changes) return { status: 404, body: { error: "Not found" } };
            const row = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            return { status: 200, body: row };
        } catch (e) {
            return { status: 500, body: { error: String(e.message || e) } };
        }
    }

    if (method === "DELETE" && idMatch) {
        const oid = query.ownerId ?? query.owner_id;
        if (oid != null && !isValidSnowflake(oid)) return { status: 400, body: { error: "Invalid user id" } };
        try {
            const existing = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!existing) return { status: 404, body: { error: "Not found" } };
            if (existing.owner_id && oid && String(existing.owner_id) !== String(oid)) {
                return { status: 403, body: { error: "Only the owner can delete this sticker" } };
            }
            const result = await run(`DELETE FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!result.changes) return { status: 404, body: { error: "Not found" } };
            return { status: 200, body: { ok: true, id: idMatch[1] } };
        } catch (e) {
            return { status: 500, body: { error: String(e.message || e) } };
        }
    }

    return { status: 404, body: { error: "Not found" } };
}

// ── HTTP server (binds to 127.0.0.1 only — frpc tunnels it out) ────────
function startHttpServer() {
    const server = http.createServer(async (req, res) => {
        const ip = String(req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");

        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-stickerpull");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            return res.end();
        }

        const parsed = url.parse(req.url, true);

        if (parsed.pathname === "/api/health") {
            const r = await handleApi("GET", parsed.pathname, {}, null);
            return json(res, r.status, r.body);
        }

        const headerOk = parsed.pathname.startsWith("/api/") && req.headers["x-stickerpull"] === HEADER_TOKEN;
        if (!headerOk) {
            recordAbuse(ip);
            return json(res, 403, { error: "Missing or invalid x-stickerpull header" });
        }

        const origin = req.headers.origin || "";
        if (origin && !isOriginAllowed(origin)) {
            recordAbuse(ip);
            return json(res, 403, { error: "Origin not allowed" });
        }

        if (isBlacklisted(ip)) return json(res, 403, { error: "IP blacklisted" });
        if (!tokenBucket(ip)) {
            res.setHeader("Retry-After", Math.ceil(1000 / RATE_REFILL_PER_SEC));
            return json(res, 429, { error: "Rate limit exceeded. Slow down." });
        }

        const bodyStr = await readBody(req);
        if (bodyStr === null) return json(res, 413, { error: "Payload too large (max 10 KB)" });

        let jsonBody = null;
        if (bodyStr.length > 0) {
            try { jsonBody = JSON.parse(bodyStr); } catch {
                recordAbuse(ip);
                return json(res, 400, { error: "Invalid JSON body" });
            }
        }

        const method = req.method;
        const pathName = parsed.pathname;
        const query = parsed.query || {};

        if (method === "GET" && pathName === "/api/stickers") {
            const qKeys = Object.keys(query);
            if (qKeys.some((k) => !GET_PARAMS.has(k))) {
                recordAbuse(ip);
                return json(res, 400, { error: "Unknown query parameter" });
            }
            if (query.channelId && !isValidSnowflake(query.channelId)) return json(res, 400, { error: "Invalid channel id" });
            if (query.channel_id && !isValidSnowflake(query.channel_id)) return json(res, 400, { error: "Invalid channel id" });

            const flightKey = JSON.stringify(query);
            const existing = getDedupe.get(flightKey);
            if (existing) {
                existing.responders.add((status, bodyObj) => json(res, status, bodyObj));
                return;
            }
            getDedupe.set(flightKey, {
                timer: setTimeout(() => getDedupe.delete(flightKey), GET_DEDUPE_MS),
                responders: new Set(),
            });
            try {
                const r = await handleApi(method, pathName, query, jsonBody);
                broadcastFlight(flightKey, r.status, r.body);
                return json(res, r.status, r.body);
            } catch (e) {
                broadcastFlight(flightKey, 500, { error: String(e.message || e) });
                return json(res, 500, { error: String(e.message || e) });
            }
        }

        if (method === "DELETE" && /^\/api\/stickers\/\d+$/.test(pathName)) {
            const oid = query.ownerId ?? query.owner_id;
            if (oid != null && !isValidSnowflake(oid)) return json(res, 400, { error: "Invalid user id" });
        }

        try {
            const r = await handleApi(method, pathName, query, jsonBody);
            return json(res, r.status, r.body);
        } catch (e) {
            console.error("[termux] request error", e);
            return json(res, 500, { error: String(e.message || e) });
        }
    });

    server.listen(FRP_LOCAL_PORT, "127.0.0.1", () => {
        console.log(`[termux] HTTP API listening on 127.0.0.1:${FRP_LOCAL_PORT}`);
    });

    server.on("error", (e) => {
        console.error("[termux] HTTP server error", e.message);
    });

    return server;
}

// ── SSH helpers (auto-deploy + supervise frps on the VPS) ──────────────
function connectSsh() {
    if (!VPS_SSH_KEY) {
        throw new Error(`VPS_SSH_KEY is not set. Add it to termux/.env, e.g. VPS_SSH_KEY=/data/data/com.termux/files/home/.ssh/id_rsa`);
    }
    return new Promise((resolve, reject) => {
        const conn = new Client();
        conn.on("ready", () => resolve(conn));
        conn.on("error", reject);
        conn.connect({
            host: VPS_HOST,
            port: VPS_SSH_PORT,
            username: VPS_USER,
            privateKey: fs.readFileSync(VPS_SSH_KEY, "utf8"),
            passphrase: VPS_SSH_PASSPHRASE,
            readyTimeout: 15000,
            hostVerifier: () => true,
        });
    });
}

function sshExec(conn, command, timeout = 60000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("ssh command timed out")), timeout);
        conn.exec(command, (err, stream) => {
            if (err) {
                clearTimeout(t);
                return reject(err);
            }
            let out = "";
            let errOut = "";
            stream.on("close", (code) => {
                clearTimeout(t);
                resolve({ code, out, errOut });
            });
            stream.on("data", (d) => (out += d));
            stream.stderr.on("data", (d) => (errOut += d));
        });
    });
}

function sshPut(conn, remotePath, content) {
    return new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            sftp.writeFile(remotePath, Buffer.from(content), (err2) => {
                if (err2) return reject(err2);
                resolve();
            });
        });
    });
}

async function withSsh(fn) {
    const conn = await connectSsh();
    try {
        return await fn(conn);
    } finally {
        conn.end();
    }
}

function releaseUrl(arch) {
    return `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${arch}.tar.gz`;
}

// Arch: remote uname -m → frp suffix
function vpsArchFromUname(uname) {
    const m = String(uname).trim().toLowerCase();
    if (m.includes("aarch64") || m.includes("arm64")) return "arm64";
    if (m.includes("x86_64") || m.includes("amd64")) return "amd64";
    if (m.includes("armv7")) return "armv7";
    if (m.includes("i686") || m.includes("i386")) return "386";
    return "amd64";
}

async function deployFrps() {
    console.log(`[termux] Deploying frps on ${VPS_USER}@${VPS_HOST}:${VPS_SSH_PORT} ...`);
    let conn = await connectSsh();
    try {
        const uname = await sshExec(conn, "uname -m");
        const arch = vpsArchFromUname(uname.out);
        console.log(`[termux] VPS arch: ${uname.out.trim() || "?"} → frp suffix '${arch}'`);

        // Download + extract frps when missing (frps.toml is written separately)
        const setup = [
            `mkdir -p $HOME/frp && cd $HOME/frp`,
            `if [ ! -x ./frps ]; then`,
            `  curl -fsSL -o frp.tgz ${releaseUrl(arch)} && tar -xzf frp.tgz`,
            `  cp frp_${FRP_VERSION}_linux_${arch}/frps ./frps && chmod +x ./frps`,
            `  rm -rf frp.tgz frp_${FRP_VERSION}_linux_${arch}`,
            `fi`,
            `./frps -v`,
        ].join("\n");
        const dl = await sshExec(conn, setup, 180000);
        if (dl.code !== 0) {
            console.error("[termux] frps download on VPS failed:", dl.errOut.trim() || dl.out.trim());
            throw new Error("frps download failed on the VPS");
        }
        console.log("[termux] frps binary ready on VPS:", (dl.out || "").trim());

        // Resolve the real home dir (SFTP does not expand $HOME, nor does frps in its toml)
        const home = (await sshExec(conn, "echo $HOME")).out.trim() || `/home/${VPS_USER}`;
        const frpDir = `${home}/frp`;

        // Write frps.toml
        const frpsToml = [
            `bindAddr = "0.0.0.0"`,
            `bindPort = ${FRP_SERVER_PORT}`,
            `auth.method = "token"`,
            `auth.token = "${FRP_TOKEN}"`,
            `log.to = "${frpDir}/frps.log"`,
            `log.level = "info"`,
            `log.maxDays = 3`,
            `[[allowPorts]]`,
            `start = ${FRP_REMOTE_PORT}`,
            `end = ${FRP_REMOTE_PORT}`,
            ``,
        ].join("\n");
        await sshPut(conn, `${frpDir}/frps.toml`, frpsToml);

        // Start (or restart) frps daemonized
        const startCmd = [
            `cd $HOME/frp`,
            `if pgrep -x frps >/dev/null 2>&1; then`,
            `  echo already-running`,
            `else`,
            `  setsid nohup ./frps -c frps.toml >>frps.log 2>&1 &`,
            `  sleep 2`,
            `  pgrep -x frps >/dev/null 2>&1 && echo started || echo failed`,
            `fi`,
        ].join("\n");
        const st = await sshExec(conn, startCmd, 30000);
        console.log("[termux] frps start:", (st.out || "").trim(), st.errOut ? "stderr: " + st.errOut.trim() : "");
        if (!/started|already-running/.test(st.out || "")) {
            console.error("[termux] frps did not start. Check " + VPS_HOST + ":$HOME/frp/frps.log and open ports in the Oracle Cloud Security List (TCP " + FRP_SERVER_PORT + " and " + FRP_REMOTE_PORT + ").");
        }
    } finally {
        conn.end();
    }
}

// ── frpc (runs on this phone) ──────────────────────────────────────────
const frpDir = path.join(__dirname, "frp");
const frpcBin = path.join(frpDir, "frpc");
const frpcCfg = path.join(frpDir, "frpc.toml");

function download(url2, dest) {
    return new Promise((resolve, reject) => {
        const doGet = (u, redirects) => {
            const req = https.get(u, { headers: { "User-Agent": "stickerpull" } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
                    res.resume();
                    return doGet(new url.URL(res.headers.location, u).toString(), redirects + 1);
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`download failed: HTTP ${res.statusCode} ${u}`));
                    return;
                }
                const f = fs.createWriteStream(dest);
                res.pipe(f);
                f.on("finish", () => f.close(resolve));
                f.on("error", reject);
            });
            req.on("error", reject);
            req.setTimeout(120000, () => req.destroy(new Error("download timeout")));
        };
        doGet(url2, 0);
    });
}

async function ensureFrpcBinary() {
    fs.mkdirSync(frpDir, { recursive: true });
    if (fs.existsSync(frpcBin)) {
        try {
            const v = require("child_process").execFileSync(frpcBin, ["-v"], { timeout: 5000 }).toString().trim();
            console.log("[termux] frpc already installed:", v.replace("frp ", "frp v").split("\n")[0]);
            return;
        } catch {
            console.log("[termux] frpc binary present but not runnable — reinstalling");
            fs.rmSync(frpcBin, { force: true });
        }
    }
    console.log(`[termux] Downloading frpc ${FRP_VERSION} (linux_${FRP_PHONE_ARCH}) ...`);
    const tarball = path.join(frpDir, "frp.tgz");
    await download(releaseUrl(FRP_PHONE_ARCH), tarball);
    await tar.x({ file: tarball, cwd: frpDir });
    fs.rmSync(tarball, { force: true });
    const extracted = path.join(frpDir, `frp_${FRP_VERSION}_linux_${FRP_PHONE_ARCH}`);
    fs.copyFileSync(path.join(extracted, "frpc"), frpcBin);
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.chmodSync(frpcBin, 0o755);
    console.log("[termux] frpc installed at", frpcBin);
}

function writeFrpcConfig() {
    const cfg = [
        `serverAddr = "${VPS_HOST}"`,
        `serverPort = ${FRP_SERVER_PORT}`,
        `auth.method = "token"`,
        `auth.token = "${FRP_TOKEN}"`,
        `log.to = "${frpDir}/frpc.log"`,
        `log.level = "info"`,
        `log.maxDays = 3`,
        ``,
        `[[proxies]]`,
        `name = "stickers"`,
        `type = "tcp"`,
        `localIP = "127.0.0.1"`,
        `localPort = ${FRP_LOCAL_PORT}`,
        `remotePort = ${FRP_REMOTE_PORT}`,
        ``,
    ].join("\n");
    fs.writeFileSync(frpcCfg, cfg);
    console.log(`[termux] frpc config written (${VPS_HOST}:${FRP_SERVER_PORT} → 127.0.0.1:${FRP_LOCAL_PORT}, public ${VPS_HOST}:${FRP_REMOTE_PORT})`);
}

let frpcProc = null;
let frpcRestartTimer = null;
let shuttingDown = false;

function startFrpc() {
    if (shuttingDown) return;
    if (frpcProc) { try { frpcProc.kill(); } catch {} }
    frpcProc = spawn(frpcBin, ["-c", frpcCfg], { stdio: "ignore", detached: false });
    console.log(`[termux] frpc spawned (pid ${frpcProc.pid})`);
    frpcProc.on("exit", (code, signal) => {
        console.log(`[termux] frpc exited (code=${code}, signal=${signal}). Restarting in 5s...`);
        frpcProc = null;
        if (shuttingDown) return;
        if (frpcRestartTimer) clearTimeout(frpcRestartTimer);
        frpcRestartTimer = setTimeout(() => {
            frpcRestartTimer = null;
            if (!shuttingDown) startFrpc();
        }, 5000);
    });
    frpcProc.on("error", (e) => {
        console.warn("[termux] frpc process error:", e.message);
        frpcProc = null;
    });
    return frpcProc;
}

// ── Supervision ────────────────────────────────────────────────────────
function tcpCheck(host, port, timeout = 5000) {
    return new Promise((resolve) => {
        const s = net.connect({ host, port });
        const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
        s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
        s.on("error", () => { clearTimeout(t); s.destroy(); resolve(false); });
    });
}

let lastRedeployAt = 0;
const REDEPLOY_COOLDOWN = 60000;
let lastSupervisorState = "";

async function supervise() {
    if (shuttingDown) return;

    const controlUp = await tcpCheck(VPS_HOST, FRP_SERVER_PORT);
    const tunnelUp = await tcpCheck(VPS_HOST, FRP_REMOTE_PORT);
    const state = `frps:${FRP_SERVER_PORT}=${controlUp ? "up" : "down"} tunnel:${FRP_REMOTE_PORT}=${tunnelUp ? "up" : "down"}`;
    if (state !== lastSupervisorState) {
        lastSupervisorState = state;
        console.log(`[termux] supervisor: ${state}`);
    }

    const frpcAlive = frpcProc && frpcProc.exitCode === null;

    if (!controlUp) {
        const now = Date.now();
        if (now - lastRedeployAt > REDEPLOY_COOLDOWN) {
            lastRedeployAt = now;
            console.log("[termux] frps control port unreachable — redeploying frps via SSH...");
            try { await deployFrps(); } catch (e) { console.warn("[termux] frps redeploy failed:", e.message); }
        }
    } else if (!tunnelUp && !frpcAlive) {
        console.log("[termux] tunnel down and frpc not running — starting frpc");
        startFrpc();
    } else if (!tunnelUp && frpcAlive) {
        console.log("[termux] tunnel down but frpc is running — forcing frpc reconnect");
        startFrpc();
    }
}

// ── Start ──────────────────────────────────────────────────────────────
let httpServer = null;

async function main() {
    console.log("[termux] StickerPull Termux Server (frp edition)");
    console.log(`[termux] VPS: ${VPS_HOST} (user ${VPS_USER}, ssh :${VPS_SSH_PORT})`);
    console.log(`[termux] Tunnel: public ${VPS_HOST}:${FRP_REMOTE_PORT} → 127.0.0.1:${FRP_LOCAL_PORT}`);
    console.log(`[termux] MySQL: ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`);
    console.log(`[termux] Plugin should point at http://${VPS_HOST}:${FRP_REMOTE_PORT}`);

    await initDb();
    httpServer = startHttpServer();

    if (!VPS_SSH_KEY) {
        console.error("[termux] Aborting frp setup: set VPS_SSH_KEY in termux/.env (path to your private key).");
    } else {
        try { await deployFrps(); } catch (e) { console.warn("[termux] Initial frps deploy failed:", e.message); }
        try { await ensureFrpcBinary(); } catch (e) { console.error("[termux] frpc binary install failed:", e.message); process.exit(1); }
        writeFrpcConfig();
        startFrpc();
    }

    if (VPS_SSH_KEY) {
        setInterval(supervise, 15000);
        supervise();
    }
}

function shutdown() {
    console.log("\n[termux] Shutting down...");
    shuttingDown = true;
    if (frpcRestartTimer) clearTimeout(frpcRestartTimer);
    if (frpcProc) { try { frpcProc.kill(); } catch {} }
    if (httpServer) httpServer.close();
    if (pool) pool.end();
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
    console.error("[termux] Fatal:", e.message || e);
    process.exit(1);
});