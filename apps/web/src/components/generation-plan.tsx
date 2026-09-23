"use client";

import type { BehaviorTarget, Plan } from "@pivloom/contracts";

function Behavior({ behavior }: { behavior: BehaviorTarget }) {
  return <li><strong>{behavior.id} · {behavior.title}</strong><span className="generation-plan-required">{behavior.required ? "必需" : "可选"}</span>
    <dl><dt>开始条件</dt><dd>{behavior.precondition}</dd><dt>操作</dt><dd>{behavior.action}</dd><dt>可观察结果</dt><dd>{behavior.expected}</dd></dl>
  </li>;
}

export function GenerationPlan({ plan }: { plan: Plan }) {
  return <section className="generation-plan" aria-label="已保存目标">
    <p className="generation-plan-label">协调者 · 已保存目标</p>
    <h3>{plan.goal}</h3>
    <p>{plan.changeSummary}</p>
    {plan.outOfScope.length > 0 && <div className="generation-plan-scope" aria-label="本次范围说明">
      <strong>本次范围说明</strong><ul>{plan.outOfScope.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </div>}
    <details className="generation-plan-behaviors">
      <summary>{plan.schemaVersion === 2 ? `五组完整目标 · ${plan.behaviors.length} 项子检查` : `历史平铺目标 · ${plan.behaviors.length} 项`}</summary>
      {plan.schemaVersion === 2 ? <>
        {plan.groups.map((group) => <section className="generation-plan-group" key={group.id} aria-label={`${group.id} ${group.title}`}>
          <h4>{group.id} · {group.title} <span>{group.behaviorIds.length} 项</span></h4>
          <ol>{group.behaviorIds.map((id) => <Behavior key={id} behavior={plan.behaviors.find((item) => item.id === id)!} />)}</ol>
        </section>)}
        {plan.replacements.length > 0 && <section className="generation-plan-replacements" aria-label="明确变更记录">
          <h4>本轮明确变更</h4><ul>{plan.replacements.map((item) => <li key={item.oldBehaviorId}>
            {item.oldBehaviorId} → {item.newBehaviorId} · {item.reason} · 用户原话：“{item.userRequestQuote}”
          </li>)}</ul>
        </section>}
      </> : <ol>{plan.behaviors.map((behavior) => <Behavior key={behavior.id} behavior={behavior} />)}</ol>}
      {plan.assumptions.length > 0 && <div className="generation-plan-assumptions"><strong>采用的默认选择</strong><ul>{plan.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    </details>
  </section>;
}
