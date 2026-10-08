import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { GameLeaderboard } from "../types";

export type GameSidebarData = {
	title: string;
	loading: boolean;
	error: string;
	board: GameLeaderboard | null;
	note: string;
};

type GameSidebarSlot = {
	data: GameSidebarData | null;
	setData: (value: GameSidebarData | null) => void;
};

const GameSidebarContext = createContext<GameSidebarSlot | null>(null);

export function GameSidebarProvider({ children }: { children: ReactNode }) {
	const [data, setData] = useState<GameSidebarData | null>(null);
	const value = useMemo(() => ({ data, setData }), [data]);
	return <GameSidebarContext.Provider value={value}>{children}</GameSidebarContext.Provider>;
}

export function useGameSidebar() {
	return useContext(GameSidebarContext);
}
