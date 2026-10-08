import { Module } from '@nestjs/common';
import { SyntheticCaseBoard } from './tools/case-board.js';

/** The injection token for the case board `request-records` acts on. */
export const CASE_BOARD = Symbol('CASE_BOARD');

/**
 * One board per process, so a run's compensation reaches the request its own
 * step opened, and so an evaluation sees the board a request would.
 */
@Module({
  providers: [{ provide: CASE_BOARD, useFactory: () => new SyntheticCaseBoard() }],
  exports: [CASE_BOARD],
})
export class AgentModule {}
