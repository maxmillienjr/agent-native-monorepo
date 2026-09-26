# Fixture capability status

Rows whose evidence no longer resolves, cited against the controls fixture tree. The docs
lint test runs the STATUS check over this file and expects every row but the last to fail.

| #   | Capability                     | Status        | Evidence at HEAD                                                               | Owner |
| --- | ------------------------------ | ------------- | ------------------------------------------------------------------------------ | ----- |
| 1   | A symbol that was renamed      | `implemented` | `controls/repo/packages/demo/src/guard.ts#guardRenamed`                        | —     |
| 2   | A test title that was reworded | `implemented` | `controls/repo/packages/demo/src/guard.test.ts#holds the line firmly`          | —     |
| 3   | A test that is skipped         | `implemented` | `controls/repo/packages/demo/src/guard.test.ts#rejects a value past the limit` | —     |
| 4   | A heading that was removed     | `implemented` | `controls/repo/docs/rule.md#The old rule`                                      | —     |
| 5   | A workflow job that is gone    | `implemented` | `controls/repo/.github/workflows/fixture.yml#audit`                            | —     |
| 6   | A JSON key that is gone        | `implemented` | `controls/repo/packages/demo/package.json#scripts.test:service`                | —     |
| 7   | A line citation                | `implemented` | `controls/repo/packages/demo/src/guard.ts:4`                                   | —     |
| 8   | A file that was deleted        | `implemented` | `controls/repo/docs/gone.md`                                                   | —     |
| 9   | A row that still resolves      | `implemented` | `controls/repo/packages/demo/src/guard.ts#guard`                               | —     |
