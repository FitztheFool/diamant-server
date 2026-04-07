// ── room.ts — store · timers · state · deck · bot ─────────────────────────────

import type { Server } from "socket.io";
import type { Card, Player, Room } from "./types";

// ── IO singleton ──────────────────────────────────────────────────────────────

let _io: Server;
export const setIo = (io: Server) => { _io = io; };

// ── Room store ────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
export const getRoom = (id: string) => rooms.get(id) ?? null;
export const setRoom = (id: string, r: Room) => rooms.set(id, r);
export const deleteRoom = (id: string) => rooms.delete(id);

export function emitToRoom(room: Room, event: string, payload: unknown) {
    room.players.forEach((p) => {
        _io.sockets.sockets.get(p.socketId)?.emit(event, payload);
    });
}

export function buildPublicState(room: Room) {
    return {
        round: room.round,
        phase: room.phase,
        revealedCards: room.revealedCards,
        rubisonCards: Object.fromEntries(room.rubisonCards),
        relicsInCave: room.relicsInCave,
        relicsExited: room.relicsExited,
        players: Array.from(room.players.values()).map((p) => ({
            userId: p.userId,
            username: p.username,
            handRubies: p.handRubies,
            safeRubies: p.safeRubies,
            relicPoints: p.relicPoints,
            relicsOwned: p.relicsOwned,
            inCave: p.inCave,
            surrendered: p.surrendered,
            hasDecided: p.decision !== null,
        })),
    };
}

// ── Timers ────────────────────────────────────────────────────────────────────

export function clearDecisionTimer(room: Room) {
    if (room.decisionTimer) { clearTimeout(room.decisionTimer); room.decisionTimer = null; }
}
export function clearPhaseTimer(room: Room) {
    if (room.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
}

// ── Deck ──────────────────────────────────────────────────────────────────────

const DANGER_TYPES = ["spider", "fireball", "mummy", "landslide", "snake"] as const;

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export function buildDeck(): Card[] {
    const cards: Card[] = [];
    [1, 2, 3, 4, 5, 5, 7, 7, 9, 11, 11, 13, 14, 15, 17].forEach((v, i) =>
        cards.push({ id: `treasure-${i}`, type: "treasure", value: v }),
    );
    DANGER_TYPES.forEach((danger) => {
        for (let i = 0; i < 3; i++) cards.push({ id: `danger-${danger}-${i}`, type: "danger", danger });
    });
    for (let i = 0; i < 5; i++) cards.push({ id: `relic-${i}`, type: "relic" });
    return shuffle(cards);
}

// ── Bot ───────────────────────────────────────────────────────────────────────

export const BOT_TOLERANCES = [0.25, 0.52, 0.78];

export function playersInCave(room: Room): Player[] {
    return Array.from(room.players.values()).filter((p) => p.inCave);
}

export function botDecide(room: Room, bot: Player): "continue" | "leave" {
    const base = bot.riskTolerance ?? 0.5;
    const tolerance = Math.max(0.1, Math.min(0.9, base + (Math.random() - 0.5) * 0.08));
    const inCave = playersInCave(room);
    const pDoubleDanger = room.deck.length > 0 ? (room.seenDangers.size * 2) / room.deck.length : 1;
    const alone = inCave.length === 1;

    if (alone && room.relicsInCave.length > 0 && pDoubleDanger < tolerance * 0.45) return "continue";
    if (pDoubleDanger > tolerance) return "leave";

    const rubyThreshold = Math.round(3 + tolerance * 14);
    if (bot.handRubies >= rubyThreshold && pDoubleDanger > tolerance * 0.4) return "leave";
    if (bot.handRubies >= Math.max(3, Math.round(rubyThreshold * 0.55)) && pDoubleDanger > tolerance * 0.65) return "leave";
    if (room.revealedCards.length >= 8 && pDoubleDanger > tolerance * 0.35) return "leave";

    return "continue";
}
