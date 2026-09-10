import { SelectedChannelStore, SelectedGuildStore, UserStore } from "@webpack/common";

export const ZONE_SIZE = 15;

export function getCurrentUserId(): string | null {
    try {
        const id = (UserStore as any)?.getCurrentUser?.()?.id;
        return id ? String(id) : null;
    } catch {
        return null;
    }
}

export function isOwnedByMe(ownerId?: string | null): boolean {
    
    if (!ownerId) return true;
    const me = getCurrentUserId();
    
    if (!me) return false;
    return String(ownerId) === String(me);
}

export function getIds() {
    try {
        const g = (SelectedGuildStore as any)?.getGuildId?.() ?? null;
        const c = (SelectedChannelStore as any)?.getChannelId?.() ?? null;
        if (c) return { guildId: g as string | null, channelId: c as string };
    } catch {}
    const m = location.pathname.match(/\/channels\/(\d+|@me)\/(\d+)/);
    if (m) return { guildId: m[1] === "@me" ? null : m[1], channelId: m[2] };
    return { guildId: null as string | null, channelId: null as string | null };
}

export function lastMessages(): HTMLElement[] {
    const all = Array.from(document.querySelectorAll<HTMLElement>('li[id^="chat-messages-"]'));
    const fallback = all.length
        ? all
        : Array.from(document.querySelectorAll<HTMLElement>('ol[data-list-id="chat-messages"] li'));
    return fallback.filter(e => e.getBoundingClientRect().height > 4).slice(-ZONE_SIZE);
}

export function findMsg(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (el) {
        for (const sel of ['[id^="chat-messages-"]', '[data-list-item-id^="chat-messages"]']) {
            const c = el.closest(sel) as HTMLElement | null;
            if (c) {
                const m = c.closest('[id^="chat-messages-"]') as HTMLElement | null;
                if (m) return m;
                if (c.id?.startsWith("chat-messages-")) return c;
            }
        }
    }
    const msgs = lastMessages();
    for (const m of msgs) {
        const r = m.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return m;
    }
    let best: HTMLElement | null = null,
        d0 = Infinity;
    for (const m of msgs) {
        const r = m.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - y);
        if (d < d0) {
            d0 = d;
            best = m;
        }
    }
    return best && d0 < 150 ? best : null;
}

export function parseMsgId(el: HTMLElement): { channelId: string; messageId: string } | null {
    const id = el.id || (el.closest('[id^="chat-messages-"]') as HTMLElement)?.id || "";
    const m = id.match(/chat-messages[-_]+(\d+)[-_]+(\d+)/);
    if (m) return { channelId: m[1], messageId: m[2] };
    return null;
}
