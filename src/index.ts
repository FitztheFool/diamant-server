// diamant-server/src/index.ts
import 'dotenv/config';
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// ── Save attempts ─────────────────────────────────────────────────────────────

async function saveAttempts(gameType: string, gameId: string, scores: { userId: string; score: number; placement?: number; abandon?: boolean; afk?: boolean }[]) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}

// ── Types ─────────────────────────────────────────────────────────────────────

type CardType = "treasure" | "danger" | "relic";

interface Card {
    id: string;
    type: CardType;
    value?: number;       // Trésor : rubis
    danger?: string;      // Danger : nom du piège
}

interface Player {
    userId: string;
    username: string;
    socketId: string;
    // Rubis en main (dans la grotte, pas encore en sécurité)
    handRubies: number;
    // Rubis dans le coffre (en sécurité)
    safeRubies: number;
    // Diamants dans le coffre (valeur 5 chacun)
    safeDiamonds: number;
    // Reliques récupérées (hors grotte)
    relicsOwned: number;
    // Dans la grotte ce tour ?
    inCave: boolean;
    // Décision ce tour : "continue" | "leave" | null
    decision: "continue" | "leave" | null;
}

interface Room {
    lobbyId: string;
    options: { roundCount: number; decisionDuration: number };
    players: Map<string, Player>;
    phase: "waiting" | "playing" | "finished";
    // Manche courante (1–5)
    round: number;
    // Cartes révélées dans la manche courante
    revealedCards: Card[];
    // Pioche de la manche
    deck: Card[];
    // Dangers déjà vus cette manche (un seul par type → double = danger)
    seenDangers: Set<string>;
    // Rubis posés sur chaque carte trésor (index dans revealedCards)
    rubisonCards: Map<number, number>;
    // Reliques dans la grotte (index dans revealedCards)
    relicsInCave: number[];
    // Nombre total de reliques sorties de la grotte (pour calculer leur valeur)
    relicsExited: number;
    // Timer décision
    decisionTimer: ReturnType<typeof setTimeout> | null;
    decisionEndsAt: number | null;
    // Scores finaux (pour save DB)
    finalScores: { userId: string; username: string; score: number }[];
    // Joueur ayant abandonné (si surrender)
    surrenderUserId?: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

// ── Card helpers ──────────────────────────────────────────────────────────────

const DANGER_TYPES = ["spider", "snake", "lava", "boulder", "ram"] as const;

function buildDeck(): Card[] {
    const cards: Card[] = [];

    // 15 cartes Trésor
    const treasureValues = [1, 2, 3, 4, 5, 5, 7, 7, 9, 11, 11, 14, 15, 17, 17];
    treasureValues.forEach((v, i) => {
        cards.push({ id: `treasure-${i}`, type: "treasure", value: v });
    });

    // 15 cartes Danger (3 de chaque type)
    DANGER_TYPES.forEach((danger) => {
        for (let i = 0; i < 3; i++) {
            cards.push({ id: `danger-${danger}-${i}`, type: "danger", danger });
        }
    });

    // 5 cartes Relique
    for (let i = 0; i < 5; i++) {
        cards.push({ id: `relic-${i}`, type: "relic" });
    }

    return shuffle(cards);
}

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ── Room helpers ──────────────────────────────────────────────────────────────

function getRoom(lobbyId: string): Room | null {
    return rooms.get(lobbyId) ?? null;
}

function emitToRoom(room: Room, event: string, payload: unknown) {
    room.players.forEach((p) => {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit(event, payload);
    });
}

function emitToPlayer(room: Room, userId: string, event: string, payload: unknown) {
    const player = room.players.get(userId);
    if (!player) return;
    const s = io.sockets.sockets.get(player.socketId);
    if (s) s.emit(event, payload);
}

function buildPublicState(room: Room) {
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
            safeDiamonds: p.safeDiamonds,
            relicsOwned: p.relicsOwned,
            inCave: p.inCave,
            // Ne pas révéler la décision avant la résolution
            hasDecided: p.decision !== null,
        })),
    };
}

// ── Game flow ─────────────────────────────────────────────────────────────────

function clearDecisionTimer(room: Room) {
    if (room.decisionTimer) {
        clearTimeout(room.decisionTimer);
        room.decisionTimer = null;
    }
}

function startRound(room: Room) {
    // Réinitialiser l'état de manche
    room.deck = buildDeck();
    room.revealedCards = [];
    room.seenDangers = new Set();
    room.rubisonCards = new Map();
    room.relicsInCave = [];

    // Tous les joueurs rentrent dans la grotte
    room.players.forEach((p) => {
        p.inCave = true;
        p.handRubies = 0;
        p.decision = null;
    });

    emitToRoom(room, "diamant:roundStart", {
        round: room.round,
        totalRounds: room.options.roundCount,
        state: buildPublicState(room),
    });

    // Petite pause avant de révéler la première carte
    setTimeout(() => revealNextCard(room), 1500);
}

function playersInCave(room: Room): Player[] {
    return Array.from(room.players.values()).filter((p) => p.inCave);
}

function revealNextCard(room: Room) {
    const inCave = playersInCave(room);
    if (inCave.length === 0) {
        endRound(room, "all_left");
        return;
    }

    if (room.deck.length === 0) {
        endRound(room, "deck_empty");
        return;
    }

    const card = room.deck.pop()!;
    const cardIndex = room.revealedCards.length;
    room.revealedCards.push(card);

    if (card.type === "treasure") {
        const total = card.value!;
        const share = Math.floor(total / inCave.length);
        const remainder = total - share * inCave.length;

        inCave.forEach((p) => { p.handRubies += share; });

        // Les rubis non divisibles restent sur la carte
        room.rubisonCards.set(cardIndex, remainder);

        emitToRoom(room, "diamant:cardRevealed", {
            card,
            cardIndex,
            sharePerPlayer: share,
            remainder,
            state: buildPublicState(room),
        });

        startDecisionPhase(room);

    } else if (card.type === "danger") {
        const danger = card.danger!;

        if (room.seenDangers.has(danger)) {
            // Double danger → tout le monde sort les mains vides
            inCave.forEach((p) => { p.handRubies = 0; p.inCave = false; });

            // Retirer une des deux cartes danger du jeu (l'autre reste dans la pioche)
            room.deck = room.deck.filter((c) => c.danger !== danger || (() => { return false; })());
            // On retire exactement une carte du même danger de la pioche
            const idx = room.deck.findIndex((c) => c.danger === danger);
            if (idx !== -1) room.deck.splice(idx, 1);

            emitToRoom(room, "diamant:cardRevealed", {
                card,
                cardIndex,
                state: buildPublicState(room),
            });

            emitToRoom(room, "diamant:doubleDanger", {
                danger,
                state: buildPublicState(room),
            });

            setTimeout(() => endRound(room, "double_danger"), 2000);

        } else {
            room.seenDangers.add(danger);

            emitToRoom(room, "diamant:cardRevealed", {
                card,
                cardIndex,
                state: buildPublicState(room),
            });

            startDecisionPhase(room);
        }

    } else if (card.type === "relic") {
        room.relicsInCave.push(cardIndex);

        emitToRoom(room, "diamant:cardRevealed", {
            card,
            cardIndex,
            state: buildPublicState(room),
        });

        startDecisionPhase(room);
    }
}

function startDecisionPhase(room: Room) {
    // Remettre les décisions à null
    playersInCave(room).forEach((p) => { p.decision = null; });

    const endsAt = Date.now() + room.options.decisionDuration * 1000;
    room.decisionEndsAt = endsAt;

    emitToRoom(room, "diamant:decisionPhase", {
        endsAt,
        duration: room.options.decisionDuration,
        state: buildPublicState(room),
    });

    clearDecisionTimer(room);
    room.decisionTimer = setTimeout(() => {
        // Les joueurs sans décision rentrent au camp par défaut
        playersInCave(room).forEach((p) => {
            if (p.decision === null) p.decision = "leave";
        });
        resolveDecisions(room);
    }, room.options.decisionDuration * 1000);
}

function resolveDecisions(room: Room) {
    clearDecisionTimer(room);

    const leaving = playersInCave(room).filter((p) => p.decision === "leave");
    const staying = playersInCave(room).filter((p) => p.decision === "continue");

    if (leaving.length === 0) {
        // Tout le monde continue
        emitToRoom(room, "diamant:decisionsRevealed", {
            decisions: buildDecisionsPayload(room),
            state: buildPublicState(room),
        });
        setTimeout(() => revealNextCard(room), 1500);
        return;
    }

    // Récupérer les rubis restants sur les cartes trésor
    const totalRubisOnCards = Array.from(room.rubisonCards.values()).reduce((a, b) => a + b, 0);
    const shareFromCards = leaving.length > 0
        ? Math.floor(totalRubisOnCards / leaving.length)
        : 0;
    const leftoverRubis = totalRubisOnCards - shareFromCards * leaving.length;

    // Rubis sur les cartes → distribués aux partants à parts égales
    leaving.forEach((p) => { p.handRubies += shareFromCards; });

    // Remettre à zéro les rubis sur les cartes (sauf le reste)
    // On remet le reste sur une carte quelconque
    room.rubisonCards.clear();
    if (leftoverRubis > 0 && room.revealedCards.length > 0) {
        room.rubisonCards.set(room.revealedCards.length - 1, leftoverRubis);
    }

    // Reliques — seulement si UN SEUL joueur sort
    let relicsCollected = 0;
    if (leaving.length === 1) {
        const loner = leaving[0];
        room.relicsInCave.forEach(() => {
            const relicNumber = room.relicsExited + relicsCollected + 1;
            // Les 3 premières valent 2 diamants, les suivantes 4 diamants
            const diamonds = relicNumber <= 3 ? 2 : 4;
            loner.safeDiamonds += diamonds;
            loner.relicsOwned += 1;
            relicsCollected++;
        });
        room.relicsExited += relicsCollected;
        room.relicsInCave = [];
    }

    // Sécuriser les rubis des partants
    leaving.forEach((p) => {
        // Convertir 5 rubis en 1 diamant automatiquement
        const diamonds = Math.floor(p.handRubies / 5);
        const remainingRubies = p.handRubies % 5;
        p.safeDiamonds += diamonds;
        p.safeRubies += remainingRubies;
        p.handRubies = 0;
        p.inCave = false;
        p.decision = null;
    });

    emitToRoom(room, "diamant:decisionsRevealed", {
        decisions: buildDecisionsPayload(room),
        leavingPlayers: leaving.map((p) => ({
            userId: p.userId,
            username: p.username,
            shareFromCards: shareFromCards,
            relicsCollected,
        })),
        state: buildPublicState(room),
    });

    // Si plus personne dans la grotte → fin de manche
    if (playersInCave(room).length === 0) {
        setTimeout(() => endRound(room, "all_left"), 1500);
        return;
    }

    // Sinon continuer
    setTimeout(() => revealNextCard(room), 2000);
}

function buildDecisionsPayload(room: Room) {
    return Array.from(room.players.values()).map((p) => ({
        userId: p.userId,
        decision: p.inCave ? p.decision : "leave",
    }));
}

async function endRound(room: Room, reason: "double_danger" | "all_left" | "deck_empty") {
    clearDecisionTimer(room);

    // Les joueurs encore dans la grotte perdent leurs rubis en main
    playersInCave(room).forEach((p) => {
        p.handRubies = 0;
        p.inCave = false;
    });

    // Reliques restantes dans la grotte sont retirées du jeu
    room.relicsInCave = [];

    emitToRoom(room, "diamant:roundEnd", {
        round: room.round,
        reason,
        state: buildPublicState(room),
    });

    if (room.round >= room.options.roundCount) {
        // Fin de partie
        setTimeout(() => endGame(room), 2000);
    } else {
        room.round++;
        setTimeout(() => startRound(room), 3000);
    }
}

async function endGame(room: Room) {
    room.phase = "finished";

    // Calculer les scores finaux (rubis + diamants × 5)
    const scores = Array.from(room.players.values()).map((p) => ({
        userId: p.userId,
        username: p.username,
        score: p.safeRubies + p.safeDiamonds * 5,
        safeRubies: p.safeRubies,
        safeDiamonds: p.safeDiamonds,
        relicsOwned: p.relicsOwned,
    }));

    scores.sort((a, b) => b.score - a.score);
    room.finalScores = scores;

    emitToRoom(room, "diamant:finished", {
        scores,
        winnerId: scores[0]?.userId ?? null,
    });

    // Sauvegarder en DB via l'API Next.js
    await saveAttempts("DIAMANT", room.lobbyId, scores.map((s, i) => ({
        userId: s.userId,
        score: s.score,
        placement: i + 1,
        abandon: room.surrenderUserId === s.userId,
    })));

    // Cleanup après 5 minutes
    setTimeout(() => rooms.delete(room.lobbyId), 5 * 60 * 1000);
}

// ── Socket handlers ───────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log("diamant: new connection", socket.id);

    // ── Configure (from lobby-server) ─────────────────────────────────────────
    socket.on("diamant:configure", ({ lobbyId, players, options }, ack) => {
        if (!lobbyId || !players?.length) return;

        const room: Room = {
            lobbyId,
            options: {
                roundCount: options?.roundCount ?? 5,
                decisionDuration: options?.decisionDuration ?? 30,
            },
            players: new Map(
                players.map((p: { userId: string; username: string }) => [
                    p.userId,
                    {
                        userId: p.userId,
                        username: p.username,
                        socketId: "",
                        handRubies: 0,
                        safeRubies: 0,
                        safeDiamonds: 0,
                        relicsOwned: 0,
                        inCave: false,
                        decision: null,
                    },
                ])
            ),
            phase: "waiting",
            round: 1,
            revealedCards: [],
            deck: [],
            seenDangers: new Set(),
            rubisonCards: new Map(),
            relicsInCave: [],
            relicsExited: 0,
            decisionTimer: null,
            decisionEndsAt: null,
            finalScores: [],
        };

        rooms.set(lobbyId, room);
        console.log(`[DIAMANT] Room configured: ${lobbyId} (${players.length} players)`);

        // Race condition: joueurs qui ont rejoint avant configure → leur donner l'état
        for (const [, sock] of io.of('/').sockets) {
            if (!sock.rooms.has(`room:${lobbyId}`)) continue;
            const uid = sock.data?.userId;
            if (!uid) continue;
            const p = room.players.get(uid);
            if (!p || p.socketId !== '') continue;
            p.socketId = sock.id;
            sock.emit('diamant:joined', { phase: room.phase, state: buildPublicState(room) });
        }
        const allConnected = Array.from(room.players.values()).every(p => p.socketId !== '');
        if (allConnected && room.phase === 'waiting') {
            room.phase = 'playing';
            setTimeout(() => startRound(room), 500);
        }
        if (typeof ack === 'function') ack();
    });

    // ── Join ──────────────────────────────────────────────────────────────────
    socket.on("diamant:join", ({ lobbyId, userId, username }) => {
        if (!lobbyId || !userId) return;

        socket.data = { lobbyId, userId };
        socket.join(`room:${lobbyId}`);

        let room = getRoom(lobbyId);

        if (!room) { socket.emit('notFound'); return; }

        // Enregistrer / mettre à jour le socketId
        const player = room.players.get(userId);
        if (player) {
            player.socketId = socket.id;
        } else {
            // Joueur inconnu → refus
            socket.emit("diamant:error", { message: "Player not in this game" });
            return;
        }

        // Reconnexion en cours de partie — renvoyer l'état courant
        if (room.phase === "playing" || room.phase === "finished") {
            socket.emit("diamant:joined", {
                phase: room.phase,
                state: buildPublicState(room),
                ...(room.decisionEndsAt && room.phase === "playing"
                    ? { decisionEndsAt: room.decisionEndsAt }
                    : {}),
            });
        } else {
            socket.emit("diamant:joined", {
                phase: room.phase,
                state: buildPublicState(room),
            });
        }

        // Démarrer si tous les joueurs sont connectés
        const allConnected = Array.from(room.players.values()).every((p) => p.socketId !== "");
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
        if (!player || !player.inCave) return;
        if (player.decision !== null) return; // déjà voté

        player.decision = decision;

        // Informer les autres qu'un joueur a voté (sans révéler la décision)
        emitToRoom(room, "diamant:playerDecided", {
            userId,
            state: buildPublicState(room),
        });

        // Si tout le monde a voté → résoudre immédiatement
        const inCave = playersInCave(room);
        const allVoted = inCave.every((p) => p.decision !== null);
        if (allVoted) {
            resolveDecisions(room);
        }
    });

    // ── Surrender ─────────────────────────────────────────────────────────────
    socket.on("diamant:surrender", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId) return;
        const room = getRoom(lobbyId);
        if (!room || room.phase === "finished") return;
        room.surrenderUserId = userId;
        endGame(room);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;

        const room = getRoom(lobbyId);
        if (!room) return;

        console.log(`diamant: player ${userId} disconnected from ${lobbyId}`);

        // En jeu : voter "leave" automatiquement pour ne pas bloquer les autres
        if (room.phase === "playing") {
            const player = room.players.get(userId);
            if (player && player.inCave && player.decision === null) {
                player.decision = "leave";
                const inCave = playersInCave(room);
                const allVoted = inCave.every((p) => p.decision !== null);
                if (allVoted) resolveDecisions(room);
            }
        }
    });
});

const PORT = process.env.PORT || 10009;
server.listen(PORT, () => console.log("[DIAMANT] realtime listening on", PORT));


const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);