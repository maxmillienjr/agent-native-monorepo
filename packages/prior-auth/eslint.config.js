import base from '@repo/eslint-config';

export default [
  ...base,
  {
    // This package maps an AgentDisposition to FHIR and nothing else (P3-D).
    // The clinician's constructor belongs to P3-E's review route, so the
    // mapping cannot reach it even by accident.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@repo/determination/clinician',
              message:
                'prior-auth maps what the agent may produce. Only a clinician can deny. See P3-A.',
            },
          ],
        },
      ],
    },
  },
];
