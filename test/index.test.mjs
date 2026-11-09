import { describe, expect, test, beforeEach } from "bun:test";
import { OpenCSGAuthPlugin, _internal } from "../index.mjs";

const { normalizeBase, toModel, DEFAULT_BASE } = _internal;

function withFetch(impl) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return impl(String(input), init);
  };
  return calls;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("地址处理", () => {
  test("空值回落到社区网关", () => {
    expect(normalizeBase("")).toBe(DEFAULT_BASE);
    expect(normalizeBase(undefined)).toBe(DEFAULT_BASE);
  });

  test("补 /v1、去尾斜杠", () => {
    expect(normalizeBase("https://hub.example.com")).toBe("https://hub.example.com/v1");
    expect(normalizeBase("https://hub.example.com/v1/")).toBe("https://hub.example.com/v1");
    expect(normalizeBase("https://hub.example.com/v2")).toBe("https://hub.example.com/v2");
  });

  test("auth.metadata.baseURL 优先于 options", async () => {
    const hooks = await OpenCSGAuthPlugin({}, { baseURL: "https://option.example.com/v1" });
    const opts = await hooks.auth.loader(() => ({
      type: "api",
      key: "k",
      metadata: { baseURL: "https://auth.example.com/v1" },
    }));
    expect(opts.baseURL).toBe("https://auth.example.com/v1");
  });
});

describe("config 钩子", () => {
  test("声明 opencsg 供应商且不覆盖已有配置", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    const cfg = {};
    await hooks.config(cfg);
    expect(cfg.provider.opencsg.name).toBe("开放传神 OpenCSG");
    expect(cfg.provider.opencsg.npm).toBe("@ai-sdk/openai-compatible");

    const existing = { provider: { opencsg: { name: "我自己改的" } } };
    await hooks.config(existing);
    expect(existing.provider.opencsg.name).toBe("我自己改的");
  });
});

describe("loader 发出的请求", () => {
  test("带上 Bearer 与网关地址", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    const calls = withFetch(() => jsonRes({ ok: true }));
    const opts = await hooks.auth.loader(() => ({ type: "api", key: "sk-test" }));
    await opts.fetch(`${opts.baseURL}/chat/completions`, { method: "POST", body: "{}" });

    expect(calls[0].url).toBe(`${DEFAULT_BASE}/chat/completions`);
    const h = new Headers(calls[0].init.headers);
    expect(h.get("authorization")).toBe("Bearer sk-test");
  });

  test("没登录时什么都不改", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    const opts = await hooks.auth.loader(() => undefined);
    expect(opts).toEqual({});
  });
});

describe("models 钩子", () => {
  test("把网关返回的列表映射成模型，去掉占位项", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    withFetch(() =>
      jsonRes({
        object: "list",
        data: [
          { id: "Qwen/Qwen3-32B", owned_by: "opencsg", context_length: 32768 },
          { id: "deepseek-ai/DeepSeek-V3", display_name: "DeepSeek V3" },
        ],
      }),
    );

    const provider = { models: { __placeholder__: { limit: { context: 131072, output: 8192 } } } };
    const models = await hooks.provider.models(provider, { auth: { type: "api", key: "k" } });

    expect(Object.keys(models)).toEqual(["Qwen/Qwen3-32B", "deepseek-ai/DeepSeek-V3"]);
    expect(models["Qwen/Qwen3-32B"].limit.context).toBe(32768);
    expect(models["deepseek-ai/DeepSeek-V3"].name).toBe("DeepSeek V3");
    expect(models.__placeholder__).toBeUndefined();
  });

  test("401 标记需要重新登录", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    withFetch(() => jsonRes({ error: "unauthorized" }, 401));
    const provider = { models: { __placeholder__: { limit: { context: 1, output: 1 } } } };

    await expect(
      hooks.provider.models(provider, { auth: { type: "api", key: "bad" } }),
    ).rejects.toMatchObject({ signIn: "expired" });
  });

  test("403（地区风控）保留原列表，不误判为失效", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    withFetch(() => new Response('{"message":"blocked by secops"}', { status: 403 }));
    const provider = { models: { __placeholder__: { limit: { context: 1, output: 1 } } } };

    const models = await hooks.provider.models(provider, { auth: { type: "api", key: "k" } });
    expect(models).toBe(provider.models);
  });

  test("空列表保留原列表", async () => {
    const hooks = await OpenCSGAuthPlugin({}, undefined);
    withFetch(() => jsonRes({ data: [] }));
    const provider = { models: { __placeholder__: { limit: { context: 1, output: 1 } } } };
    expect(await hooks.provider.models(provider, { auth: { type: "api", key: "k" } })).toBe(provider.models);
  });
});
