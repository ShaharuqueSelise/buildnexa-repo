import { blocksClient } from "./client";

// Deployed Blocks Functions this app calls (Development environment).
// Source code lives in web/functions/<name>; deploy with `blocks logic function save/deploy`.
export const FUNCTIONS = {
  companyPeople: "effd3557-ae9d-42ca-bd5b-4f1460024bf9",
  projects: "369dbe7b-61a5-443a-8f19-0abe7f15e0c0"
} as const;

// Every Buildnexa Function answers { ok: true, ... } or { ok: false, code, error }.
export class FunctionRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function callFunction<T>(id: string, body: Record<string, unknown>): Promise<T> {
  const result = await blocksClient.logic.functions.call<{ ok: boolean; code?: string; error?: string } & T>(id, { method: "POST", body });
  if (!result || result.ok !== true) {
    throw new FunctionRefused(result?.code ?? "FAILED", result?.error ?? "Something went wrong. Please try again.");
  }
  return result;
}
