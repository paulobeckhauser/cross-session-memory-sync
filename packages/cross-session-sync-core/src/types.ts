export interface KnowledgeNugget {
  id: string;
  fact: string;
  category: NuggetCategory;
  confidence: number;
  sourceSession: string;
  sourceChannel: string;
  createdAt: string; // ISO 8601
  supersededBy?: string;
  ttlHours?: number;
}

export type NuggetCategory =
  | "schedule"
  | "preference"
  | "decision"
  | "fact"
  | "relationship"
  | "task";

export interface TurnData {
  userMessage: string;
  assistantMessage: string;
  sessionKey: string;
  channel: string;
}

export interface ClassifiedNugget {
  fact: string;
  category: NuggetCategory;
  confidence: number;
}

export type ClassifierFn = (
  userMessage: string,
  assistantMessage: string
) => Promise<ClassifiedNugget[] | null>;

export interface SyncConfig {
  dbPath: string;
  classifierFn: ClassifierFn;
  relevanceWindowHours: number;
  maxInjectedTokens: number;
  confidenceThreshold: number;
  noiseFilterPatterns: string[];
}

export const DEFAULT_CONFIG: Omit<SyncConfig, "dbPath" | "classifierFn"> = {
  relevanceWindowHours: 24,
  maxInjectedTokens: 500,
  confidenceThreshold: 0.6,
  noiseFilterPatterns: [
    "ok",
    "lol",
    "thanks",
    "thank you",
    "haha",
    "yeah",
    "yes",
    "no",
    "sure",
    "cool",
    "nice",
    "great",
    "awesome",
    "got it",
    "sounds good",
    "👍",
    "👎",
    "🙏",
    "😂",
    "😊",
  ],
};
