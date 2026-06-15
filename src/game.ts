// ── game.ts — rounds · cards · decisions · end ────────────────────────────────

import type { Room } from "./types";
import {
    botDecide, buildDeck, buildPublicState, clearDecisionTimer, clearPhaseTimer,
    deleteRoom, emitToRoom, playersInCave,
} from "./room";
import { pushLog } from "./gameLog";

const DANGER_FR: Record<string, string> = {
    spider: "Araignées", fireball: "Boule de feu", mummy: "Momie",
    landslide: "Éboulement", snake: "Serpents",
};

// ── Round ──────────────────────────────────────────────────────────────────────

export function startRound(room: Room) {
    room.deck = buildDeck();
    room.revealedCards = [];
    room.seenDangers = new Set();
    room.diamantsOnCards = new Map();
    room.relicsInCave = [];

    room.players.forEach((p) => {
        if (p.surrendered) return;
        p.inCave = true;
        p.handDiamants = 0;
        p.decision = null;
    });

    pushLog(room, "system", `Manche ${room.round}/${room.options.roundCount} — exploration de la grotte`);
    emitToRoom(room, "diamant:roundStart", {
        round: room.round,
        totalRounds: room.options.roundCount,
        state: buildPublicState(room),
    });

    clearPhaseTimer(room);
    room.phaseTimer = setTimeout(() => revealNextCard(room), 1500);
}

// ── Card reveal ────────────────────────────────────────────────────────────────

export function revealNextCard(room: Room) {
    clearPhaseTimer(room);
    const inCave = playersInCave(room);
    if (inCave.length === 0) { endRound(room, "all_left"); return; }
    if (room.deck.length === 0) { endRound(room, "deck_empty"); return; }

    const card = room.deck.pop()!;
    const cardIndex = room.revealedCards.length;
    room.revealedCards.push(card);

    if (card.type === "treasure") {
        const share = Math.floor(card.value! / inCave.length);
        const remainder = card.value! - share * inCave.length;
        inCave.forEach((p) => { p.handDiamants += share; });
        room.diamantsOnCards.set(cardIndex, remainder);
        pushLog(room, "score", `Trésor de ${card.value} 💎 — ${share} par explorateur`);
        emitToRoom(room, "diamant:cardRevealed", { card, cardIndex, sharePerPlayer: share, remainder, state: buildPublicState(room) });
        startDecisionPhase(room);

    } else if (card.type === "danger") {
        const danger = card.danger!;
        if (room.seenDangers.has(danger)) {
            inCave.forEach((p) => { p.handDiamants = 0; p.inCave = false; });
            const idx = room.deck.findIndex((c) => c.danger === danger);
            if (idx !== -1) room.deck.splice(idx, 1);
            pushLog(room, "coup", `Double danger ${DANGER_FR[danger] ?? danger} ! Les explorateurs encore dedans perdent tout`);
            emitToRoom(room, "diamant:cardRevealed", { card, cardIndex, state: buildPublicState(room) });
            emitToRoom(room, "diamant:doubleDanger", { danger, state: buildPublicState(room) });
            clearPhaseTimer(room);
            room.phaseTimer = setTimeout(() => endRound(room, "double_danger"), 2000);
        } else {
            room.seenDangers.add(danger);
            pushLog(room, "attack", `Danger : ${DANGER_FR[danger] ?? danger}`);
            emitToRoom(room, "diamant:cardRevealed", { card, cardIndex, state: buildPublicState(room) });
            startDecisionPhase(room);
        }

    } else {
        // relic
        room.relicsInCave.push(card.id);
        pushLog(room, "safety", `Une relique apparaît !`);
        emitToRoom(room, "diamant:cardRevealed", { card, cardIndex, state: buildPublicState(room) });
        startDecisionPhase(room);
    }
}

// ── Decision phase ─────────────────────────────────────────────────────────────

export function startDecisionPhase(room: Room) {
    if (playersInCave(room).length === 0) { endRound(room, "all_left"); return; }

    playersInCave(room).forEach((p) => { p.decision = null; });
    const endsAt = Date.now() + room.options.decisionDuration * 1000;
    room.decisionEndsAt = endsAt;

    emitToRoom(room, "diamant:decisionPhase", { endsAt, duration: room.options.decisionDuration, state: buildPublicState(room) });

    clearDecisionTimer(room);
    if (room.options.decisionDuration > 0) {          // 0 = pas de limite (jamais AFK)
        room.decisionTimer = setTimeout(() => {
            playersInCave(room).forEach((p) => { if (p.decision === null) p.decision = "leave"; });
            resolveDecisions(room);
        }, room.options.decisionDuration * 1000);
    }

    // Bots
    const bots = playersInCave(room).filter((p) => p.userId.startsWith("bot-"));
    for (const bot of bots) {
        setTimeout(() => {
            if (bot.decision !== null || room.phase !== "playing") return;
            bot.decision = botDecide(room, bot);
            emitToRoom(room, "diamant:playerDecided", { userId: bot.userId, state: buildPublicState(room) });
            if (playersInCave(room).every((p) => p.decision !== null)) resolveDecisions(room);
        }, 1000 + Math.random() * 2000);
    }
}

export function resolveDecisions(room: Room) {
    clearDecisionTimer(room);
    const deciding = playersInCave(room);
    const leaving = deciding.filter((p) => p.decision === "leave");
    const continuing = deciding.filter((p) => p.decision === "continue");

    for (const p of continuing) pushLog(room, "move", `${p.username} continue d'explorer`);

    if (leaving.length === 0) {
        emitToRoom(room, "diamant:decisionsRevealed", { decisions: buildDecisionsPayload(room), state: buildPublicState(room) });
        clearPhaseTimer(room);
        room.phaseTimer = setTimeout(() => revealNextCard(room), 1500);
        return;
    }

    // diamants sur cartes → partants à parts égales
    const totalOnCards = Array.from(room.diamantsOnCards.values()).reduce((a, b) => a + b, 0);
    const shareFromCards = Math.floor(totalOnCards / leaving.length);
    const leftover = totalOnCards - shareFromCards * leaving.length;
    leaving.forEach((p) => { p.handDiamants += shareFromCards; });

    room.diamantsOnCards.clear();
    if (leftover > 0 && room.revealedCards.length > 0) {
        const lastTreasureIdx = [...room.revealedCards]
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.type === "treasure")
            .at(-1)?.i ?? room.revealedCards.length - 1;
        room.diamantsOnCards.set(lastTreasureIdx, leftover);
    }

    // Reliques — seulement si UN SEUL joueur sort
    let relicsCollected = 0;
    if (leaving.length === 1) {
        const loner = leaving[0];
        for (let i = 0; i < room.relicsInCave.length; i++) {
            const points = (room.relicsExited + i + 1) <= 3 ? 10 : 20;
            loner.relicPoints += points;
            loner.relicsOwned += 1;
            relicsCollected++;
        }
        room.relicsExited += room.relicsInCave.length;
        room.relicsInCave = [];
    }

    if (relicsCollected > 0 && leaving.length === 1) {
        pushLog(room, "safety", `${leaving[0].username} récupère ${relicsCollected} relique${relicsCollected > 1 ? 's' : ''}`);
    }
    leaving.forEach((p) => {
        pushLog(room, "defend", `${p.username} rentre au camp avec ${p.handDiamants} 💎`);
        p.safeDiamants += p.handDiamants;
        p.handDiamants = 0;
        p.inCave = false;
        p.decision = null;
    });

    emitToRoom(room, "diamant:decisionsRevealed", {
        decisions: buildDecisionsPayload(room),
        leavingPlayers: leaving.map((p) => ({ userId: p.userId, username: p.username, shareFromCards, relicsCollected })),
        state: buildPublicState(room),
    });

    if (playersInCave(room).length === 0) {
        clearPhaseTimer(room);
        room.phaseTimer = setTimeout(() => endRound(room, "all_left"), 1500);
        return;
    }
    clearPhaseTimer(room);
    room.phaseTimer = setTimeout(() => revealNextCard(room), 2000);
}

function buildDecisionsPayload(room: Room) {
    return Array.from(room.players.values()).map((p) => ({
        userId: p.userId,
        decision: p.inCave ? p.decision : "leave",
    }));
}

// ── End round / game ───────────────────────────────────────────────────────────

export async function endRound(room: Room, reason: "double_danger" | "all_left" | "deck_empty") {
    clearDecisionTimer(room);
    clearPhaseTimer(room);
    playersInCave(room).forEach((p) => { p.handDiamants = 0; p.inCave = false; });
    room.relicsExited += room.relicsInCave.length;
    room.relicsInCave = [];
    const REASON_FR: Record<string, string> = {
        double_danger: "double danger", all_left: "tous sortis", deck_empty: "grotte épuisée",
    };
    pushLog(room, "system", `Fin de la manche ${room.round} (${REASON_FR[reason] ?? reason})`);
    emitToRoom(room, "diamant:roundEnd", { round: room.round, reason, state: buildPublicState(room) });

    if (room.round >= room.options.roundCount) {
        room.phaseTimer = setTimeout(() => endGame(room), 2000);
    } else {
        room.round++;
        room.phaseTimer = setTimeout(() => startRound(room), 3000);
    }
}

export async function endGame(room: Room) {
    clearDecisionTimer(room);
    room.phase = "finished";

    const scores = Array.from(room.players.values())
        .map((p) => ({
            userId: p.userId, username: p.username,
            score: p.safeDiamants + p.relicPoints,
            safeDiamants: p.safeDiamants, relicPoints: p.relicPoints, relicsOwned: p.relicsOwned,
        }))
        .sort((a, b) => b.score - a.score);

    room.finalScores = scores;
    if (scores[0]) pushLog(room, "coup", `${scores[0].username} gagne avec ${scores[0].score} points !`);
    emitToRoom(room, "diamant:finished", { scores, winnerId: scores[0]?.userId ?? null });

    // Save to DB
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (frontendUrl && secret) {
        const vsBot = Array.from(room.players.keys()).some((id) => id.startsWith("bot-"));
        const humanScores = scores.filter((s) => !s.userId.startsWith("bot-"));
        if (humanScores.length > 0) {
            const isAbandon = (userId: string) =>
                room.surrenderUserId === userId || (room.players.get(userId)?.surrendered ?? false);

            const humanFinishers = humanScores.filter((s) => !isAbandon(s.userId));
            const botScoresAll = scores.filter((s) => s.userId.startsWith("bot-"));
            const allFinishers = [...humanFinishers, ...botScoresAll].sort((a, b) => b.score - a.score);

            const bots = botScoresAll.map((s) => ({
                username: s.username,
                score: s.score,
                placement: allFinishers.findIndex((x) => x.userId === s.userId) + 1,
            }));
            try {
                const res = await fetch(`${frontendUrl}/api/attempts`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
                    body: JSON.stringify({
                        gameType: "DIAMANT",
                        gameId: room.currentGameId ?? room.lobbyId,
                        vsBot,
                        bots: bots.length > 0 ? bots : undefined,
                        scores: scores.map((s) => {
                            const abandon = isAbandon(s.userId);
                            return {
                                userId: s.userId,
                                username: s.username,
                                score: s.score,
                                placement: abandon ? null : allFinishers.findIndex((x) => x.userId === s.userId) + 1,
                                abandon,
                            };
                        }),
                    }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                console.log(`[DIAMANT] scores saved for ${room.currentGameId ?? room.lobbyId}`);
                const data = (await res.json().catch(() => null)) as { elo?: { userId: string; before: number; after: number; delta: number }[] } | null;
                if (data?.elo?.length) emitToRoom(room, "elo:update", { gameType: "DIAMANT", elo: data.elo });
            } catch (err) {
                console.error("[DIAMANT] saveAttempts error:", err);
            }
        }
    }

    setTimeout(() => deleteRoom(room.lobbyId), 5 * 60 * 1000);
}
