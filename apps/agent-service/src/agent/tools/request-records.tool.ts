import { z } from 'zod';
import { DOCUMENT_KINDS, type CaseBoard } from './case-board.js';
import { defineTool } from './types.js';

export const RequestRecordsInputSchema = z
  .object({
    caseId: z.string().regex(/^PA-\d{6}$/),
    documents: z.array(z.enum(DOCUMENT_KINDS)).min(1).max(4),
    dueInDays: z.number().int().min(1).max(14),
  })
  .strict();

/**
 * The one compensable tool: a records request on a synthetic case.
 *
 * A payer really can withdraw a request for records, which is why it is
 * compensable rather than irreversible. The withdrawal is a semantic undo —
 * the provider may already have started gathering the documents — and it
 * restores the case's open-request state, not the world.
 */
export function requestRecordsTool(board: CaseBoard) {
  return defineTool({
    name: 'request-records',
    description:
      'Asks the provider on a synthetic prior-authorization case to send missing documents by a ' +
      'due date. Use when a case lacks documents needed to review it. Creates an open request on ' +
      'the case; compensated by withdrawing that request.',
    tier: 'compensable',
    input: RequestRecordsInputSchema,
    execute: (input, ctx) => board.openRequest(input, ctx.idempotencyKey),
    compensate: (_input, output, ctx) =>
      board.withdrawRequest(output.requestId, ctx.idempotencyKey),
  });
}
