/**
 * StickerPull Phone hosted database for the vps
 */

const WebSocket = require("ws");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const VPS_URL = process.env.VPS_URL;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;
if (!BRIDGE_SECRET || BRIDGE_SECRET.length < 16) {
    console.error("[Phone] BRIDGE_SECRET is required")
    process.exit(1);
}
const MYSQL_URL = process.env.MYSQL_URL;
const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = parseInt(process.env.MYSQL_PORT);
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE;
const RECONNECT_MS = parseInt(process.env.RECONNECT_MS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MySQL setup (mysql2 pool) ────────────────────────────────────────
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
            console.warn(`[Phone] MySQL connection attempt ${attempt}/10 failed: ${e.message}`);
            await sleep(2000);
        }
    }
    if (!connected) {
        console.error(`[Phone] Could not connect to MySQL at ${MYSQL_HOST}:${MYSQL_PORT} (database '${MYSQL_DATABASE}').`);
        console.error("[Phone] Create the database first: CREATE DATABASE IF NOT EXISTS stickers;");
        process.exit(1);
    }

    await migrate();
    console.log("[Phone] MySQL ready");
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
            console.log("[Phone] Migrating DB: adding psid column");
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
            console.log("[Phone] Migrating DB: adding sticker_url column");
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
            console.log("[Phone] Migrating DB: adding owner_id column (existing rows stay public)");
            await pool.query("ALTER TABLE stickers ADD COLUMN owner_id VARCHAR(32)");
        }
        if (!names.has("size")) {
            console.log("[Phone] Migrating DB: adding size column");
            await pool.query("ALTER TABLE stickers ADD COLUMN size INT");
            await pool.query("UPDATE stickers SET size = 88 WHERE size IS NULL");
        }
    } catch (e) {
        console.warn("[Phone] migration check failed", e);
    }

    // MySQL has no CREATE INDEX IF NOT EXISTS — wrap each in its own try
    const indexes = [
        "CREATE INDEX idx_channel ON stickers(channel_id)",
        "CREATE INDEX idx_guild_channel ON stickers(guild_id, channel_id)",
        "CREATE INDEX idx_message ON stickers(message_id)",
        "CREATE INDEX idx_psid ON stickers(channel_id, psid)",
        "CREATE INDEX idx_owner ON stickers(owner_id)",
    ];
    for (const sql of indexes) {
        try { await pool.query(sql); } catch (e) { console.warn("[Phone] index creation failed (non-fatal)", e.message); }
    }
}

// ── DB helper wrappers (mysql2 promise API) ──────────────────────────
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

// ── Request handling (same logic as server.js) ───────────────────────
async function handleRequest(msg, ws) {
    const method = msg.method;
    const path = msg.path;
    const query = msg.query || {};
    const body = msg.body || null;
    const rid = msg.id;
    const send = (status, obj) => {
        try {
            ws.send(JSON.stringify({ type: "response", id: rid, status, body: obj }));
        } catch (e) {
            console.warn("[Phone] send failed:", e.message);
        }
    };

    // health
    if (method === "GET" && path === "/api/health") {
        return send(200, { ok: true, termux: true, db: "mysql", host: MYSQL_HOST, database: MYSQL_DATABASE });
    }

    if (method === "POST" && path === "/api/stickers") {
        const b = body || {};
        const finalGuildId = b.guild_id ?? b.guildId ?? null;
        const finalChannelId = b.channel_id ?? b.channelId;
        const finalMessageId = b.message_id ?? b.messageId;
        let finalStickerId = b.sticker_id ?? b.stickerId ?? null;
        let finalStickerUrl = b.sticker_url ?? b.stickerUrl ?? null;
        const finalOwnerId = b.owner_id ?? b.ownerId ?? null;
        const finalFormatType = b.format_type ?? b.formatType ?? null;
        let finalRelX = b.rel_x ?? b.relX ?? b.x;
        let finalRelY = b.rel_y ?? b.relY ?? b.y;
        const finalWindowW = b.window_w ?? b.windowW ?? null;
        const finalWindowH = b.window_h ?? b.windowH ?? null;

        if (!finalChannelId || !finalMessageId || finalRelX == null || finalRelY == null) {
            return send(400, { error: "Missing required fields: channel_id, message_id, rel_x, rel_y" });
        }
        const finalSize = b.size ?? 88;
        if (!Number.isInteger(Number(finalSize)) || Number(finalSize) < 1 || Number(finalSize) > 120) {
            return send(400, { error: "Sticker size must be between 1 and 120" });
        }
        if (!finalStickerId && !finalStickerUrl) {
            return send(400, { error: "Missing sticker_id or sticker_url" });
        }
        if (!finalStickerUrl && finalStickerId) {
            finalStickerUrl = `https://cdn.discordapp.com/stickers/${finalStickerId}.png?size=160&lossless=true`;
            if (finalFormatType === 4) finalStickerUrl = `https://media.discordapp.net/stickers/${finalStickerId}.gif?size=160&lossless=true`;
        }
        if (!finalStickerId && finalStickerUrl) {
            const m = String(finalStickerUrl).match(/\/stickers\/(\d+)\./);
            if (m) finalStickerId = m[1];
            else return send(400, { error: "sticker_url must be a Discord CDN stickers link" });
        }
        finalRelX = Math.max(0, Math.min(1, Number(finalRelX)));
        finalRelY = Math.max(-5, Math.min(20, Number(finalRelY)));

        try {
            const row = await get(`SELECT COALESCE(MAX(psid),0) as maxPsid FROM stickers WHERE channel_id = ?`, [String(finalChannelId)]);
            const psid = ((row && row.maxPsid) || 0) + 1;
            const result = await run(
                `INSERT INTO stickers (psid, guild_id, channel_id, message_id, sticker_id, sticker_url, owner_id, format_type, rel_x, rel_y, window_w, window_h, size)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [psid, finalGuildId, String(finalChannelId), String(finalMessageId), finalStickerId ? String(finalStickerId) : null, finalStickerUrl ? String(finalStickerUrl) : null, finalOwnerId ? String(finalOwnerId) : null, finalFormatType, finalRelX, finalRelY, finalWindowW, finalWindowH, Number(finalSize)]
            );
            const id = result.lastInsertRowid;
            const row2 = await get(`SELECT * FROM stickers WHERE id = ?`, [id]);
            send(201, row2);
        } catch (e) {
            console.error("[Phone] POST /api/stickers error", e);
            send(500, { error: String(e.message || e) });
        }
        return;
    }

    if (method === "GET" && path === "/api/stickers") {
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
            send(200, rows);
        } catch (e) {
            console.error("[Phone] GET /api/stickers error", e);
            send(500, { error: String(e.message || e) });
        }
        return;
    }

    const idMatch = path.match(/^\/api\/stickers\/(\d+)$/);

    if (method === "GET" && idMatch) {
        try {
            const row = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!row) return send(404, { error: "Not found" });
            send(200, row);
        } catch (e) {
            send(500, { error: String(e.message || e) });
        }
        return;
    }

    if (method === "PATCH" && idMatch) {
        const b = body || {};
        const existing = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
        if (!existing) return send(404, { error: "Not found" });
        const requesterOwner = b.owner_id ?? b.ownerId ?? null;
        if (existing.owner_id && requesterOwner && String(existing.owner_id) !== String(requesterOwner)) {
            return send(403, { error: "Only the owner can move this sticker" });
        }
        const newRelX = b.rel_x ?? b.relX ?? b.x;
        const newRelY = b.rel_y ?? b.relY ?? b.y;
        const newWindowW = b.window_w ?? b.windowW;
        const newWindowH = b.window_h ?? b.windowH;
        const newMessageId = b.message_id ?? b.messageId;
        const newChannelId = b.channel_id ?? b.channelId;
        const newGuildId = b.guild_id ?? b.guildId;

        if (newRelX == null && newRelY == null && newMessageId == null && newChannelId == null && newGuildId == null && newWindowW == null && newWindowH == null) {
            return send(400, { error: "Nothing to update" });
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
        if (!updates.length) return send(400, { error: "No valid fields" });

        params.push(idMatch[1]);
        try {
            const result = await run(`UPDATE stickers SET ${updates.join(", ")} WHERE id = ?`, params);
            if (!result.changes) return send(404, { error: "Not found" });
            const row = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            send(200, row);
        } catch (e) {
            send(500, { error: String(e.message || e) });
        }
        return;
    }

    if (method === "DELETE" && idMatch) {
        const requesterOwner = query.ownerId ?? query.owner_id ?? body?.ownerId ?? body?.owner_id ?? null;
        try {
            const existing = await get(`SELECT * FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!existing) return send(404, { error: "Not found" });
            if (existing.owner_id && requesterOwner && String(existing.owner_id) !== String(requesterOwner)) {
                return send(403, { error: "Only the owner can delete this sticker" });
            }
            const result = await run(`DELETE FROM stickers WHERE id = ?`, [idMatch[1]]);
            if (!result.changes) return send(404, { error: "Not found" });
            send(200, { ok: true, id: idMatch[1] });
        } catch (e) {
            send(500, { error: String(e.message || e) });
        }
        return;
    }

    send(404, { error: "Not found" });
}

// ── WebSocket connection to the vps ────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connect() {
    if (ws) { try { ws.close(); } catch {} }

    console.log(`[Phone] Connecting to ${VPS_URL} ...`);
    ws = new WebSocket(VPS_URL);

    ws.on("open", () => {
        console.log("[Phone] Connected, authenticating...");
        ws.send(JSON.stringify({ type: "auth", token: BRIDGE_SECRET }));
    });

    ws.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }

        if (msg.type === "auth_ok") {
            console.log("[Phone] Authenticated. Serving requests through vps.");
            return;
        }

        if (msg.type === "request") {
            handleRequest(msg, ws);
        }
    });

    ws.on("close", (code, reason) => {
        console.log(`[Phone] Disconnected (code=${code}). Reconnecting in ${RECONNECT_MS}ms...`);
        scheduleReconnect();
    });

    ws.on("error", (err) => {
        console.warn("[Phone] WebSocket error:", err.message);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, RECONNECT_MS);
}

process.on("SIGINT", () => {
    console.log("\n[Phone] Shutting down...");
    if (ws) ws.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (pool) pool.end();
    process.exit(0);
});

// ── Start ────────────────────────────────────────────────────────────
console.log("[Phone] StickerPull Termux Phone Server");
console.log(`[Phone] vps: ${VPS_URL}`);
console.log(`[Phone] MySQL: ${MYSQL_USER}@${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DATABASE}`);
initDb()
    .then(connect)
    .catch((e) => {
        console.error("[Phone] DB init failed:", e.message);
        process.exit(1);
    });