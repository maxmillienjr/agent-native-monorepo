import { z } from 'zod';
import { UuidSchema, MessageSchema } from '@repo/shared-types';

/**
 * There is no `hopDepth`. It bounded the graph traversal in retrieval, and
 * ADR 0009 made retrieval vector-only, so nothing would read it. An old client
 * that still sends one has it stripped, like any other unknown key.
 */
export const RunRequestConfigSchema = z.object({
  maxSteps: z.number().int().positive().default(10),
  topK: z.number().int().positive().default(10),
});
export type RunRequestConfig = z.infer<typeof RunRequestConfigSchema>;

export const RunRequestSchema = z.object({
  sessionId: UuidSchema,
  messages: z.array(MessageSchema).min(1),
  config: RunRequestConfigSchema.optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;
