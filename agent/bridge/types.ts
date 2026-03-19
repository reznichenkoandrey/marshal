import type { BrowserContext } from "playwright";

export type ReasoningBridge = {
  initialize(): Promise<void>;
  openLoginWindow(): Promise<void>;
  resetConversation(): Promise<void>;
  prime(initialPrompt: string): Promise<void>;
  ask(prompt: string): Promise<string>;
  close(): Promise<void>;
};

export type BrowserContextProvider = {
  getContext(): Promise<BrowserContext>;
};
