// ── index.ts — entry point · auth · socket handlers ───────────────────────────

import "dotenv/config";
import { randomUUID } from "crypto";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { setupSocketAuth, corsConfig } from "@kwizar/shared";
import { BOT_TOLERANCES, buildPublicState, emitToRoom, getRoom, playersInCave, setIo, setRoom, clearPhaseTimer } from "./room";
import { endGame, endRound, resolveDecisions, startDecisionPhase, startRound } from "./game";
import type { Room } from "./types";

// ── Server setup ───────────────────────────────────────────────────────────────

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

const io = new Server(server, { cors: corsConfig });

setIo(io);

setupSocketAuth(io, new TextEncoder().encode(process.env.INTERNAL_API_KEY!));

// ── Socket handlers ────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("diamant: new connection", socket.id);

    // ── Configure (from lobby-server) ─────────────────────────────────────────
    socket.on("diamant:configure", ({ lobbyId, players, options }, ack) => {
        if (!lobbyId || !players?.length) return;

        let botIdx = 0;
        const room: Room = {
            lobbyId,
            options: { roundCount: options?.roundCount ?? 5, decisionDuration: options?.decisionDuration ?? 30 },
            players: new Map(
                players.map((p: { userId: string; username: string }) => {
                    const isBot = p.userId.startsWith("bot-");
                    return [p.userId, {
                        userId: p.userId, username: p.username, socketId: "",
                        handRubies: 0, safeRubies: 0, relicPoints: 0, relicsOwned: 0,
                        riskTolerance: isBot ? BOT_TOLERANCES[botIdx++ % BOT_TOLERANCES.length] : undefined,
                        inCave: false, decision: null, surrendered: false,
                    }];
                }),
            ),
            phase: "waiting", round: 1, currentGameId: randomUUID(),
            revealedCards: [], deck: [], seenDangers: new Set(),
            rubisonCards: new Map(), relicsInCave: [], relicsExited: 0,
            decisionTimer: null, decisionEndsAt: null, phaseTimer: null, finalScores: [],
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

    // ── Join ──────────────────────────────────────────────────────────────────
    socket.on("diamant:join", ({ lobbyId }) => {
        const { userId } = socket.data;
        if (!lobbyId || !userId) return;

        socket.data.lobbyId = lobbyId;
        socket.join(`room:${lobbyId}`);

        const room = getRoom(lobbyId);
        if (!room) { socket.emit("notFound"); return; }

        const player = room.players.get(userId);
        if (!player) { socket.emit("diamant:error", { message: "Player not in this game" }); return; }

        player.socketId = socket.id;

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
        emitToRoom(room, "diamant:playerSurrendered", { userId });

        if (active.length > 2) {
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
        if (player && !player.surrendered && player.inCave && player.decision === null) {
            player.decision = "leave";
            if (playersInCave(room).every((p) => p.decision !== null)) resolveDecisions(room);
        }
    });
});

// ── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 10009;
server.listen(PORT, () => console.log("[DIAMANT] realtime listening on", PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
