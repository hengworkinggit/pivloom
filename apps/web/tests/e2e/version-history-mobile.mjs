import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baseUrl = process.env.PIVLOOM_E2E_BASE_URL ?? "http://127.0.0.1:45231";
const projectId = process.env.PIVLOOM_E2E_PROJECT_ID;
const manifestPath = process.env.PIVLOOM_E2E_TEST_MANIFEST;
const fixtureUser = manifestPath
  ? JSON.parse(readFileSync(manifestPath, "utf8")).users.find((user) => user.label === "A")
  : null;
const email = process.env.PIVLOOM_E2E_EMAIL ?? fixtureUser?.email;
const password = process.env.PIVLOOM_E2E_PASSWORD ?? fixtureUser?.password;

if (!projectId || !email || !password) {
  throw new Error("Set PIVLOOM_E2E_PROJECT_ID and test credentials or PIVLOOM_E2E_TEST_MANIFEST.");
}

const session = `pivloom-version-history-mobile-${process.pid}`;
function browser(...args) {
  const result = spawnSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) {
    // Keep auth input out of the error: fill commands carry credentials in args.
    const detail = args[0] === "fill" ? "credential field could not be filled" : result.stderr.trim();
    throw new Error(`agent-browser ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

try {
  browser("open", `${baseUrl}/login`);
  browser("fill", 'input[type="email"]', email);
  browser("fill", 'input[type="password"]', password);
  browser("find", "role", "button", "click", "--name", "进入工作空间");
  browser("wait", "--url", "**/projects");
  browser("set", "viewport", "390", "844");
  browser("open", `${baseUrl}/projects/${projectId}`);

  let resultTab;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    resultTab = browser("snapshot", "-i", "-c").match(/button "结果 v\d+" \[ref=(e\d+)\]/)?.[1];
    if (resultTab) break;
    browser("wait", "250");
  }
  if (!resultTab) throw new Error("Project result tab did not load.");
  browser("click", `@${resultTab}`);
  browser("find", "text", "版本来源与对话", "click");

  const hitTest = browser("eval", `(() => {
    const history = document.querySelector(".version-history");
    const summary = [...document.querySelectorAll("summary")]
      .find((node) => node.textContent.includes("比较完整源码"));
    if (!history || !summary) return "MISSING";
    const box = summary.getBoundingClientRect();
    const container = history.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 12, box.top + box.height / 2);
    return box.bottom <= container.bottom && summary.contains(hit) ? "PASS" : "COVERED";
  })()`);
  if (hitTest !== '"PASS"') throw new Error(`Mobile compare control is not visible and hittable: ${hitTest}`);

  browser("find", "text", "比较完整源码", "click");
  const tree = browser("snapshot");
  if (!tree.includes('DisclosureTriangle "比较完整源码" [expanded=true]') || !tree.includes('combobox "从"')) {
    throw new Error("Mobile comparison controls did not open.");
  }
  if (process.env.PIVLOOM_E2E_SCREENSHOT) browser("screenshot", process.env.PIVLOOM_E2E_SCREENSHOT);
  console.log("PASS: at 390×844, version provenance and source comparison open without result-panel interception.");
} finally {
  try { browser("close"); } catch { /* best-effort cleanup */ }
}
