import { describeCaseRepositoryContract } from './case.repo.contract.js';
import { InMemoryCaseRepository } from './in-memory.repo.js';

// The unconfigured memory axis. `test/cases.integration.test.ts` runs the same
// contract against Postgres.
describeCaseRepositoryContract('InMemoryCaseRepository', async () => new InMemoryCaseRepository());
