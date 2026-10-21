# Example: CSV files into SQLite tables

`examples/csv-to-sqlite.js` loads a folder of CSV files into an existing SQLite
database whose headers don't match the column names. Code parses the files and
writes the rows. JevLang decides which table a file goes to and which column
each header fills.

## Decided

- **Two policies.** `tablePolicy` gets one file's headers, a few sample rows and
  the database's table names. It picks a table, or `none`. `columnPolicy` gets
  one header, its sample values and the chosen table's columns. It picks a
  column, or `skip`. Both are `choice` questions with `optionsFrom`, so the
  model can only answer with a table or column that exists. Any other answer
  fails validation.
- **Review instead of guessing.** A gate at 0.7 confidence escalates to
  `review`. A file is written only when its table and every header are decided
  with no escalation, and no two headers map to the same column. Otherwise
  nothing is inserted and the result lists why.
- **One transaction per file.** A failed insert rolls back that file only. An
  empty string is stored as `NULL`.
- **Headers are batched.** `evaluateMany` maps a file's headers concurrently.
  `dbAnswerCache` keeps answers in the same database (`jev_answers`). If you
  re-run the same files, the model isn't asked again.
- **Tables must already exist.** The schema comes from `sqlite_master` and
  `PRAGMA table_info`. The example doesn't create tables or infer types.
- **`evaluate` is injectable.** It defaults to `evaluateWithProvider`. Tests
  pass a function that answers from a fixture table through `policy.decide`,
  so they need no provider.

## Pieces

- `examples/csv-to-sqlite.js`: `parseCsv`, the two policies, `readSchema`,
  `ingestFile`, and a CLI: `node examples/csv-to-sqlite.js DB.sqlite FILE.csv… [--schema schema.sql]`.
- `examples/csv/`: `schema.sql` plus two CSV files with mismatched headers.
- `test/csv-to-sqlite.test.js`: a clean import, a low-confidence header that
  holds the file for review, and a file that matches no table.
