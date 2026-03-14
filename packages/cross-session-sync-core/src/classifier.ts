import type { ClassifiedNugget, ClassifierFn } from "./types.js";

export const CLASSIFIER_PROMPT = `You are a knowledge extraction classifier. Analyze the conversation exchange below and determine if it contains any factual knowledge worth sharing across other conversation sessions with this user.

Extract ONLY: facts, preferences, schedule changes, decisions, relationships, or tasks.
Do NOT extract: greetings, small talk, opinions about the current conversation, meta-commentary.

If the exchange contains extractable knowledge, respond with a JSON array:
[{"fact": "concise statement", "category": "schedule|preference|decision|fact|relationship|task", "confidence": 0.0-1.0}]

If nothing worth extracting, respond with: null

USER: {userMessage}
ASSISTANT: {assistantMessage}

Respond ONLY with the JSON array or null. No explanation.`;

export class Classifier {
  private classifierFn: ClassifierFn;

  constructor(classifierFn: ClassifierFn) {
    this.classifierFn = classifierFn;
  }

  async classify(
    userMessage: string,
    assistantMessage: string
  ): Promise<ClassifiedNugget[] | null> {
    try {
      return await this.classifierFn(userMessage, assistantMessage);
    } catch {
      // Graceful degradation: if classifier fails, skip extraction
      return null;
    }
  }
}
