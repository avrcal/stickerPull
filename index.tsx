import "./StickerOverlay.css";

import { ChatBarButton, addChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { IconComponent } from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import {
    FluxDispatcher,
    Menu,
    StickersStore,
} from "@webpack/common";

import {
    checkHealth,
    createSticker as apiPost,
    cdnUrl,
    deleteSticker,
    fetchStickers as apiGet,
    SERVER_URL,
    updateSticker as apiPatch,
} from "./api";
import { findMsg, getCurrentUserId, getIds, isOwnedByMe, parseMsgId } from "./utils";

let pullSticker: { id: string; url: string; format_type?: number } | null = null;
let pullGhost: HTMLElement | null = null;
let pullMoveHandler: ((e: MouseEvent) => void) | null = null;
let activeOverlays: Map<number, HTMLElement> = new Map();
let channelStickers: { id?: number; sticker_id?: string; sticker_url?: string; owner_id?: string | null; format_type?: number; message_id: string; rel_x: number; rel_y: number; psid?: number; size?: number }[] = [];
let chatObs: MutationObserver | null = null;
let lastChannelKey = "";
let spMenuEl: HTMLElement | null = null;
let lockTick: ReturnType<typeof setTimeout> | null = null;
let lockObs: MutationObserver | null = null;

const ROW_H = 40;

const settings = definePluginSettings({
    stickerSize: {
        type: OptionType.NUMBER,
        description: "Size of placed stickers in pixels (1-120).",
        default: 88,
        isValid: (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 1 && n <= 120) return true;
            return "Sticker size must be between 1 and 120 pixels";
        },
    },
});

function sz() {
    return settings.store.stickerSize ?? 88;
}

function elW(el: HTMLElement): number {
    const v = parseFloat(el.style.width);
    return Number.isFinite(v) && v > 0 ? v : sz();
}

async function ensureCsp() {
    try {
        
        
        if ((window as any).VencordNative?.pluginHelpers?.StickerPull?.httpFetch) {
            console.log("[StickerPull] using native IPC transport — CSP permission not needed");
            return;
        }
        const url = SERVER_URL;
        const csp = (window as any).VencordNative?.csp;
        if (!csp) return;
        if (await csp.isDomainAllowed(url, ["connect-src"])) {
            console.log("[StickerPull] CSP already allows", url);
            return;
        }
        console.log("[StickerPull] requesting CSP permission for", url);
        const res = await csp.requestAddOverride(url, ["connect-src"], "StickerPull");
        if (res === "ok" || res === "conflict") {
            console.log("[StickerPull] CSP permission saved for", url, "- FULLY quit Discord (tray icon > Quit) and reopen for it to take effect");
        } else if (res === "unchecked") {
            console.warn("[StickerPull] CSP dialog needs the trust checkbox TICKED plus Allow, then a full Discord restart");
        } else {
            console.warn("[StickerPull] CSP permission not granted (" + res + ") - server fetches will stay blocked. Try again after a full restart.");
        }
    } catch (e) {
        console.warn("[StickerPull] CSP check failed", e);
    }
}

let statusChecked = false;

async function checkServerStatus() {
    if (statusChecked) return;
    statusChecked = true;
    try {
        const h = await checkHealth();
        if (!h) {
            showNotification({
                title: "StickerPull: server unreachable",
                body: `Could not reach the server.`,
                color: "var(--status-danger)",
            });
            return;
        }
        if (h.relay && !h.bridge) {
            showNotification({
                title: "StickerPull: database unreachable",
                body: "The vps is reachable but no database phone server is connected."
                color: "var(--status-warning, #faa61a)",
            });
            return;
        }
        } catch (e) {
        console.warn("[StickerPull] status check failed", e);
    }
}

function hideSpMenu() {
    spMenuEl?.remove();
    spMenuEl = null;
}

function showSpMenu(x: number, y: number, items: { label: string; action: () => void; danger?: boolean }[]) {
    hideSpMenu();
    const menu = document.createElement("div");
    menu.className = "vc-sp-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    for (const item of items) {
        const btn = document.createElement("div");
        btn.className = "vc-sp-menu-item" + (item.danger ? " vc-sp-menu-danger" : "");
        btn.textContent = item.label;
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            hideSpMenu();
            item.action();
        });
        menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    spMenuEl = menu;

    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > innerWidth) menu.style.left = `${innerWidth - rect.width - 8}px`;
        if (rect.bottom > innerHeight) menu.style.top = `${innerHeight - rect.height - 8}px`;
    });
}

function ensureOverlay(): HTMLElement {
    let overlay = document.getElementById("vc-sp-overlay") as HTMLElement | null;
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "vc-sp-overlay";
        document.body.appendChild(overlay);
    }
    return overlay;
}

const msgElCache = new Map<string, HTMLElement>();

function findMsgEl(msgId: string): HTMLElement | null {
    const cached = msgElCache.get(msgId);
    if (cached && cached.isConnected) return cached;
    const el = document.querySelector(`li[id*="${msgId}"]`) as HTMLElement | null;
    if (el) msgElCache.set(msgId, el);
    else msgElCache.delete(msgId);
    return el;
}

function pruneMsgElCache() {
    (msgElCache as any).forEach?.((el: HTMLElement, key: string) => {
        if (!el.isConnected) msgElCache.delete(key);
    });
}

let positionRaf = 0;
let positionDirty = false;

function schedulePositionUpdate() {
    if (positionDirty) return;
    positionDirty = true;
    positionRaf = requestAnimationFrame(() => {
        positionDirty = false;
        updatePositions();
    });
}

function renderChannelStickers() {
    const overlay = ensureOverlay();
    pruneMsgElCache();

    
    activeOverlays.forEach((el, dbId) => {
        const msgId = el.dataset.messageId;
        if (msgId && !findMsgEl(msgId)) {
            el.remove();
            activeOverlays.delete(dbId);
        }
    });

    for (const s of channelStickers) {
        if (s.id == null || !s.sticker_id) continue;
        if (!findMsgEl(s.message_id)) continue; 
        if (activeOverlays.has(s.id)) continue;
        createOverlaySticker(
            overlay,
            s.sticker_id,
            s.sticker_url || cdnUrl(s.sticker_id, s.format_type),
            s.format_type,
            s.rel_x,
            s.rel_y,
            s.id,
            s.psid ?? 0,
            s.message_id,
            s.owner_id ?? null,
            s.size
        );
    }
    schedulePositionUpdate();
}

function applyStickerPosition(el: HTMLElement, msgEl: HTMLElement) {
    const rect = msgEl.getBoundingClientRect();
    const rx = parseFloat(el.dataset.relX || "0.5");
    const ry = parseFloat(el.dataset.relY || "0");
    const w = elW(el);
    const left = rect.left + rx * rect.width - w / 2;
    const top = rect.top + ry * ROW_H - w / 2;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.opacity = "1";
}

function updatePositions() {
    activeOverlays.forEach((el) => {
        const msgId = el.dataset.messageId;
        if (!msgId) return;
        const msgEl = findMsgEl(msgId);
        if (!msgEl) return;
        applyStickerPosition(el, msgEl);
    });
}

function syncOwnershipVisual(d: HTMLElement) {
    const mine = isOwnedByMe(d.dataset.ownerId ?? null);
    d.classList.toggle("vc-sp-foreign", !mine);
    if (mine) {
        d.style.cursor = "grab";
        d.removeAttribute("title");
    } else {
        d.style.cursor = "not-allowed";
        d.title = "Placed by another user — only the owner can move or delete it";
    }
}

function createOverlaySticker(
    overlay: HTMLElement,
    stickerId: string,
    stickerUrl: string | undefined,
    fmt: number | undefined,
    rx: number,
    ry: number,
    dbId: number,
    psid: number,
    msgId: string,
    ownerId?: string | null,
    size?: number
): HTMLElement {
    const existing = overlay.querySelector(`[data-db-id="${dbId}"]`) as HTMLElement | null;
    if (existing) {
        if (ownerId) existing.dataset.ownerId = String(ownerId);
        syncOwnershipVisual(existing);
        return existing;
    }

    const d = document.createElement("div");
    d.className = "vc-sp-sticker";
    d.dataset.dbId = String(dbId);
    d.dataset.psid = String(psid);
    d.dataset.stickerId = stickerId;
    if (stickerUrl) d.dataset.stickerUrl = stickerUrl;
    if (ownerId) d.dataset.ownerId = String(ownerId);
    d.dataset.relX = String(rx);
    d.dataset.relY = String(ry);
    d.dataset.messageId = msgId;
    d.dataset.formatType = String(fmt ?? "");
    const sizePx = size && Number.isFinite(size) && size >= 1 ? size : sz();
    d.dataset.size = String(sizePx);
    d.style.width = `${sizePx}px`;
    d.style.height = `${sizePx}px`;
    syncOwnershipVisual(d);

    const img = document.createElement("img");
    img.src = stickerUrl || cdnUrl(stickerId, fmt);
    img.alt = "sticker";
    img.draggable = false;
    img.onerror = () => {
        if (img.src.includes(".png")) img.src = cdnUrl(stickerId, 4);
    };
    d.appendChild(img);

    
    let dragging = false,
        sx = 0,
        sy = 0,
        ghost: HTMLElement | null = null;
    let origRx = rx,
        origRy = ry;

    const onMove = (e: MouseEvent) => {
        if (!dragging || !ghost) return;
        const w = elW(ghost);
        ghost.style.left = `${e.clientX - w / 2}px`;
        ghost.style.top = `${e.clientY - w / 2}px`;
    };

    const onUp = async (e: MouseEvent) => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        ghost?.remove();
        ghost = null;
        d.style.display = "";

        const dx = Math.abs(e.clientX - sx),
            dy = Math.abs(e.clientY - sy);
        if (dx < 4 && dy < 4) return;

        const msg = findMsg(e.clientX, e.clientY);
        const parsed = msg ? parseMsgId(msg) : null;
        const { guildId, channelId } = getIds();

        let newRx = origRx,
            newRy = origRy;
        let newMsgId = msgId;
        let newChannelId = channelId!;
        if (msg) {
            const msgRect = msg.getBoundingClientRect();
            newRx = Math.max(0.02, Math.min(0.98, (e.clientX - msgRect.left) / msgRect.width));
            newRy = Math.max(-5, Math.min(20, (e.clientY - msgRect.top) / ROW_H));
            newMsgId = parsed?.messageId || msgId;
            newChannelId = parsed?.channelId || channelId!;
        }

        d.dataset.relX = String(newRx);
        d.dataset.relY = String(newRy);
        d.dataset.messageId = newMsgId;
        origRx = newRx;
        origRy = newRy;

        if (msg) {
            applyStickerPosition(d, msg);
        }

        await apiPatch(dbId, {
            rel_x: newRx,
            rel_y: newRy,
            message_id: newMsgId,
            channel_id: newChannelId,
            guild_id: guildId,
            owner_id: getCurrentUserId(),
            window_w: innerWidth,
            window_h: innerHeight,
        });

        
        const cached = channelStickers.find(c => c.id === dbId);
        if (cached) {
            cached.rel_x = newRx;
            cached.rel_y = newRy;
            cached.message_id = newMsgId;
        }
        
        
        
        schedulePositionUpdate();
    };

    d.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        
        if (!isOwnedByMe(d.dataset.ownerId ?? null)) {
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        hideSpMenu();
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        origRx = parseFloat(d.dataset.relX || "0.5");
        origRy = parseFloat(d.dataset.relY || "0");

        ghost = d.cloneNode(true) as HTMLElement;
        ghost.className = "vc-sp-ghost";
        const gw = elW(ghost);
        ghost.style.left = `${e.clientX - gw / 2}px`;
        ghost.style.top = `${e.clientY - gw / 2}px`;
        document.body.appendChild(ghost);
        d.style.display = "none";
        document.body.style.cursor = "grabbing";

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    
    d.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!isOwnedByMe(d.dataset.ownerId ?? null)) {
            showSpMenu(e.clientX, e.clientY, [
                {
                    label: "🔒 Owned by another user",
                    action: () => {},
                },
            ]);
            return;
        }
        const stickerUrl = d.dataset.stickerUrl || cdnUrl(stickerId, fmt);

        showSpMenu(e.clientX, e.clientY, [
            {
                label: "Grab Sticker",
                action: () => {
                    if (!isOwnedByMe(d.dataset.ownerId ?? null)) return;
                    const myId = getCurrentUserId();
                    d.remove();
                    activeOverlays.delete(dbId);
                    channelStickers = channelStickers.filter(c => c.id !== dbId);
                    deleteSticker(dbId, myId);
                    startPull(stickerId, stickerUrl, fmt);
                },
            },
            {
                label: "Remove Sticker",
                danger: true,
                action: () => {
                    if (!isOwnedByMe(d.dataset.ownerId ?? null)) return;
                    const myId = getCurrentUserId();
                    d.remove();
                    activeOverlays.delete(dbId);
                    channelStickers = channelStickers.filter(c => c.id !== dbId);
                    deleteSticker(dbId, myId);
                },
            },
        ]);
    });

    overlay.appendChild(d);
    activeOverlays.set(dbId, d);
    schedulePositionUpdate();
    return d;
}

let pickerObs: MutationObserver | null = null;

function getStickerElFromEvent(e: MouseEvent): HTMLElement | null {
    const target = e.target as HTMLElement;
    
    let el: HTMLElement | null = target;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
        if (el.closest("#vc-sp-overlay")) return null;
        if (el.dataset?.type === "sticker") return el;
        if ((el.dataset?.id && /^\d{17,20}$/.test(el.dataset.id)) && (el.tagName === "IMG" || el.tagName === "CANVAS" || el.classList?.length)) return el;
        el = el.parentElement;
    }
    return null;
}

function getStickerData(el: HTMLElement): { id: string; url: string; format_type?: number } | null {
    
    let node: HTMLElement | null = el;
    let id: string | null = null;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
        if (node.dataset?.type === "sticker" && node.dataset?.id) { id = node.dataset.id; break; }
        if (node.dataset?.id && /^\d{17,20}$/.test(node.dataset.id)) { id = node.dataset.id; break; }
        node = node.parentElement;
    }
    if (!id) return null;

    let format_type: number | undefined;
    const storeSticker = StickersStore.getStickerById(id);
    if (storeSticker) format_type = storeSticker.format_type;

    
    let url = getStickerUrl(id, format_type);
    const imgEl = el.querySelector("img") as HTMLImageElement | null;
    if (imgEl?.src && imgEl.src.includes("/stickers/")) url = imgEl.src;

    return { id, url, format_type };
}

function startPullFromEvent(e: MouseEvent) {
    if (e.button !== 0) return;
    const stickerEl = getStickerElFromEvent(e);
    if (!stickerEl) return;
    
    if (stickerEl.closest("#vc-sp-overlay")) return;

    const data = getStickerData(stickerEl);
    if (!data?.id) return;

    
    
    const sx = e.clientX,
        sy = e.clientY;
    let activated = false;

    const onMove = (me: MouseEvent) => {
        const dx = me.clientX - sx,
            dy = me.clientY - sy;
        if (!activated && Math.hypot(dx, dy) < 5) return;
        if (activated) {
            
            return;
        }
        
        activated = true;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        
        const blockClick = (ce: MouseEvent) => {
            const t = ce.target as HTMLElement;
            if (t === stickerEl || stickerEl.contains(t) || t === e.target) {
                ce.preventDefault();
                ce.stopPropagation();
                (ce as any).stopImmediatePropagation?.();
            }
            document.removeEventListener("click", blockClick, true);
        };
        document.addEventListener("click", blockClick, true);

        startPull(data.id, data.url, data.format_type);
    };
    const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
}

function makePullable(root: ParentNode = document) {
    root.querySelectorAll<HTMLElement>('[data-type="sticker"]').forEach(el => {
        if (el.closest("#vc-sp-overlay")) return;
        if ((el as any)._vcPull) return;
        (el as any)._vcPull = true;
        el.addEventListener("mousedown", startPullFromEvent);
    });
    
    root.querySelectorAll<HTMLElement>("img[src*='/stickers/']").forEach(img => {
        if (img.closest("#vc-sp-overlay")) return;
        if ((img as any)._vcPull) return;
        const host = (img.closest('[data-type="sticker"]') || img.closest('[data-id]')) as HTMLElement | null;
        if (host && (host as any)._vcPull) return;
        (img as any)._vcPull = true;
        img.parentElement?.addEventListener("mousedown", startPullFromEvent) || img.addEventListener("mousedown", startPullFromEvent);
    });
}

function cancelPull() {
    pullSticker = null;
    pullGhost?.remove();
    pullGhost = null;
    if (pullMoveHandler) {
        document.removeEventListener("mousemove", pullMoveHandler);
        pullMoveHandler = null;
    }
    document.body.style.cursor = "";
    document.removeEventListener("click", onPullClick, true);
    document.removeEventListener("keydown", onPullKey, true);
}

function onPullKey(e: KeyboardEvent) {
    if (e.key === "Escape") cancelPull();
}

function onPullClick(e: MouseEvent) {
    if (!pullSticker) return;
    const target = e.target as HTMLElement;
    if (target.closest(".vc-sp-sticker") || target.closest("#vc-sp-overlay") || target.closest(".vc-sp-menu") || target.closest("#vc-sp-section")) return;

    const msg = findMsg(e.clientX, e.clientY);
    if (!msg) return;

    e.preventDefault();
    e.stopPropagation();

    const parsed = parseMsgId(msg);
    const { guildId, channelId } = getIds();
    const msgId = parsed?.messageId || `fallback-${Date.now()}`;
    const cid = parsed?.channelId || channelId!;
    const msgRect = msg.getBoundingClientRect();
    const rx = Math.max(0.02, Math.min(0.98, (e.clientX - msgRect.left) / msgRect.width));
    const ry = Math.max(-5, Math.min(20, (e.clientY - msgRect.top) / ROW_H));

    const s = pullSticker!;
    cancelPull();

    (async () => {
        const myId = getCurrentUserId();
        const payload = {
            guild_id: guildId,
            channel_id: cid,
            message_id: msgId,
            sticker_id: s.id,
            sticker_url: s.url,
            owner_id: myId,
            format_type: s.format_type,
            rel_x: rx,
            rel_y: ry,
            size: sz(),
            window_w: innerWidth,
            window_h: innerHeight,
        };
        let saved: Awaited<ReturnType<typeof apiPost>> = null;
        for (let attempt = 0; attempt < 3 && !saved; attempt++) {
            saved = await apiPost(payload);
            if (!saved && attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
        if (saved) {
            const overlay = ensureOverlay();
            createOverlaySticker(
                overlay,
                s.id,
                saved.sticker_url || s.url,
                s.format_type,
                saved.rel_x,
                saved.rel_y,
                saved.id!,
                saved.psid!,
                msgId,
                saved.owner_id ?? myId,
                saved.size ?? sz()
            );
            
            if (saved.id != null) {
                channelStickers.push({
                    id: saved.id,
                    psid: saved.psid,
                    sticker_id: s.id,
                    sticker_url: saved.sticker_url || s.url,
                    owner_id: saved.owner_id ?? myId,
                    format_type: s.format_type,
                    message_id: msgId,
                    rel_x: saved.rel_x,
                    rel_y: saved.rel_y,
                    size: saved.size ?? sz(),
                });
            }
            schedulePositionUpdate();
        }
    })();
}

function startPull(stickerId: string, stickerUrl: string, formatType?: number) {
    cancelPull();
    pullSticker = { id: stickerId, url: stickerUrl, format_type: formatType };

    pullGhost = document.createElement("div");
    pullGhost.id = "vc-sp-pull-ghost";
    pullGhost.style.left = "-1000px";
    pullGhost.style.top = "-1000px";
    const ps = sz();
    pullGhost.style.width = `${ps}px`;
    pullGhost.style.height = `${ps}px`;
    const img = document.createElement("img");
    img.src = stickerUrl || cdnUrl(stickerId, formatType);
    img.draggable = false;
    pullGhost.appendChild(img);
    document.body.appendChild(pullGhost);
    document.body.style.cursor = "crosshair";

    pullMoveHandler = (e: MouseEvent) => {
        if (pullGhost) {
            pullGhost.style.left = `${e.clientX - sz() / 2}px`;
            pullGhost.style.top = `${e.clientY - sz() / 2}px`;
        }
    };
    document.addEventListener("mousemove", pullMoveHandler);
    document.addEventListener("click", onPullClick, true);
    document.addEventListener("keydown", onPullKey, true);
}

const SP_STICKER_ICON_SVG =
    `<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2Zm-3.8 8.5a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Zm7.6 0a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4ZM12 16.5c-2 0-3.5-1-4.5-2.5l1.8 1.2c.8.6 1.7.8 2.7.8s1.9-.3 2.7-.8L16.5 14c-1 1.6-2.5 2.5-4.5 2.5Z"/>
    </svg>`;

const SP_EYE_ICON_SVG =
    `<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5Zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/>
    </svg>`;

const SPEyeIcon: IconComponent = () => (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5Zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"/>
    </svg>
);

function isLockedChannel(): boolean {
    const root =
        document.querySelector('div[class*="chat"]') ||
        document.querySelector('[data-list-id="chat-messages"]')?.parentElement ||
        document;
    const q = (sel: string) => root.querySelector(sel);
    const form = q('form[class*="form_"]') as HTMLElement | null;
    if (form && /Follow to get this channel/.test(form.textContent || "")) return true;
    if (q('[aria-label*="You do not have permission to send messages"]')) return true;
    if (q('[class*="channelTextAreaDisabled"]')) return true;
    if (q('[class*="textAreaDisabled"]')) return true;
    const inner = q('div[class*="innerDisabled"]') as HTMLElement | null;
    if (inner && /permission to send messages/.test(inner.textContent || "")) return true;
    return false;
}

function sectionStickers(): { id: string; format_type?: number; name?: string }[] {
    const { guildId } = getIds();
    const out: { id: string; format_type?: number; name?: string }[] = [];
    const seen = new Set<string>();
    try {
        const guild = (StickersStore as any).getStickersByGuildId?.(guildId ?? "");
        if (Array.isArray(guild)) for (const s of guild) if (s?.id) out.push(s);
    } catch {}
    try {
        const pack = (StickersStore as any).getPreviewedPack?.();
        const pps = pack?.stickers ?? (pack?.visibleStickers ?? []);
        if (Array.isArray(pps)) for (const s of pps) if (s?.id) out.push(s);
    } catch {}
    return out.filter((s) => {
        const sid = String(s.id);
        if (seen.has(sid)) return false;
        seen.add(sid);
        return true;
    });
}

function positionSpSection(panel: HTMLElement) {
    const host =
        document.querySelector('form[class*="form_"]') ||
        document.querySelector('div[class*="channelTextArea"]') ||
        document.querySelector('div[class*="chat"]');
    const rect = (host || document.body).getBoundingClientRect();
    panel.style.right = `${Math.max(10, window.innerWidth - rect.right + 10)}px`;
    panel.style.bottom = `${Math.max(10, window.innerHeight - Math.max(0, rect.top) + 10)}px`;
}

function buildSpSection() {
    document.getElementById("vc-sp-section")?.remove();
    const stickers = sectionStickers();
    const panel = document.createElement("div");
    panel.id = "vc-sp-section";
    panel.className = "vc-sp-section";

    const head = document.createElement("div");
    head.className = "vc-sp-section-head";
    const title = document.createElement("span");
    title.className = "vc-sp-section-title";
    title.textContent = "StickerPull — Stickers";
    const meta = document.createElement("span");
    meta.className = "vc-sp-section-meta";
    meta.textContent = stickers.length ? `${stickers.length}` : "none here";
    head.append(title, meta);
    panel.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "vc-sp-section-grid";
    if (!stickers.length) {
        const hint = document.createElement("div");
        hint.className = "vc-sp-section-hint";
        hint.textContent = "No server stickers in this channel.";
        grid.appendChild(hint);
    } else {
        for (const s of stickers) {
            const img = document.createElement("img");
            img.dataset.type = "sticker";
            img.dataset.id = String(s.id);
            img.alt = s.name || "sticker";
            img.title = s.name || "sticker";
            img.draggable = false;
            img.loading = "lazy";
            img.src = cdnUrl(String(s.id), s.format_type);
            grid.appendChild(img);
        }
    }
    panel.appendChild(grid);
    document.body.appendChild(panel);
    makePullable(grid);
    positionSpSection(panel);
}

function openSpPanel() {
    buildSpSection();
}

function toggleSpPanel() {
    if (document.getElementById("vc-sp-section")) {
        document.getElementById("vc-sp-section")!.remove();
    } else {
        openSpPanel();
    }
}

let lockedBtnEl: HTMLElement | null = null;
let overlaysHidden = false;

function positionLockedToggle() {
    if (!lockedBtnEl) return;
    const container =
        (document.querySelector('form[class*="form_"]') as HTMLElement | null) ||
        (document.querySelector('div[class*="channelTextArea"]') as HTMLElement | null);
    if (!container) return;
    const r = container.getBoundingClientRect();
    lockedBtnEl.style.left = `${Math.max(0, r.right - 44)}px`;
    lockedBtnEl.style.top = `${Math.max(0, r.bottom - 38)}px`;
}

function attachLockedToggle() {
    if (lockedBtnEl && lockedBtnEl.isConnected) {
        positionLockedToggle();
        return;
    }
    const container =
        (document.querySelector('form[class*="form_"]') as HTMLElement | null) ||
        (document.querySelector('div[class*="channelTextArea"]') as HTMLElement | null);
    if (!container) return;
    const btn = document.createElement("div");
    btn.id = "vc-sp-locked-toggle";
    btn.className = "vc-sp-locked-toggle";
    btn.title = "StickerPull — sticker section";
    btn.innerHTML = SP_STICKER_ICON_SVG;
    btn.style.position = "fixed";
    btn.style.zIndex = "100006";
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSpPanel();
    });
    document.body.appendChild(btn);
    lockedBtnEl = btn;
    positionLockedToggle();
}

function removeLockedToggle() {
    lockedBtnEl?.remove();
    lockedBtnEl = null;
}

function syncLockedState() {
    if (isLockedChannel()) attachLockedToggle();
    else removeLockedToggle();
}

function toggleOverlayVisibility() {
    overlaysHidden = !overlaysHidden;
    document.getElementById("vc-sp-overlay")?.classList.toggle("vc-sp-hidden", overlaysHidden);
}

function observeLocked() {
    lockObs?.disconnect();
    const root =
        document.querySelector('div[class*="chat"]') ||
        document.querySelector('[data-list-id="chat-messages"]')?.parentElement ||
        document.body;
    lockObs = new MutationObserver(() => {
        if (lockTick) clearTimeout(lockTick);
        lockTick = setTimeout(syncLockedState, 400);
    });
    lockObs.observe(root, { childList: true, subtree: true });
}

function getStickerIdFromTarget(target: HTMLElement): string | null {
    let el: HTMLElement | null = target;
    for (let i = 0; i < 6 && el && el !== document.body; i++) {
        if (el.dataset?.id && el.dataset?.type === "sticker") return el.dataset.id;
        if (el.dataset?.id && !el.dataset?.type) {
            const id = el.dataset.id;
            if (/^\d{17,20}$/.test(id)) return id;
        }
        el = el.parentElement;
    }
    return null;
}

function getStickerUrl(id: string, formatType?: number): string {
    if (formatType === 4) {
        const proxy = (window as any).GLOBAL_ENV?.MEDIA_PROXY_ENDPOINT || "//media.discordapp.net";
        return `https:${proxy}/stickers/${id}.gif?size=160&lossless=true`;
    }
    return cdnUrl(id, formatType);
}

const expressionPickerPatch: NavContextMenuPatchCallback = (children, props) => {
    const target = props?.target as HTMLElement | undefined;
    if (!target) return;

    const id = getStickerIdFromTarget(target);
    if (!id) return;

    if (target.className?.includes?.("lottieCanvas")) return;

    let formatType: number | undefined;
    const sticker = StickersStore.getStickerById(id);
    if (sticker) {
        formatType = sticker.format_type;
    }

    const url = getStickerUrl(id, formatType);

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="vc-sp-pull"
                label="Pull to Chat"
                action={() => startPull(id, url, formatType)}
            />
        </Menu.MenuGroup>
    );
};

async function loadStickers() {
    const { guildId, channelId } = getIds();
    if (!channelId) return;

    let stickers: typeof channelStickers | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            stickers = await apiGet(guildId, channelId);
            break;
        } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
    }
    if (stickers == null) return;
    channelStickers = stickers;
    renderChannelStickers();
}

function clearChannel() {
    channelStickers = [];
    const overlay = document.getElementById("vc-sp-overlay");
    if (overlay) overlay.innerHTML = "";
    activeOverlays.clear();
}

function onChannelChange() {
    const { guildId, channelId } = getIds();
    const key = `${guildId || "dm"}:${channelId}`;
    if (key === lastChannelKey) return;
    lastChannelKey = key;
    clearChannel();
    document.getElementById("vc-sp-section")?.remove();
    setTimeout(loadStickers, 500);
    setTimeout(syncLockedState, 900);
}

function onGlobalClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest(".vc-sp-menu")) hideSpMenu();
}

let scrollHandler: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;

export default definePlugin({
    name: "StickerPull",
    description:
        "A plugin where you grab and place stickers in the chat.",
    authors: [{ name: "c004i", id: 979605613719982100n }],
    tags: ["Chat", "Emotes"],
    settings,

    contextMenus: {
        "expression-picker": expressionPickerPatch,
    },

    start() {
        void ensureCsp();
        ensureOverlay();

        setTimeout(checkServerStatus, 3000);

        FluxDispatcher.subscribe("CHANNEL_SELECT", onChannelChange);
        FluxDispatcher.subscribe("GUILD_SELECT", onChannelChange);

        addChatBarButton(
            "stickerPullVisibility",
            () => (
                <ChatBarButton
                    tooltip={overlaysHidden ? "Show positioned stickers" : "Hide positioned stickers"}
                    onClick={() => toggleOverlayVisibility()}
                >
                    <SPEyeIcon />
                </ChatBarButton>
            ),
            SPEyeIcon
        );

        observeLocked();
        setTimeout(syncLockedState, 1500);

        scrollHandler = () => {
            schedulePositionUpdate();
            positionLockedToggle();
        };
        resizeHandler = () => {
            schedulePositionUpdate();
            positionLockedToggle();
        };
        window.addEventListener("scroll", scrollHandler, { capture: true, passive: true });
        window.addEventListener("resize", resizeHandler, { passive: true });

        const root =
            document.querySelector('ol[data-list-id="chat-messages"]')?.parentElement ||
            document.querySelector('[class*="messagesWrapper"]') ||
            document.body;
        
        
        let renderTick: ReturnType<typeof setTimeout> | null = null;
        chatObs = new MutationObserver(() => {
            if (renderTick) clearTimeout(renderTick);
            renderTick = setTimeout(renderChannelStickers, 60);
        });
        chatObs.observe(root, { childList: true, subtree: true });

        
        makePullable(document);
        pickerObs = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const node of Array.from(m.addedNodes)) {
                    if (node.nodeType !== 1) continue;
                    const el = node as HTMLElement;
                    if (el.matches?.('[data-type="sticker"]') || el.querySelector?.('[data-type="sticker"]')) {
                        makePullable(el);
                    } else if ((el as Element).querySelectorAll?.('img[src*="/stickers/"]').length) {
                        makePullable(el);
                    }
                }
            }
        });
        pickerObs.observe(document.body, { childList: true, subtree: true });

        document.addEventListener("click", onGlobalClick, true);

        setTimeout(loadStickers, 1200);
    },

    stop() {
        cancelPull();
        hideSpMenu();
        removeChatBarButton("stickerPullVisibility");
        removeLockedToggle();
        document.getElementById("vc-sp-section")?.remove();
        overlaysHidden = false;
        document.getElementById("vc-sp-overlay")?.classList.remove("vc-sp-hidden");
        if (lockTick) clearTimeout(lockTick);
        lockTick = null;
        lockObs?.disconnect();
        lockObs = null;

        FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannelChange);
        FluxDispatcher.unsubscribe("GUILD_SELECT", onChannelChange);

        if (scrollHandler) window.removeEventListener("scroll", scrollHandler, { capture: true } as any);
        if (resizeHandler) window.removeEventListener("resize", resizeHandler);
        scrollHandler = null;
        resizeHandler = null;

        chatObs?.disconnect();
        chatObs = null;

        pickerObs?.disconnect();
        pickerObs = null;

        document.removeEventListener("click", onGlobalClick, true);

        document.getElementById("vc-sp-overlay")?.remove();
        activeOverlays.clear();
        if (positionRaf) cancelAnimationFrame(positionRaf);
        positionRaf = 0;
        positionDirty = false;
        msgElCache.clear();
    },
});
