import { Module } from '@nestjs/common';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { AgentModule } from '../agent/agent.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';

@Module({
  imports: [AgentModule, MemoryModule, LedgerModule],
  controllers: [RunsController],
  providers: [RunsService],
  exports: [RunsService],
})
export class RunsModule {}
