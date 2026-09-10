import { StickersStore } from "@webpack/common";

export type SavedSticker = {
    id?: number;
    psid?: number;
    guild_id: string | null;
    channel_id: string;
    message_id: string;
    sticker_id?: string;
    sticker_url?: string;
    owner_id?: string | null;
    format_type?: number;
    rel_x: number;
    rel_y: number;
    size?: number;
    window_w: number;
    window_h: number;
};

export const SERVER_URL = "http://147.135.213.131:20297";

const nativeHttp = (window as any).VencordNative?.pluginHelpers?.StickerPull?.httpFetch as
    | ((opts: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
          Promise<{ status: number; body: string; error?: string }>)
    | undefined;

function toResponse(native: { status: number; body: string; error?: string }): Response {
    const ok = native.status >= 200 && native.status < 300;
    return {
        ok,
        status: native.status || 0,
        headers: new Headers(),
        json: async () => { try { return JSON.parse(native.body); } catch { return {}; } },
        text: async () => native.body,
    } as unknown as Response;
}

export async function checkHealth(): Promise<{ ok: boolean; relay: boolean; bridge: boolean; db?: string; host?: string; database?: string } | null> {
    try {
        const r = await doFetch(`${SERVER_URL}/api/health`);
        if (!r.ok) return null;
        const d = await r.json();
        return { ok: !!d.ok, relay: !!d.relay, bridge: !!d.bridge, db: d.db, host: d.host, database: d.database };
    } catch {
        return null;
    }
}

async function doFetch(url: string, opts: RequestInit = {}): Promise<Response> {
    const headers = new Headers(opts.headers || {});
    
    
    headers.set("x-stickerpull", "sp-v1");
    if (opts.body) headers.set("Content-Type", headers.get("Content-Type") || "application/json");

    
    
    
    if (nativeHttp) {
        try {
            const res = await nativeHttp({
                method: (opts.method || "GET").toUpperCase(),
                url,
                headers: Object.fromEntries(headers.entries()),
                body: typeof opts.body === "string" ? opts.body : undefined,
            });
            return toResponse(res);
        } catch {  }
    }

    return fetch(url, { ...opts, headers, mode: "cors", credentials: "omit" });
}

export async function createSticker(data: SavedSticker): Promise<SavedSticker | null> {
    try {
        const r = await doFetch(`${SERVER_URL}/api/stickers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

export async function updateSticker(id: number, patch: Partial<SavedSticker>): Promise<SavedSticker | null> {
    try {
        const r = await doFetch(`${SERVER_URL}/api/stickers/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

export async function deleteSticker(id: number, ownerId?: string | null): Promise<boolean> {
    try {
        const u = new URL(`${SERVER_URL}/api/stickers/${id}`);
        if (ownerId) u.searchParams.set("ownerId", ownerId);
        const r = await doFetch(u.toString(), { method: "DELETE" });
        return r.ok;
    } catch {
        return false;
    }
}

export async function fetchStickers(guildId: string | null, channelId: string): Promise<SavedSticker[]> {
    try {
        const u = new URL(`${SERVER_URL}/api/stickers`);
        if (guildId) u.searchParams.set("guildId", guildId);
        u.searchParams.set("channelId", channelId);
        const r = await doFetch(u.toString());
        if (!r.ok) throw new Error(`Failed to fetch stickers (HTTP ${r.status})`);
        const d = await r.json();
        return Array.isArray(d) ? d : [];
    } catch {
        throw new Error("Failed to fetch stickers");
    }
}

export function cdnUrl(id: string, fmt?: number): string {
    const cdn = (window as any).GLOBAL_ENV?.CDN_HOST || "cdn.discordapp.com";
    const proxy = (window as any).GLOBAL_ENV?.MEDIA_PROXY_ENDPOINT || `//${cdn}`;
    if (fmt === 4) return `https:${proxy}/stickers/${id}.gif?size=160&lossless=true`;
    return `https://${cdn}/stickers/${id}.png?size=160&lossless=true`;
}

export function extractSticker(el: HTMLElement): { id: string; url: string; format_type?: number } | null {
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.body) {
        const id = cur.dataset?.id;
        const tp = cur.dataset?.type;
        if (id && tp === "sticker") {
            const s = StickersStore.getStickerById(id);
            let url = "";
            const imgEl = cur.querySelector("img") as HTMLImageElement | null;
            const canvasEl = cur.querySelector("canvas") as HTMLCanvasElement | null;
            if (imgEl?.src) url = imgEl.src;
            else if (canvasEl) url = cdnUrl(id, s?.format_type);
            else url = cdnUrl(id, s?.format_type);
            if (s) return { id: s.id, url, format_type: s.format_type };
            if (/^\d{17,20}$/.test(id)) return { id, url: url || cdnUrl(id, 1), format_type: 1 };
        }
        cur = cur.parentElement;
    }
    const img = el.querySelector("img") as HTMLImageElement | null || (el as unknown as HTMLImageElement);
    const src = (img as any)?.src || "";
    const m = src.match(/\/stickers\/(\d+)\./);
    if (m) {
        const s = StickersStore.getStickerById(m[1]);
        return s ? { id: s.id, url: src, format_type: s.format_type } : { id: m[1], url: src, format_type: 1 };
    }
    const canvas = el.querySelector("canvas") as HTMLCanvasElement | null;
    if (canvas) {
        const dId = canvas.dataset?.id || el.dataset?.id;
        if (dId && /^\d{17,20}$/.test(dId)) {
            const s = StickersStore.getStickerById(dId);
            return { id: dId, url: cdnUrl(dId, s?.format_type), format_type: s?.format_type };
        }
    }
    return null;
}
