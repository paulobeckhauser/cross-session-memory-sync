import type { ClassifiedNugget, ClassifierFn } from "./types.js";

export const CLASSIFIER_PROMPT = `You are a knowledge extraction classifier. Analyze the conversation exchange below and determine if it contains any PERSONAL knowledge about the user worth sharing across other conversation sessions.

Extract ONLY knowledge that is SPECIFIC TO THE USER:
- schedule: meetings, appointments, deadlines the user has ("Dentist appointment on Friday at 3pm")
- preference: personal preferences ("I prefer dark mode", "My favorite color is blue")
- decision: choices the user made ("I decided to use React for the project")
- fact: personal facts about the user ("I live in Berlin", "My dog's name is Bidu")
- relationship: people the user knows ("My sister's name is Maria", "John is my manager")
- task: things the user needs to do ("I need to buy groceries", "Remind me to call the bank")

IMPORTANT: Preserve ALL specific details — times, dates, locations, names, amounts. For updates or corrections (e.g. "actually it's at 4pm"), extract the UPDATED fact with the corrected details (e.g. "Dentist appointment on Friday at 4pm"), not just the change.

Do NOT extract:
- General knowledge ("The capital of France is Paris", "Python is a programming language")
- Greetings, small talk, jokes, or casual conversation
- Opinions about the current conversation or meta-commentary
- Information the assistant provided that the user didn't confirm or state themselves
- Facts that ONLY appear in the assistant's response when the user is asking a question (e.g., user asks "What's my dog's name?" and assistant answers "Bidu" — do NOT re-extract "dog's name is Bidu" since the user was querying, not stating new information)
- Trivial or ephemeral statements ("ok", "thanks", "lol")

Confidence scoring guidelines:
- 0.9-1.0: User explicitly states a clear personal fact ("My meeting is on Thursday at 3pm")
- 0.7-0.8: Fact is implied or somewhat ambiguous ("I think I'll go with the blue one")
- 0.5-0.6: Weak signal, might not be worth sharing ("maybe Thursday works")
- Below 0.5: Do not extract

If the exchange contains extractable personal knowledge, respond with a JSON array:
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
