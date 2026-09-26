## Problem Statement

Pivloom 用户的一次普通增量被累计的全量浏览器检查阻塞，曾等待几十分钟仍得不到可信结果。最新生产 C3 已完成 43 项却因一个视觉程序异常被全部覆盖为 blocked；测试范围和初态有误、可执行断言可随重规划变化、逐键远程调用昂贵。现有机制既不能诚实保证十分钟内完成必要验收，也不适合随通用应用复杂度增长。

## Solution

交付当前 React/TypeScript 应用范围内的新验证闭环：保留真实三角色责任、可信构建与版本证据，建立稳定且可表达场景初态/作用域的测试程序，在沙箱内批量执行，按失败原因恢复同一候选；可运行候选、检查结果和发布资格分别呈现。用户可明确选择已保存候选继续开发，上一 accepted 与公开发布不被隐式覆盖。

验收阶段以统一墙钟预算收束，测量阶段从 Reviewer 开始到 Check 提交并包括环境准备、浏览器、视觉判断与结果保存。十分钟内超时/blocked不是成功。代表性、已声明支持的常规增量必须用真实运行验证完成时间；不声称任意大小应用都能十分钟全验完。工作量超限必须在执行前指出具体原因，不能静默删掉检查或把旧证据标成本轮通过。

## User Stories

1. As a builder, I want a saved runnable candidate to remain inspectable when one check is blocked, so that useful work is not discarded.
2. As a builder, I want to explicitly continue from a chosen candidate, so that a failed verification does not force regeneration from an older version.
3. As a builder, I want the current accepted and published versions preserved, so that trying a candidate does not silently replace reliable output.
4. As a user, I want clear runnable, checking, verified and blocked states, so that a Preview is not mistaken for complete acceptance.
5. As a user, I want partial completed checks retained, so that a late visual or infrastructure fault does not erase evidence.
6. As a user, I want cancelled work to stop without accepting a version, so that cancellation preserves integrity.
7. As a user, I want all verification paths to share one deadline, so that replay and model paths cannot each obtain a new full budget.
8. As a user, I want a concrete unfinished-check explanation on budget exhaustion, so that a fast failure is not sold as a successful check.
9. As a user, I want assertions about the result region, so that keypad and history text cannot cause false pass or false failure.
10. As a user, I want independent scenarios to have explicit clean state and persistence scenarios to retain their own state, so that test order does not change the verdict.
11. As a user, I want repeated real input sequences supported, so that a 21-operation requirement is executed completely.
12. As a user, I want inherited requirements and executable criteria preserved, so that a model cannot weaken a test to make a change appear successful.
13. As a user, I want malformed test programs rejected before browser work, so that known plan errors do not cost a long run.
14. As a user, I want actual controls resolved through the production entry point, so that a supported fallback is not merely a tested helper.
15. As a user, I want programs executed near the browser, so that each keystroke does not require multiple remote orchestration round trips.
16. As a user, I want real app tests and browser checks to have distinct results, so that build success or a screenshot does not prove all behavior.
17. As a user, I want retries directed at the actual failing component, so that infrastructure and test-definition errors do not trigger pointless application regeneration.
18. As a user, I want no-change duplicate checks prevented within the same candidate and test scope, so that retries require a reason or changed input.
19. As a user, I want long-running checks to be cancellable and obsolete results tied to their own version, so that I can continue safely.
20. As an operator, I want phase time, tool/model counts and verdicts persisted, so that latency and successful completion are measurable.
21. As a reviewer, I want representative tests beyond calculator and snake, so that platform changes do not hardcode two demonstrations.
22. As an interview reviewer, I want the original frozen-release matrix completed with current evidence, so that optimization does not weaken the promised acceptance.

## Implementation Decisions

- Keep Pi, OpenSandbox, existing authentication, revision/source binding, Check receipts and explicit static publication. No replacement agent framework.
- One verification deadline is owned by the production review entry point and propagated to replay, remote execution, optional model calls and finalization. Local failures preserve valid per-item results; user cancellation, ownership/version violations and lease loss remain distinct integrity failures.
- Separate requirement semantics from executable program metadata. Programs declare initial state, target scope and bounded input sequences. Existing stable programs are reused for unchanged behavior; legacy missing programs can be filled without rewriting the requirement. Changes to actual acceptance criteria are not silently allowed.
- Assertions use typed outcome checks on a defined target, with required setup validated before execution. Do not infer correctness from arbitrary whole-page text for scoped outcomes. Keep legacy schemas readable and report unsupported/ambiguous programs rather than manufacture passes.
- Execute supported deterministic programs in a trusted sandbox-side runner using existing browser capabilities. Preserve origin isolation, current observation binding, screenshots and error evidence. Measure remote command reduction, not only model-call reduction.
- Retain three-role handoffs. Reviewer is a verification module which can use deterministic execution and bounded model judgment; model presence is not required for every browser action. Preserve full required behavior accounting for the existing release contract.
- Permit explicit continuation from an owned, build-passed candidate with optimistic current-revision protection. This does not promote candidate to accepted or change published version. Restore/inspect a saved candidate under existing sandbox quota and ownership rules.
- Check result classification distinguishes app assertion failure, invalid test/setup, infrastructure failure, timeout and not-run. All stored results carry version identity and timing; stale results cannot override another revision.
- First implementation targets the current frontend runtime. Backend/API/database and native-device adapters are future extensions and are not claimed implemented by this spec.

## Testing Decisions

- Test at the real review entry point and finishReview boundary; contract validation at the public plan schema; real browser transport/program boundary; run-submission/restore HTTP interfaces and workbench user actions.
- Use existing runtime, generation, restoration and UI seams. External model/sandbox/provider substitutes are allowed for deterministic fault reproduction; such tests do not replace real-browser or real-model evidence.
- Red-green slices: partial A result survives visual failure; resolver actually invoked; unified timeout and cancellation differ; scoped assertion rejects wrong result and accepts correct result with historical text; independent initial state is order-invariant; all 21 inputs execute; inherited assertion polarity cannot silently flip; candidate continuation uses the selected source while current/published remain unchanged.
- Real browser fixtures cover calculator-like state, forms/list CRUD and a dynamic UI; capture command counts and wall clock with the same source/test inputs.
- A bounded fresh real-model increment validates full wiring; original #37 matrix remains required before claiming that release complete. No repeated 30–40 minute diagnostic runs.
- Report FAIL/BLOCKED/NOT_RUN faithfully. Full suite, typecheck, affected UI checks and two-axis code review before ready PR.

## Out of Scope

- Claiming every possible app or unbounded change is successfully verified within ten minutes.
- Removing required checks, marking old evidence as current, or closing #37 on mocks.
- Replacing the runtime stack, adding a general backend platform, mobile runtime, billing or unrelated UI redesign.

## Further Notes

Origin: user requested a complete plan, new GitHub spec/tickets and implementation in a three-hour working window on 2026-09-27. Existing research and measured production traces support the decisions. Time allowance is a work window, not evidence that implementation or acceptance has passed.

Related existing issues: #37 final release acceptance, #42 tool-budget diagnosis (title is stale), #44 verification design. Do not close or rewrite those parent issues as a substitute for this work.
