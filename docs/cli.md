# Checking a mod from the command line

`cosmoteer-rules-lint` runs the checks of the Cosmoteer Rules editor without an editor, so a build
can fail on what an author would otherwise only see after opening the file. It is the same code: the
command starts the language server the extension ships, opens your mod as a workspace, and collects
what the server publishes. A rule that fires in the editor fires here, with the same message and the
same severity.

It answers two different questions.

- **What is wrong with this mod?** The default. Every finding is listed, and the run fails on the
  severity you choose.
- **Does the game load this mod at all?** `--assert-loads`. One verdict per manifest action, and an
  exit code a build gate can read.

## Installing it

```bash
npx cosmoteer-rules-lint path/to/my-mod
```

That fetches the package for the run and forgets it again. To keep it around:

```bash
npm install --global cosmoteer-rules-lint
cosmoteer-rules-lint path/to/my-mod
```

Every release also attaches `cosmoteer-rules-lint-<version>.tar.gz`, for a machine that should not
reach the registry. Unpack it anywhere and start it by path:

```bash
node cosmoteer-rules-lint/cli/lint.mjs path/to/my-mod
```

Node 20 or newer. The command carries the server bundle with it, so nothing else is installed.

## What it needs

The check reads the game's own `Data` tree, because most of what an author gets wrong is a reference
into it. A Steam install is found on its own, `COSMOTEER_GAME` or `COSMOTEER_DATA_DIR` are read
before that search, and `--game` beats both:

```bash
cosmoteer-rules-lint my-mod --game "D:/Steam/steamapps/common/Cosmoteer"
```

The path has to end with `Data`, `Cosmoteer` or the Steam library's `common`.

Without the game the run stops with exit code 3, because the alternative is far worse than no
result: every reference and asset path into `Data` reads as missing, and seven rules cannot run at
all. `--no-require-game` accepts that anyway and `--no-game` skips the search outright, and both
runs say in the report which rules went dark. A SARIF or GitHub report from such a run is refused
unless you also pass `--force`, so a weakened result cannot quietly become a repository's code
scanning history.

The game's data cannot be copied into a build service, so a hosted runner needs Cosmoteer installed
on it. In practice that means a self-hosted runner, or running the check where the mod is authored.

## Reading the report

```
wired/part.rules
  5:2  error  syntax-and-references  Duplicate field "A"

Findings by rule
  syntax-and-references                2  Values and references

Checked 3 files in 2.3 s.
2 errors, 0 warnings, 0 notes, 0 hints.
2 findings reached the error level.
```

`--format json` writes the same run as an object with a `run`, a `summary` and a `findings` array,
each finding carrying its path, rule id, severity, message and range. It holds no timestamp and no
duration, so two runs over unchanged files produce the same bytes and a drift check is a diff.

`--format sarif` writes SARIF 2.1.0 for a code scanning upload, and `--format github` writes
workflow annotations that land on the changed lines of a pull request. Both default to reporting
warnings and above, since a hint on every file is noise in that setting. `--out <file>` writes to a
file instead of standard output.

## Choosing what is reported

Every rule has an id, and wherever a setting switches a check off in the editor the id is that
setting's key, so the two never drift apart. `cosmoteer-rules-lint --help` prints the full list.

```bash
# only the rules that decide whether the game can read the file at all
cosmoteer-rules-lint my-mod --rule parse-error --rule syntax-and-references

# everything except the two that are a matter of taste
cosmoteer-rules-lint my-mod --no-rule validateRedundantSeparators --no-rule validateDefaultValues

# report everything, fail on nothing, for a first look at an old mod
cosmoteer-rules-lint my-mod --fail-on none
```

`--min-severity` drops the quieter findings from the report, and `--fail-on` decides which of the
ones that remain make the run fail. They are separate on purpose: a report can carry hints while the
gate only fails on errors.

By default the run checks the files the game actually loads through the manifest. `--scope allFiles`
checks every file in the folder instead, including the ones nothing pulls in, which is what you want
while a mod is being built up.

## Does the mod load

```bash
cosmoteer-rules-lint my-mod --assert-loads
```

This is a narrower question with a harder answer. The game applies a mod's manifest actions before
it reads anything, and an action whose target does not resolve throws where the loader cannot
recover, so the game stops at its error box with the mod unloaded. The check judges each action and
says `loads`, `fails` or `unknown`.

`unknown` is the part that matters. Some shapes cannot be judged from the files alone, an `AddBase`
that inserts at an index among them, and a check that counted those as a pass would be worse than no
check. They are named in the report and the run ends with exit code 6, which `--allow-unverifiable`
lowers back to 0 once you have read them.

## Exit codes

The exit code is the whole product of a gate run, so each one means a single thing.

| Code | Meaning |
|------|---------|
| 0 | The scan finished and nothing reached the level `--fail-on` names, or the mod loads. |
| 1 | Something reached that level, or something stops the mod loading. |
| 2 | The command line could not be understood. |
| 3 | The game's data was required and could not be used. |
| 4 | The scan did not finish. |
| 5 | The report could not be written. |
| 6 | The load check found nothing that fails and could not judge everything it found. |

## In a workflow

```yaml
- name: Check the mod
  run: npx cosmoteer-rules-lint . --game "$COSMOTEER_HOME" --format github

- name: Check the game can load it
  run: npx cosmoteer-rules-lint . --assert-loads --game "$COSMOTEER_HOME"
```

For code scanning, write SARIF and let the run itself pass:

```yaml
- run: npx cosmoteer-rules-lint . --game "$COSMOTEER_HOME" --format sarif --out lint.sarif --fail-on none --quiet
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: lint.sarif
```

`--quiet` keeps progress off the error stream, which is worth it in a log nobody watches live.

All three of those read the game's data, so they belong on a runner that has Cosmoteer installed. A
hosted runner does not, and the run has to say so rather than pretend:

```yaml
- name: Check what can be checked without the game
  run: npx cosmoteer-rules-lint . --no-game --min-severity error --quiet
```

What survives such a run is everything decided by the file itself: a parse error, a duplicate key, a
circular inheritance, a nameless block, an unterminated comment and the schema. What cannot is
anything that resolves into the game's files, and worse, a reference into them now reads as
unresolved. Those reports are warnings, so the default fail level already passes over them, and the
severity floor above keeps them out of the printed report. The floor hides real warnings with them,
such as a missing separator, so a project that wants those back lowers it and reads the reference
warnings as noise. A SARIF or GitHub report from a run like this is refused unless you also pass
`--force`, which is deliberate: a weakened result should not become a repository's code scanning
history.

## Runs after the first one

The server keeps its indexes on disk between runs, so a second run over the same mod is much faster
than the first. `--no-cache` gives a run a private cache directory that nothing before it has
touched, which is the only honest way to compare two runs or to prove a finding is not an artefact
of state left behind. `--timeout <seconds>` gives up on a scan that runs long, and answers with exit
code 4 rather than hanging a build.
