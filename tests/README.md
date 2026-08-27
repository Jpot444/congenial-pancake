# Tests

Fifty suites, each one driving a real browser against a real portal. They
exist because almost every bug in this app has been a behaviour bug rather
than a crash — captions arriving five minutes late, audio four seconds out
after a resume, a Save button that saved nothing — and none of those show up
in a type checker.

## Running them

```sh
npm install --no-save playwright && npx playwright install chromium

./tests/run.sh                  # all fifty
./tests/run.sh home titles      # just those
PORT=8499 ./tests/run.sh        # if 8481 is taken
```

`run.sh` stands up its own portal on port 8481, out of a scratch directory,
with a throwaway config and profile and no provider. Nothing it does touches
the live box, its downloads, or its watch history. It stops the server again
when it finishes.

The whole set takes about fifteen minutes. Halves are often enough while
working:

```sh
./tests/run.sh $(ls tests/*.test.js | head -25 | xargs -n1 basename)
./tests/run.sh $(ls tests/*.test.js | tail -25 | xargs -n1 basename)
```

## What they read

Most suites lift the shipped source and evaluate it — `ffmpegArgs` out of
`server.js`, `audioFilter`, `cleanTitle`, the drift maths — so the thing
under test is the thing that ships rather than a copy of it that can drift
away from it. `paths.js` finds the repo; `playwright.js` finds playwright.
Neither has an absolute path baked in, which is what stopped these running
anywhere but the container they were written in.

## Two things that will waste an hour if you do not know them

**Something else on port 8481.** A stray server from an earlier run answers
just as happily as ours, and the suites cannot tell the difference — they
report failures against a box nobody meant to test. `run.sh` refuses to start
if the port is busy, which is the only reason that is not still happening.

**The walkthrough.** A brand-new profile gets the one-time tour, and that
overlay sits over the whole page, so every suite that hovers or clicks fails
on a fresh box while passing on a used one. `run.sh` marks it seen through
the prefs API — writing it into `profiles.json` does not work, because the
box normalises unknown fields straight back out of that file.

## Writing one

Follow the shape of an existing suite. The conventions that matter:

- **Name the check after the behaviour, not the code.** `ok  the French film
  turns up, accent and all, from an unaccented query` tells you what broke.
  `ok  test rankedMatches` does not.
- **Say why in a comment, with the report or the complaint that prompted it.**
  Half of these exist because of one sentence from somebody watching
  something, and that sentence is the specification.
- **Pin the fix, not the implementation.** Several suites have been rewritten
  because they pinned a regex or a call signature that changed for good
  reasons, and each rewrite was time spent on nothing.
- **Make it pass twice in a row.** `series.test.js` played episodes and so
  poisoned its own next run through the last-watched season; it passed on a
  clean box and failed on a used one, which is the worst way to be wrong.
