# QA Workflow App

A web application that runs the 13-stage QA workflow for a web product release: intake, AI test design, review gates, environment check, smoke, three execution lanes, exploratory and non-functional stages, bug logging with a webhook to your in-house app, regression, automation runs, sign-off with twelve metrics, and post-release escapes.

Stack: Next.js 15 (App Router, server actions), Prisma 6, PostgreSQL, Claude API for test case generation.

## Setup

1. Prerequisites: Node 20+, Docker (for the bundled PostgreSQL) or any PostgreSQL 14+.
2. Copy the env file and fill it in:

       cp .env.example .env

   - `DATABASE_URL`: leave as is if you use the docker-compose database.
   - `ANTHROPIC_API_KEY`: optional. When empty, generation runs through this machine's Claude Code login, so sign in to Claude Code first. Set a key for any shared or hosted deployment, because a login belongs to one person's machine.
   - `BUG_WEBHOOK_URL` and `BUG_WEBHOOK_TOKEN`: optional, your in-house QA app endpoint. Can also be set later in Settings inside the app.
3. Start the database and the app:

       docker compose up -d
       npm install
       npm run db:push
       npm run dev

   Open http://localhost:3100.

`npm run db:push` creates the tables. For versioned migrations use `npm run db:migrate` instead. `npm run db:studio` opens Prisma Studio to inspect data.

## How the workflow maps to the app

| Stage | Where in the app | Gate |
| --- | --- | --- |
| 1 Intake | PRD and documents: store the PRD, user stories, prototype and module fields | Gate 1: every story has acceptance criteria, computed |
| 2 Test design | Test cases: load the user stories, select them, generate. Story page: generate one story, paste, or add by hand | |
| 3 Test review | Test case review: tick cases, export them to Excel, CSV or an uploaded template or mark them reviewed, export test data, flag smoke and regression | Gate 2: every case reviewed and no coverage gaps, computed |
| 4 Environment and data | Execution: the URL to test, typed above the acceptance criteria | Gate 3: the URL to test is set, computed |
| 5 Smoke | Execution: cases flagged smoke | Gate 4: smoke 100% pass, computed |
| 6 Scripted execution | Execution: UI, API, Risk lanes; AI vs Human; human-verified flag | |
| 7 Exploratory | Execution: lane Exploratory; findings become bugs | |
| 8 Non-functional | Execution: lane NFR; mark stage 8 Done on the board when axe, ZAP, k6 are green | Feeds Gate 5 |
| 9 Defect logging | Bugs: template fields enforced, reproduce-by-human rule, duplicate check, push through the MCP connector or webhook | |
| 10 Retest and regression | Bugs: Fixed, Reopened; reopen rate | |
| 11 Automation harvest | Playwright: generate and store specs from test cases, automation runs by hand or from CI import; automated flag on cases | |
| 12 Sign-off | Sign-off page: twelve metrics, Gate 5, report text | Gate 5: computed; Go is refused when not met |
| 13 Post-release | Sign-off page: escapes with the stage that missed them | |

The workflow board on each release shows all 13 stages, the five gates and their reasons, and the headline numbers.

## The flows

Each flow shows its status in the release navigation, and the 13-stage board follows them.

1. **PRD and documents.** One form and one list store the PRD, user stories, prototype and module fields, filterable by type and module. Nothing is checked or judged here and no model runs. Text is extracted at upload from PDF, DOCX, XLSX, CSV, TXT and MD. Prototype screens are read as pictures or files by Claude, so they need the Claude login. Images inside other documents and scanned PDFs are not read: a scanned PDF shows as Failed and later steps skip it until it is replaced.
2. **Test cases and test data.** Nothing is checked first and a PRD is optional. Load user stories makes one request that lists the stories in the user stories files; a PRD is never used for this, and a note shows when a user stories file changed after that. The Test case prompt section holds the instructions Claude follows when writing cases and test data; it can be edited or reset, applies to the next generation in every release, and the app always adds its own rules for reading files, numbering steps and tagging coverage. The page shows one row per file with its stories inside: tick the file to select them all, or open it and tick some. A loader shows while a run is going; afterwards only what went wrong is shown. PRDs are listed below, unticked, and a ticked PRD goes to Claude with every selected story. On first generation a story's acceptance criteria and fields are read from its files. A story whose criteria are already filled needs no file at all. The server computes what is uncovered (`src/lib/coverage.ts`), asks for those cases, and repeats until nothing is missing or progress stops. Whatever remains is reported as gaps. Each case carries the exact values to enter, and each story gets a test data sheet of valid, invalid, boundary and empty values. Add a test case by hand takes a story, a title, the criteria it covers, steps, test data and the expected result; a blank TC ID takes the story's next number. The page lists the cases created for each story. Re-running only adds what is missing and never changes existing cases; the sheet is rebuilt when cases were added. Delete selected removes the ticked stories with their cases and test data; loading again brings them back if the file still names them. When the plan limit is hit a run stops there and keeps what it finished.
3. **Test case review.** Story by story or a whole module at a time: tick the cases, then export them to Excel, CSV or an uploaded template to review outside the app, or mark them reviewed here; nothing needs approving. The whole release can also be exported from this step: test cases to Excel, CSV or an uploaded template, and test data to Excel or CSV. No model runs in this step. Every case reaches execution. Nothing is signed: Gate 2 is met once every case is reviewed and the server finds no coverage gaps.
4. **Test execution.** Enter the URL to test and, when the app needs one, a test account. Run all criteria checks every acceptance criterion of every story in one run, one story after another; Run the ones not passed carries on after a stop. Or choose a user story and press Run on one criterion or Run all of that story. No test cases are needed. Claude in Chrome opens the URL in a new tab of the user's Chrome, signs in on the app's own sign-in page when it asks, stays on that site, and checks each criterion the positive way: the normal path with valid input. Each criterion shows Pass, Fail or Blocked with what Claude saw, and can also be marked by hand. A failed criterion becomes a bug draft. A story with no criteria yet can fetch them from its user stories file with one request, and criteria can be added by hand, one per line, numbered after the story's last one. Claude in Chrome driven from Claude Code refuses localhost and private network addresses, so for those the run opens a Chrome window of its own on this machine (Playwright, the same tool as step 5), signs in there and checks the criteria. The run needs Chrome open with the extension signed in to the same account as Claude Code; when it is not connected or a site is not allowed, the run stops and says so. The URL and sign-in are kept for the release; the password is never shown again and is sent to Claude with each run, so use a test account.
5. **UI testing.** Using the prototype from step 1 (PNG, JPG, WEBP, HTML or SVG, one file per screen), the app opens each screen of the URL to test (the same URL and test account as step 4) in a hidden Chrome on this machine, signs in on the app's own sign-in page when a password field shows, and compares it with the prototype using free, open-source tools only, so no Claude plan is used. Playwright draws both pages at the same width (1440 unless another is chosen; a picture prototype keeps its own size, and a 2x or 3x export counts as the same design), and pixelmatch, the pixel check Playwright itself uses, counts the changed pixels and draws them in red. At most 0.5% changed is a Match. For an HTML prototype every text on both pages is compared as well: missing, extra or reworded, and for the same text its colour, background, font, size and place; table cells and numbers are sample data and do not count. Give a screen's page, or leave it blank and the app follows a link named like the screen. Compare one screen, all of them, or those not matching. The prototype, the app and the changed pixels stay side by side, and a Mismatch becomes a bug draft. A PDF prototype cannot be compared pixel by pixel. Without a test account a screen behind a login reads as Blocked. Each screen can also be marked by hand. Further down, Find triggers lists every action a user can take on each screen and Run UI test tries each one; those two use Claude.
6. **Playwright.** Writes one spec per story from its step 2 test cases (split every 20 cases), checks that it parses, and stores it. Run the scripts here runs every stored spec with Playwright Test in a hidden Chrome on step 4's URL to test, signed in with step 4's test account (passed to the scripts as QA_USER and QA_PASSWORD), then records each result on its test case and adds the run to Recent runs. Test titles start with the TC ID, so results posted to `/api/import/playwright` map back to the case. The scripts have not seen the running application, so lines marked `// VERIFY` need checking on the first run.
7. **Bugs and reports.** Failed cases and failed triggers become drafts. A person confirms a draft (reproducing it unless it is Low), which logs the bug and sends it through the chosen connection. Send report sends the pass and fail result of every case on the latest build through the MCP connector.

## Connections per flow

Settings lists what Claude Code has connected: which skills fit which step, which plugins are enabled, and the state of each MCP server. Each flow picks its own connection there or on its page. A picker offers only skills that fit that step; the mapping is in `src/lib/skillmap.ts`.

- **Claude:** `ANTHROPIC_API_KEY` if set, otherwise this machine's Claude Code login.
- **Claude plugin skills:** Claude follows the skill using your login. Skills get no shell or write tools here, so skills that need them are listed as not used by a step.
- **ChatGPT:** through the Codex CLI after `npm i -g @openai/codex` and `codex login`.
- **Chrome extension (execution only):** needs Claude in Chrome connected. A run stays on the build's QA URL and marks results as AI, so P1 cases still need a person to verify.
- **MCP connector (bugs only):** a Streamable HTTP MCP server with an optional bearer token. Connect in Settings, choose one tool for bugs and one for the report, and adjust their argument templates. Servers that require a browser OAuth sign-in are not supported.

## CI integration

Playwright JSON reporter:

    npx playwright test --reporter=json > results.json
    curl -X POST http://localhost:3100/api/import/playwright \
      -H "Content-Type: application/json" -H "X-Release: Sprint 24" -H "X-Build: 1.24.3" \
      -H "X-Import-Token: $IMPORT_TOKEN" --data-binary @results.json

Newman:

    newman run collection.json -e qa.json -r json --reporter-json-export newman.json
    curl -X POST http://localhost:3100/api/import/newman \
      -H "Content-Type: application/json" -H "X-Release: Sprint 24" -H "X-Build: 1.24.3" \
      -H "X-Import-Token: $IMPORT_TOKEN" --data-binary @newman.json

Each import records an automation run (used for the stability metric). If `X-Build` is given and a test title contains a TC ID (for example `PAY-VR-203-004 submits a payment`), that case's execution on the build is marked Pass or Fail, executed by AI, and the case is flagged automated.

## Bug webhook

Every logged bug is POSTed as JSON to `BUG_WEBHOOK_URL` with an optional bearer token. The payload shape is shown on the Settings page. Failed pushes can be resent from the bug list.

## Thresholds

Edit `src/lib/workflow.ts` to change: P1 pass rate (95%), automation stability (95% over last 10 runs), automation coverage of P1 regression (80%), reopen rate max (10%), mean time to fix Critical/High (24 h).

## Notes

- No login is built in. Run it inside your network or put it behind your existing SSO or reverse-proxy auth.
- Nothing connects to any external tool automatically. Claude, the webhook and the CI imports are each off until you provide the key, URL or token.
- The app was built and compiled in a sandbox without network access to Prisma's engine downloads, so `npm run build` was not executed end to end there. Run `npm install && npm run build` once locally; if a type error appears in a Prisma call, it will be a one-line fix and the file and line are printed.
