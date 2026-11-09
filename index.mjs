/**
 * opencode-opencsg-auth
 *
 * 开放传神（OpenCSG / 传神社区）AI 网关的 provider 插件，OpenCode v1 插件形式，
 * magpie 直接可用。网关是 OpenAI 兼容的 chat completions 接口，
 * 模型列表通过 GET {base}/models 动态发现。
 *
 * 文档：https://www.opencsg.com/docs/csghub/101/function/aigateway/model_access
 */

const PROVIDER = "opencsg";
const DEFAULT_BASE = "https://ai.space.opencsg.com/v1";

/** 去掉尾部斜杠；用户填了不带 /v1 的地址时补上，省得每个人踩一次 */
function normalizeBase(url) {
  let base = String(url || "").trim();
  if (!base) return DEFAULT_BASE;
  base = base.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(base)) base = `${base}/v1`;
  return base;
}

function baseOf(auth, options) {
  return normalizeBase(auth?.metadata?.baseURL || options?.baseURL || DEFAULT_BASE);
}

/** 网关返回的模型条目 -> OpenCode 的 Model */
function toModel(raw, fallback) {
  const id = raw?.id ?? raw?.name;
  const ctx =
    raw?.context_length ?? raw?.context_window ?? raw?.max_context_length ?? fallback.limit.context;
  const out =
    raw?.max_output_tokens ?? raw?.max_tokens ?? raw?.max_completion_tokens ?? fallback.limit.output;
  const modalities = raw?.modalities?.input ?? raw?.input_modalities;
  return {
    ...fallback,
    name: raw?.display_name ?? raw?.label ?? id,
    limit: { context: Number(ctx) || fallback.limit.context, output: Number(out) || fallback.limit.output },
    ...(Array.isArray(modalities) ? { modalities: { input: modalities } } : {}),
  };
}

export const OpenCSGAuthPlugin = async ({ client }, options) => ({
  // 还没人登录时也要有供应商，否则登录入口不出现
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "开放传神 OpenCSG",
      npm: "@ai-sdk/openai-compatible", // chat completions
      api: DEFAULT_BASE,
      models: {
        // 占位：models 钩子会用网关返回的列表整体替换。隐藏起来，不在选择器里露脸。
        "__placeholder__": {
          name: "OpenCSG",
          disabled: true,
          limit: { context: 131072, output: 8192 },
        },
      },
    };
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "api",
        label: "OpenCSG API Key",
        placeholder: "在 传神社区 → 设置 → API Keys 创建",
        prompts: [
          {
            type: "text",
            key: "baseURL",
            message: "网关地址（社区版直接回车；自部署填自己的，如 https://hub.example.com/v1）",
            placeholder: DEFAULT_BASE,
            validate: (v) => (!v || /^https?:\/\//i.test(v) ? undefined : "以 http:// 或 https:// 开头"),
          },
        ],
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api") return {};
      const baseURL = baseOf(auth, options);
      return {
        baseURL,
        async fetch(input, init) {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${auth.key}`);
          if (!headers.has("accept")) headers.set("accept", "application/json");
          return fetch(input, { ...init, headers });
        },
      };
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api") return provider.models;

      const base = baseOf(auth, options);
      let res;
      try {
        res = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${auth.key}`, accept: "application/json" },
        });
      } catch (err) {
        // 网络问题：保留原列表，别把供应商从界面上抹掉
        console.error(`opencsg: 拉取模型列表失败：${err?.message ?? err}`);
        return provider.models;
      }

      if (res.status === 401) {
        const e = new Error("OpenCSG 拒绝了这把 key（401），请重新登录");
        e.signIn = "expired";
        throw e;
      }
      if (!res.ok) {
        // 403 在社区网关上常见于地区/IP 风控（"blocked by secops"），不当成登录失效
        const text = await res.text().catch(() => "");
        console.error(`opencsg: /models 返回 ${res.status} ${text.slice(0, 160)}`);
        return provider.models;
      }

      const body = await res.json().catch(() => null);
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      if (!list.length) return provider.models;

      const fallback = provider.models?.__placeholder__ ?? {
        name: "OpenCSG",
        limit: { context: 131072, output: 8192 },
      };
      const models = {};
      for (const raw of list) {
        const id = raw?.id ?? raw?.name;
        if (!id) continue;
        models[id] = toModel(raw, fallback);
      }
      return Object.keys(models).length ? models : provider.models;
    },
  },
});

// 测试用；不要在入口文件导出裸函数，magpie 会把每个导出函数都当插件
export const _internal = { normalizeBase, baseOf, toModel, PROVIDER, DEFAULT_BASE };
