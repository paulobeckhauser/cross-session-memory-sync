export interface DAGNode {
  id: string;
  depth: number; // 0=raw fact, 1+=summary
  content: string;
  category?: NuggetCategory;
  confidence: number;
  sourceSession?: string; // null for summaries
  sourceChannel?: string; // null for summaries
  parentId?: string; // → parent summary node
  createdAt: string; // ISO 8601
  supersededBy?: string; // → newer conflicting fact
  isCompressed: boolean; // true = folded into a parent summary
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

export type CompressorFn = (
  facts: string[],
  depth: number
) => Promise<string>;

export interface DAGSyncConfig {
  dbPath: string;
  classifierFn: ClassifierFn;
  compressorFn: CompressorFn;
  relevanceWindowHours: number;
  maxInjectedTokens: number;
  confidenceThreshold: number;
  noiseFilterPatterns: string[];
  compressionThresholds: Record<number, number>; // depth → count threshold
  maxDepth: number;
}

export const DEFAULT_DAG_CONFIG: Omit<
  DAGSyncConfig,
  "dbPath" | "classifierFn" | "compressorFn"
> = {
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
  compressionThresholds: { 0: 20, 1: 10, 2: 5 },
  maxDepth: 4,
};
