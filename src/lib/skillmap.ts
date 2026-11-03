export type Flow = "testcases" | "playwright" | "execution" | "ui" | "bugs";

export const FLOW_LABELS: Record<Flow, string> = {
  testcases: "2. Test cases and test data",
  execution: "4. Test execution",
  ui: "5. UI testing",
  playwright: "6. Playwright scripts",
  bugs: "7. Bug logging",
};

/** Where a skill helps, and when to pick it. A skill listed with no flows needs tools this app does not give it. */
type Fit = { flows: Flow[]; when: string; tested?: boolean };

const KNOWN: Record<string, Fit> = {
  "your skills:design-taste-frontend": { flows: [], when: "Design rules for building or restyling screens. It shaped this app's look; it does not run during a QA step." },
  "e2e-test-generator:e2e-write": { flows: ["playwright"], when: "Writing Playwright specs from test cases, for stable locators and structure.", tested: true },
  "e2e-test-generator:e2e-test-generator": { flows: ["playwright"], when: "Planning and writing end-to-end specs for a whole story." },
  "e2e-test-generator:e2e-map": { flows: [], when: "Maps pages and selectors from your app's source code. Run it in Claude Code on the app's repo." },
  "qa-bug-hunter:hunt": { flows: [], when: "Reads and runs your code to find bugs. Run it in Claude Code on the app's repo." },
  "qa-bug-hunter:qa-bug-hunter": { flows: [], when: "Reads and runs your code to find bugs. Run it in Claude Code on the app's repo." },
  "product-management:write-spec": { flows: [], when: "Writes and reviews specs. Step 1 only stores files, so no step runs it." },
  "product-management:synthesize-research": { flows: [], when: "Summarises research notes. Step 1 only stores files, so no step runs it." },
  "design:accessibility-review": { flows: ["ui"], when: "Reading a prototype for keyboard, contrast and screen reader triggers." },
  "design:design-critique": { flows: ["ui"], when: "Reading a prototype for usability and consistency issues." },
  "design:design-handoff": { flows: ["ui"], when: "Prototypes that need interaction states and edge cases spelled out." },
};

const KEYWORDS: [RegExp, Flow][] = [
  [/\bprd\b|product requirement|\btest cases?\b/i, "testcases"],
  [/\bplaywright\b|\bcypress\b/i, "playwright"],
  [/\bprototypes?\b|\bwireframes?\b/i, "ui"],
];

/** These plugins are about other work, whatever words their descriptions happen to share with a QA step. */
const NOT_QA = new Set(["your skills", "marketing", "cowork-plugin-management", "product-management", "design", "frontend-design"]);

export function fitOf(plugin: string, skill: string, description: string): Fit {
  const known = KNOWN[`${plugin}:${skill}`];
  if (known) return known;
  if (plugin === "qa-my-app") return { flows: [], when: "Runs its own browser and catalog tools. Run it in Claude Code." };
  if (NOT_QA.has(plugin)) return { flows: [], when: "Not related to a QA step here." };
  const flows = KEYWORDS.filter(([re]) => re.test(description)).map(([, f]) => f);
  return { flows: [...new Set(flows)], when: flows.length ? "Matched from the skill's own description; not tried in this app yet." : "Not related to a QA step here." };
}

/** What each connected MCP server could do for these steps. Only the bug connector is wired in today. */
export function mcpFit(name: string): { flows: Flow[]; when: string } {
  const n = name.toLowerCase();
  if (/figma|html\.to\.design/.test(n)) return { flows: [], when: "Holds designs. Export the screens and add them in step 1; reading Figma directly is not wired in." };
  if (/playwright/.test(n)) return { flows: ["ui"], when: "Same browser tool step 5 runs on its own private copy." };
  if (/jira|atlassian|linear|asana|clickup|monday|github|trello/.test(n)) return { flows: [], when: "A tracker signed in through Claude. Bug logging here needs a URL and token connector, set below." };
  return { flows: [], when: "Not used by any step." };
}
