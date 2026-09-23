"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleCheck, KeyRound, LoaderCircle, Pencil, PlugZap, Plus, ShieldCheck, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { CreateModelProfileSchema, UpdateModelProfileSchema, type ModelCatalog, type ModelProfile, type ModelProtocol, type ModelTestResult } from "@pivloom/contracts";
import { getApiWorkspace, isDemoMode } from "@/lib/workspace";
import { usePrivateQuery } from "@/lib/use-workspace";
import { createModelsApi, type ModelsApi } from "@/lib/models-api";
import { errorMessage } from "@/lib/utils";
import { useUiPreferences } from "@/lib/ui-preferences";
import { AppHeader } from "./app-header";
import { AuthGate } from "./auth-gate";
import { Button } from "./ui/button";

function TestResult({ result }: { result: ModelTestResult }) {
  const ui = useUiPreferences();
  return <div className={`model-test-result ${result.status === "passed" ? "test-passed" : "test-failed"}`} role="status">
    {result.status === "passed" ? <CircleCheck size={17} /> : <TriangleAlert size={17} />}
    <div><strong>{result.status === "passed" ? ui.text("连接测试通过", "Connection test passed") : ui.text("连接测试未通过", "Connection test failed")}</strong><p>{result.message}</p>
      <div className="model-capabilities"><span>{ui.text("流式输出", "Streaming")}：{result.capabilities.streaming === "verified" ? ui.text("已验证", "Verified") : ui.text("未验证", "Unverified")}</span><span>{ui.text("工具调用", "Tool calls")}：{result.capabilities.tools === "verified" ? ui.text("已验证", "Verified") : ui.text("未验证", "Unverified")}</span><span>{ui.text("图像理解：未验证", "Vision: unverified")}</span></div>
    </div>
  </div>;
}

export function ModelProfileForm({ api, catalog, catalogError, profile, onSaved, onCancel }: { api: ModelsApi; catalog?: ModelCatalog; catalogError?: string; profile?: ModelProfile; onSaved(profile: ModelProfile, warning?: string): void; onCancel(): void }) {
  const ui = useUiPreferences();
  // Pi's catalog drives the form: pick a provider, pick one of its models, and
  // the protocol, endpoint and limits come from Pi instead of being typed by hand.
  const providers = catalog?.providers ?? [];
  const matchedProvider = profile ? providers.find((entry) => entry.baseUrl === profile.baseUrl
    && entry.models.some((model) => model.id === profile.modelId)) : undefined;
  const [catalogProviderId, setCatalogProviderId] = useState<string>(matchedProvider?.id ?? "");
  const [customModel, setCustomModel] = useState<boolean>(!!profile && !matchedProvider);
  const [name, setName] = useState(profile?.name ?? "");
  const [provider, setProvider] = useState<ModelProtocol>(profile?.provider ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? "");
  const [modelId, setModelId] = useState(profile?.modelId ?? "");
  const [apiKey, setApiKey] = useState("");
  const [isDefault, setIsDefault] = useState(profile?.isDefault ?? true);
  const [busy, setBusy] = useState<"test" | "save" | "save-test" | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ModelTestResult | null>(null);
  const [notice, setNotice] = useState("");
  const keyInput = useRef<HTMLInputElement>(null);
  function invalidateTest() { setResult(null); setNotice(""); setError(""); }
  function values() { return { name: name.trim(), provider, baseUrl: baseUrl.trim(), modelId: modelId.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), isDefault }; }
  const selectedProvider = providers.find((entry) => entry.id === catalogProviderId);
  /** Picking a provider fills the endpoint and the protocol Pi prescribes for it. */
  function chooseProvider(providerId: string) {
    setCatalogProviderId(providerId); invalidateTest();
    const entry = providers.find((candidate) => candidate.id === providerId);
    if (!entry) { setCustomModel(true); return; }
    setCustomModel(false);
    setBaseUrl(entry.baseUrl);
    const first = entry.models[0];
    if (first) { setProvider(first.api); setModelId(first.id); if (!name.trim()) setName(entry.name); }
  }
  /** Picking a model also fixes the protocol that model is served with. */
  function chooseModel(modelId: string) {
    invalidateTest(); setModelId(modelId);
    const entry = selectedProvider?.models.find((candidate) => candidate.id === modelId);
    if (entry) setProvider(entry.api);
  }
  function validationError(path: PropertyKey | undefined) {
    const names: Record<string, string> = { name: "配置名称（最多 80 字）", provider: "Provider", baseUrl: "完整 API 地址", modelId: "模型 ID（最多 160 字）", apiKey: "完整 API Key（不能使用掩码）" };
    return `请检查${names[String(path)] ?? "配置内容"}。`;
  }
  async function test() {
    if (pending.current) return;
    setError(""); setResult(null); setNotice("");
    const input = values();
    const unchanged = profile && input.name === profile.name && input.provider === profile.provider && input.baseUrl === profile.baseUrl && input.modelId === profile.modelId && !apiKey.trim();
    const parsed = CreateModelProfileSchema.safeParse(input);
    if (!unchanged && !parsed.success) {
      setError(profile && !apiKey.trim() ? "已修改的配置需要先保存，再使用已存密钥测试；也可以填入新密钥直接测试。" : validationError(parsed.error.issues[0]?.path[0])); return;
    }
    pending.current = true; setBusy("test");
    try { setResult(unchanged ? await api.testSaved(profile.id) : await api.testDraft(parsed.data!)); }
    catch (error) { setError(errorMessage(error)); }
    finally { pending.current = false; setBusy(null); }
  }
  async function save(testAfter: boolean) {
    if (pending.current) return;
    setError(""); setNotice("");
    const input = values();
    const parsed = profile ? UpdateModelProfileSchema.safeParse(input) : CreateModelProfileSchema.safeParse(input);
    if (!parsed.success) { setError(validationError(parsed.error.issues[0]?.path[0])); return; }
    pending.current = true; setBusy(testAfter ? "save-test" : "save");
    let saved: ModelProfile | undefined;
    let warning: string | undefined;
    try {
      saved = profile ? await api.update(profile.id, UpdateModelProfileSchema.parse(input)) : await api.create(CreateModelProfileSchema.parse(input));
      setApiKey("");
      if (keyInput.current) keyInput.current.value = "";
      if (testAfter) {
        try { const tested = await api.testSaved(saved.id); saved = { ...saved, lastTest: tested, capabilities: tested.capabilities }; }
        catch { warning = "配置已保存，连接测试暂时未完成。可以在配置卡片中重新测试。"; }
      }
      onSaved(saved, warning);
    } catch (error) { setError(errorMessage(error)); }
    finally { pending.current = false; setBusy(null); }
  }
  return <section className="model-form-panel" aria-labelledby="model-form-title">
    <div className="model-form-heading"><div><h2 id="model-form-title">{profile ? ui.text("编辑模型配置", "Edit model connection") : ui.text("连接你的模型", "Connect your model")}</h2><p>{ui.text("支持 OpenAI 兼容与 Anthropic 接口，使用你自己的服务和额度。", "Use your own OpenAI-compatible or Anthropic endpoint and quota.")}</p></div><button className="icon-button" aria-label={ui.text("关闭模型配置表单", "Close model form")} onClick={onCancel} disabled={!!busy}><X size={17} /></button></div>
    <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); void save(false); }}>
      <div className="model-form-grid">
        <div className="model-field"><label htmlFor="model-name">{ui.text("配置名称", "Connection name")}</label><input id="model-name" value={name} onChange={(event) => { setName(event.target.value); invalidateTest(); }} placeholder={ui.text("例如：我的方舟模型", "For example: My model")} maxLength={80} required disabled={!!busy} /></div>
        <div className="model-field"><label htmlFor="model-provider">{ui.text("服务商", "Provider")}</label><select id="model-provider" value={catalogProviderId} onChange={(event) => chooseProvider(event.target.value)} disabled={!!busy}>
          <option value="">{ui.text("自定义（未在 Pi 目录中）", "Custom provider")}</option>
          {providers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select><small>{catalogError ? ui.text(`Pi 目录加载失败：${catalogError}`, `Pi catalog unavailable: ${catalogError}`) : selectedProvider ? ui.text(`来自 Pi 目录：默认地址与模型列表已带出，只需填密钥。协议 ${selectedProvider.models[0]?.api === "anthropic-messages" ? "Anthropic Messages" : "OpenAI 兼容"}`, `From the Pi catalog. Endpoint and models are filled in; add your key. Protocol: ${selectedProvider.models[0]?.api === "anthropic-messages" ? "Anthropic Messages" : "OpenAI compatible"}.`) : ui.text("未收录的服务商按通用兼容方式运行，请自行确认模型 ID。", "Custom providers use the compatible protocol; verify the model ID yourself.")}</small></div>
        <div className="model-field model-field-wide"><label htmlFor="model-base-url">Base URL / API</label><input id="model-base-url" type="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidateTest(); }} placeholder="https://ark.cn-beijing.volces.com/api/v3" maxLength={2048} required disabled={!!busy} autoCapitalize="none" spellCheck={false} /><small>{ui.text("填写服务商的接口根地址，保留要求的 /v1 或 /api/v3 路径。", "Enter the provider endpoint, including its required /v1 or /api/v3 path.")}</small></div>
        <div className="model-field"><label htmlFor="model-id">{ui.text("模型", "Model")}</label>
          {selectedProvider && !customModel
            ? <select id="model-id" value={modelId} onChange={(event) => event.target.value === "__custom" ? (setCustomModel(true), invalidateTest()) : chooseModel(event.target.value)} disabled={!!busy}>
                {!selectedProvider.models.some((model) => model.id === modelId) && <option value={modelId}>{modelId}{ui.text("（当前配置）", " (current)")}</option>}
                {selectedProvider.models.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}{model.reasoning ? ui.text(" · 推理", " · reasoning") : ""}{model.input.includes("image") ? ui.text(" · 图像", " · vision") : ""}</option>)}
                <option value="__custom">{ui.text("自定义模型 ID…", "Custom model ID…")}</option>
              </select>
            : <input id="model-id" value={modelId} onChange={(event) => { setModelId(event.target.value); invalidateTest(); }} placeholder={ui.text("模型名称或接入点 ID", "Model name or endpoint ID")} maxLength={160} required disabled={!!busy} autoCapitalize="none" spellCheck={false} />}
        </div>
        <div className="model-field"><label htmlFor="model-api-key">API Key {profile && <span>{ui.text("（留空保留原密钥）", "(leave blank to keep your key)")}</span>}</label><input ref={keyInput} id="model-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidateTest(); }} placeholder={profile ? ui.text(`已保存 ${profile.keyMask}`, `Saved ${profile.keyMask}`) : ui.text("粘贴你的 API Key", "Paste your API key")} maxLength={4096} required={!profile} disabled={!!busy} autoComplete="new-password" autoCapitalize="none" spellCheck={false} data-1p-ignore data-lpignore="true" /><small>{ui.text("密钥提交后由服务端加密保存，前端只展示掩码。", "Your key is encrypted on the server; only a mask is shown here.")}</small></div>
      </div>
      <label className="model-default-checkbox"><input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} disabled={!!busy} />{ui.text("设为默认模型", "Set as default model")}</label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {notice && <p className="model-notice" role="status">{notice}</p>}
      {result && <TestResult result={result} />}
      <div className="model-form-footer"><p><ShieldCheck size={14} />{ui.text("测试会向服务商发送简短请求，验证流式输出与工具调用。", "A short request verifies streaming and tool calls.")}</p><div className="inline-actions"><Button type="button" variant="outline" disabled={!!busy} onClick={() => void test()}>{busy === "test" ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}{ui.text("测试连接", "Test connection")}</Button><Button type="submit" variant="secondary" disabled={!!busy}>{busy === "save" && <LoaderCircle className="spin" size={15} />}{ui.text("保存配置", "Save")}</Button><Button type="button" disabled={!!busy} onClick={() => void save(true)}>{busy === "save-test" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{ui.text("保存并测试", "Save & test")}</Button></div></div>
    </form>
  </section>;
}

function SettingsContent() {
  const ui = useUiPreferences();
  const workspace = getApiWorkspace();
  const api = useMemo(() => createModelsApi(workspace), [workspace]);
  const loader = useCallback(() => api.list(), [api]);
  const { data: profiles, error: loadError, refresh } = usePrivateQuery(loader);
  const catalogLoader = useCallback(() => api.catalog(), [api]);
  const { data: catalog, error: catalogError } = usePrivateQuery(catalogLoader);
  const [editing, setEditing] = useState<ModelProfile | "new" | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function perform(id: string, action: "test" | "default" | "delete") {
    if (pending.current) return;
    pending.current = true; setBusy(`${id}:${action}`); setError(""); setNotice("");
    try {
      if (action === "test") { const result = await api.testSaved(id); setNotice(result.status === "passed" ? "连接测试通过。" : "测试未通过，请检查下方结果并修改配置。"); }
      else if (action === "default") { await api.update(id, { isDefault: true }); setNotice("默认模型已更新。"); }
      else { await api.remove(id); setDeleting(null); setNotice("模型配置已删除。"); }
      refresh();
    } catch (error) { setError(errorMessage(error)); }
    finally { pending.current = false; setBusy(""); }
  }
  return <div className="settings-page"><AppHeader /><main className="settings-main">
    <Link href="/projects" className="settings-back"><ArrowLeft size={15} />{ui.text("返回我的项目", "Back to projects")}</Link>
    <div className="settings-title-row"><div><div className="section-eyebrow">YOUR MODELS</div><h1>{ui.text("连接你的模型", "Connect your models")}</h1><p>{ui.text("选择你熟悉的模型服务，让每个项目使用自己的配置。", "Choose your provider and keep each project connected to your models.")}</p></div><Button onClick={() => { setEditing("new"); setNotice(""); }} disabled={!!busy}><Plus size={16} />{ui.text("添加模型", "Add model")}</Button></div>
    {(error || loadError) && <div className="settings-error" role="alert"><p>{error || loadError}</p>{loadError && <Button variant="outline" onClick={refresh}>重新加载</Button>}</div>}
    {notice && <p className="model-notice" role="status">{notice}</p>}
    {editing && <ModelProfileForm key={typeof editing === "string" ? editing : `${editing.id}:${editing.configVersion}`} api={api} profile={typeof editing === "string" ? undefined : editing} catalog={catalog} catalogError={catalogError} onCancel={() => setEditing(null)} onSaved={(profile, warning) => { setEditing(null); refresh(); setNotice(warning ?? (profile.lastTest ? profile.lastTest.status === "passed" ? "模型已保存，连接测试通过。" : "模型已保存，测试未通过，请查看测试结果。" : "模型已保存。你可以随时测试连接。")); }} />}
    {!profiles && !loadError ? <div className="empty-projects" aria-label="正在加载模型配置"><LoaderCircle className="spin" size={22} /></div>
      : profiles?.length === 0 && !editing ? <div className="models-empty"><div className="models-empty-icon"><KeyRound size={25} /></div><h2>{ui.text("让 Pivloom 连接你的创造力", "Connect Pivloom to your models")}</h2><p>{ui.text("添加一个模型服务。接口地址、模型和密钥都由你掌握。", "Add a provider you control. Your endpoint and key stay yours.")}</p><Button onClick={() => setEditing("new")}><Plus size={15} />{ui.text("添加第一个模型", "Add your first model")}</Button><small>{ui.text("支持多个配置，可随时切换默认模型。", "Use multiple configurations and change the default anytime.")}</small></div>
      : <div className="models-grid">{profiles?.map((profile) => <article className="model-profile-card" key={profile.id}>
        <div className="model-profile-heading"><div className="model-icon"><PlugZap size={20} /></div><div><h2>{profile.name}</h2><span>{profile.provider === "openai-completions" ? ui.text("OpenAI 兼容", "OpenAI compatible") : "Anthropic Messages"}</span></div>{profile.isDefault && <span className="default-model-badge"><Star size={11} fill="currentColor" />{ui.text("默认", "Default")}</span>}</div>
        <dl className="model-profile-details"><div><dt>{ui.text("模型", "Model")}</dt><dd>{profile.modelId}</dd></div><div><dt>{ui.text("API 地址", "API endpoint")}</dt><dd>{profile.baseUrl}</dd></div><div><dt>{ui.text("密钥", "Key")}</dt><dd className="key-mask"><KeyRound size={12} />{profile.keyMask}</dd></div></dl>
        {profile.lastTest ? <TestResult result={profile.lastTest} /> : <p className="model-untested">{ui.text("尚未测试连接", "Connection not tested")}</p>}
        {deleting === profile.id ? <div className="model-delete-confirm" role="alert"><p>删除“{profile.name}”及其已保存的密钥？此操作无法撤销。</p><div className="inline-actions"><Button size="sm" variant="outline" disabled={!!busy} onClick={() => setDeleting(null)}>取消</Button><Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void perform(profile.id, "delete")}>{busy === `${profile.id}:delete` && <LoaderCircle className="spin" size={14} />}确认删除</Button></div></div>
          : <div className="model-card-actions"><Button size="sm" variant="outline" disabled={!!busy} onClick={() => void perform(profile.id, "test")}>{busy === `${profile.id}:test` ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}{ui.text("测试连接", "Test")}</Button><Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setEditing(profile); setError(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}><Pencil size={14} />{ui.text("编辑", "Edit")}</Button>{!profile.isDefault && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void perform(profile.id, "default")}><Star size={14} />{ui.text("设为默认", "Make default")}</Button>}<button className="icon-button model-delete" aria-label={ui.text(`删除模型 ${profile.name}`, `Delete model ${profile.name}`)} disabled={!!busy} onClick={() => setDeleting(profile.id)}><Trash2 size={15} /></button></div>}
      </article>)}</div>}
    {!!profiles?.length && <div className="settings-continue"><Button asChild variant="outline"><Link href="/projects">{ui.text("回到项目，开始创作", "Return to projects")}<ArrowRight size={16} /></Link></Button></div>}
  </main></div>;
}
export function ModelSettings() {
  if (isDemoMode) return <main className="standalone-state"><h1>模型设置在正式模式中提供</h1><Button asChild><Link href="/projects">返回演示</Link></Button></main>;
  return <AuthGate><SettingsContent /></AuthGate>;
}
