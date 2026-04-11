export type DangerType = "spider" | "fireball" | "mummy" | "landslide" | "snake";

export interface Card {
    id: string;
    type: "treasure" | "danger" | "relic";
    value?: number;
    danger?: DangerType;
}

export interface Player {
    userId: string;
    username: string;
    socketId: string;
    handRubies: number;
    safeRubies: number;
    relicPoints: number;
    relicsOwned: number;
    inCave: boolean;
    decision: "continue" | "leave" | null;
    surrendered: boolean;
    riskTolerance?: number;
}

export interface Room {
    lobbyId: string;
    options: { roundCount: number; decisionDuration: number };
    players: Map<string, Player>;
    phase: "waiting" | "playing" | "finished";
    round: number;
    currentGameId: string | null;
    revealedCards: Card[];
    deck: Card[];
    seenDangers: Set<DangerType>;
    rubisonCards: Map<number, number>;
    relicsInCave: string[];
    relicsExited: number;
    decisionTimer: ReturnType<typeof setTimeout> | null;
    decisionEndsAt: number | null;
    phaseTimer: ReturnType<typeof setTimeout> | null;
    finalScores: { userId: string; username: string; score: number }[];
    surrenderUserId?: string;
}
