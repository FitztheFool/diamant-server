// ── index.ts — entry point · auth · socket handlers ───────────────────────────

import "dotenv/config";
import { randomUUID } from "crypto";
import { Server } from "socket.io";
import { createGameServer } from '@kwizar/shared';
import { BOT_TOLERANCES, buildPublicState, emitToRoom, getRoom, playersInCave, setIo, setRoom, clearPhaseTimer } from "./room";
import { endGame, endRound, resolveDecisions, startDecisionPhase, startRound } from "./game";
import { pushLog } from '@kwizar/shared';
import type { Room } from "./types";

// ── Server setup ───────────────────────────────────────────────────────────────



const { io, lobbySocket, listen } = createGameServer({ serviceName: 'diamant-server', gameType: 'diamant', defaultPort: 10009 });

setIo(io);



lobbySocket.on("diamant:configure", ({ lobbyId, players, options, turnSeconds }: any, ack?: () => void) => {
    if (!lobbyId || !players?.length) return;

    let botIdx = 0;
    const room: Room = {
        lobbyId,
        options: { roundCount: options?.roundCount ?? 5, decisionDuration: turnSeconds ?? options?.decisionDuration ?? 30 },
        players: new Map(
            players.map((p: { userId: string; username: string; }) => {
                const isBot = p.userId.startsWith("bot-");
                return [p.userId, {
                    userId: p.userId, username: p.username, socketId: "",
                    handDiamants: 0, safeDiamants: 0, relicPoints: 0, relicsOwned: 0,
                    riskTolerance: isBot ? BOT_TOLERANCES[botIdx++ % BOT_TOLERANCES.length] : undefined,
                    inCave: false, decision: null, surrendered: false,
                }];
            })
        ),
        phase: "waiting", round: 1, currentGameId: randomUUID(),
        revealedCards: [],
        deck: [],
        seenDangers: new Set(),
        diamantsOnCards: new Map(),
        relicsInCave: [],
        relicsExited: 0,
        decisionTimer: null,
        decisionEndsAt: null,
        phaseTimer: null,
        finalScores: [],
        disconnectTimers: new Map(),
        log: [],
        logSeq: 0,
    };

    setRoom(lobbyId, room);
    console.log(`[DIAMANT] Room configured: ${lobbyId} (${players.length} players)`);

    // Race condition: joueurs connectés avant configure
    for (const [, sock] of io.of("/").sockets as Map<string, import("socket.io").Socket>) {
        if (!sock.rooms.has(`room:${lobbyId}`)) continue;
        const uid = sock.data?.userId;
        if (!uid) continue;
        const p = room.players.get(uid);
        if (!p || p.socketId !== "") continue;
        p.socketId = sock.id;
        sock.emit("diamant:joined", { phase: room.phase, state: buildPublicState(room) });
    }

    const allConnected = Array.from(room.players.values()).every(
        (p) => p.socketId !== "" || p.userId.startsWith("bot-"),
    );
    if (allConnected && room.phase === "waiting") {
        room.phase = "playing";
        setTimeout(() => startRound(room), 500);
    }
    if (typeof ack === "function") ack();
});

// ── Socket handlers ────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("[DIAMANT] connexion", socket.id);

    // ── Join ──────────────────────────────────────────────────────────────────
    socket.on("diamant:join", ({ lobbyId }) => {
        const { userId } = socket.data;
        if (!lobbyId || !userId) return;

        socket.data.lobbyId = lobbyId;
        socket.join(`room:${lobbyId}`);

        const room = getRoom(lobbyId);
        if (!room) { socket.emit("notFound"); return; }

        const player = room.players.get(userId);
        if (!player) {
            // Non-joueur : rejoint en spectateur (état public, déjà dans la room → reçoit les broadcasts).
            socket.emit("diamant:joined", { phase: room.phase, state: buildPublicState(room), spectator: true,
                ...(room.decisionEndsAt && room.phase === "playing" ? { decisionEndsAt: room.decisionEndsAt } : {}) });
            return;
        }

        player.socketId = socket.id;

        const disconnectTimer = room.disconnectTimers.get(userId);
        if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            room.disconnectTimers.delete(userId);
            emitToRoom(room, "diamant:playerReconnected", { userId, username: player.username });
        }

        socket.emit("diamant:joined", {
            phase: room.phase,
            state: buildPublicState(room),
            ...(room.decisionEndsAt && room.phase === "playing" ? { decisionEndsAt: room.decisionEndsAt } : {}),
        });

        const allConnected = Array.from(room.players.values()).every(
            (p) => p.socketId !== "" || p.userId.startsWith("bot-"),
        );
        if (allConnected && room.phase === "waiting") {
            room.phase = "playing";
            setTimeout(() => startRound(room), 500);
        }
    });

    // ── Decision ──────────────────────────────────────────────────────────────
    socket.on("diamant:decision", ({ lobbyId, decision }) => {
        const room = getRoom(lobbyId);
        if (!room || room.phase !== "playing") return;
        if (decision !== "continue" && decision !== "leave") return;

        const { userId } = socket.data;
        const player = room.players.get(userId);
        if (!player || !player.inCave || player.decision !== null) return;

        player.decision = decision;
        emitToRoom(room, "diamant:playerDecided", { userId, state: buildPublicState(room) });

        if (playersInCave(room).every((p) => p.decision !== null)) resolveDecisions(room);
    });

    // ── Surrender ─────────────────────────────────────────────────────────────
    socket.on("diamant:surrender", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId) return;
        const room = getRoom(lobbyId);
        if (!room || room.phase === "finished") return;

        const player = room.players.get(userId);
        if (!player || player.surrendered) return;

        const active = Array.from(room.players.values()).filter((p) => !p.surrendered);
        player.surrendered = true;
        player.inCave = false;
        pushLog(room, "system", `${player.username} abandonne la partie`);
        emitToRoom(room, "diamant:playerSurrendered", { userId });

        const remainingActive = active.filter((p) => p.userId !== userId);
        const onlyBotsLeft = remainingActive.length > 0 && remainingActive.every((p) => p.userId.startsWith("bot-"));

        if (active.length > 2 && !onlyBotsLeft) {
            if (player.decision === null) player.decision = "leave";
            const inCave = playersInCave(room);
            if (inCave.length === 0) {
                clearPhaseTimer(room);
                room.phaseTimer = setTimeout(() => endRound(room, "all_left"), 1500);
            } else if (inCave.every((p) => p.decision !== null)) {
                resolveDecisions(room);
            }
        } else {
            room.surrenderUserId = userId;
            endGame(room);
        }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const room = getRoom(lobbyId);
        if (!room || room.phase !== "playing") return;

        const player = room.players.get(userId);
        if (!player || player.surrendered) return;

        player.socketId = "";

        if (player.inCave && player.decision === null) {
            player.decision = "leave";
            emitToRoom(room, "diamant:playerDecided", { userId, state: buildPublicState(room) });
            if (playersInCave(room).every((p) => p.decision !== null)) resolveDecisions(room);
        }
    });
});

// ── Start ──────────────────────────────────────────────────────────────────────

listen();

