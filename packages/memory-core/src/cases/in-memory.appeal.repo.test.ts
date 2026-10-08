import { describeAppealRepositoryContract } from './appeal.repo.contract.js';
import { InMemoryAppealRepository } from './in-memory.appeal.repo.js';
import { InMemoryCaseRepository } from './in-memory.repo.js';

// The unconfigured memory axis. `test/cases.integration.test.ts` runs the same
// contract against Postgres.
describeAppealRepositoryContract('InMemoryAppealRepository', async () => {
  const cases = new InMemoryCaseRepository();
  return { cases, appeals: new InMemoryAppealRepository(cases) };
});
