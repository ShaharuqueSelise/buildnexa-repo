import { blocksClient } from "./client";

// Deployed Blocks Functions this app calls (Development environment).
// Source code lives in web/functions/<name>; deploy with `blocks logic function save/deploy`.
export const FUNCTIONS = {
  companyPeople: "effd3557-ae9d-42ca-bd5b-4f1460024bf9",
  projects: "369dbe7b-61a5-443a-8f19-0abe7f15e0c0",
  platform: "fcf68e44-aa63-4306-8429-551fce3d8467",
  rfis: "d19216d3-7925-4aa1-bff6-cae9853b0ab0",
  documents: "7aa5c9d4-5ce6-486a-8df3-87d42db341d3",
  photos: "17490b4f-03f8-4e97-91e5-c51401347723",
  drawings: "7c0a2741-b718-4e22-9143-4722044e442e",
  punch: "7781b02d-b33f-4d45-94e8-af4b04417c1a",
  dailyLogs: "c569204e-e924-4ea2-91fa-4e78829da33d"
} as const;

// Every Buildnexa Function answers { ok: true, ... } or { ok: false, code, error }.
export class FunctionRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// How long the app waits for a queued run. The run itself is capped at 30 s by Blocks, but on a busy
// day a run can sit in the Blocks queue for over a minute first (seen 2026-11-24: 55-70 s), and the
// SDK's default of 60 s then shows "still QUEUED" although the run finishes a moment later.
const QUEUE_WAIT_MS = 150_000;

export async function callFunction<T>(id: string, body: Record<string, unknown>): Promise<T> {
  const result = await blocksClient.logic.functions.call<{ ok: boolean; code?: string; error?: string } & T>(id, { method: "POST", body, timeoutMs: QUEUE_WAIT_MS });
  if (!result || result.ok !== true) {
    throw new FunctionRefused(result?.code ?? "FAILED", result?.error ?? "Something went wrong. Please try again.");
  }
  return result;
}
