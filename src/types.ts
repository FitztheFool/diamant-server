export type CardType = "treasure" | "danger" | "relic";

export interface Card {
    id: string;
    type: CardType;
    value?: number;
    danger?: string;
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
    revealedCards: Card[];
    deck: Card[];
    seenDangers: Set<string>;
    rubisonCards: Map<number, number>;
    relicsInCave: string[];
    relicsExited: number;
    decisionTimer: ReturnType<typeof setTimeout> | null;
    decisionEndsAt: number | null;
    phaseTimer: ReturnType<typeof setTimeout> | null;
    finalScores: { userId: string; username: string; score: number }[];
    surrenderUserId?: string;
    currentGameId?: string;
}
