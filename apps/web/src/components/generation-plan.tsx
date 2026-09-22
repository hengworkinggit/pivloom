"use client";

import type { Plan } from "@pivloom/contracts";

export function GenerationPlan({ plan }: { plan: Plan }) {
  return <section className="generation-plan" aria-label="已保存目标">
    <p className="generation-plan-label">协调者 · 已保存目标</p>
    <h3>{plan.goal}</h3>
    <p>{plan.changeSummary}</p>
    {plan.outOfScope.length > 0 && <div className="generation-plan-scope" aria-label="本次范围说明">
      <strong>本次范围说明</strong><ul>{plan.outOfScope.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    <details className="generation-plan-behaviors">
      <summary>查看 {plan.behaviors.length} 个行为目标</summary>
      <ol>{plan.behaviors.map((behavior) => <li key={behavior.id}>
        <strong>{behavior.title}</strong><span className="generation-plan-required">{behavior.required ? "必需" : "可选"}</span>
        <dl><dt>开始条件</dt><dd>{behavior.precondition}</dd><dt>操作</dt><dd>{behavior.action}</dd><dt>可观察结果</dt><dd>{behavior.expected}</dd></dl>
      </li>)}</ol>
      {plan.assumptions.length > 0 && <div className="generation-plan-assumptions"><strong>采用的默认选择</strong><ul>{plan.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    </details>
  </section>;
}
