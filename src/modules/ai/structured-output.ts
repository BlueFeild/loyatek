import type { z } from "zod";
import { ServiceUnavailableError } from "../../core/errors";

export const UNEXPECTED_AI_ANSWER = "The AI returned an unexpected answer — please try again.";

// رد المزوّد (نص JSON) ← بيانات متأكدين من شكلها، وإلا 503 "حاول تاني"
export function parseStructured<S extends z.ZodTypeAny>(schema: S, text: string | undefined): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    throw new ServiceUnavailableError(UNEXPECTED_AI_ANSWER);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ServiceUnavailableError(UNEXPECTED_AI_ANSWER);
  return parsed.data;
}
