import {
  MANAGEMENT_BASE_URL,
  PAYG_KEY_RE,
  SUBSCRIPTION_KEY_RE,
  cap,
  isObj,
  num,
  round2,
  trimNum,
} from "./constants.mjs";

export function isSubscriptionKey(key) {
  return SUBSCRIPTION_KEY_RE.test(String(key ?? "").trim());
}

export function isPaygKey(key) {
  return PAYG_KEY_RE.test(String(key ?? "").trim());
}

export function isOAuth(auth) {
  return isObj(auth) && auth.type === "oauth";
}

export function keyOf(auth) {
  const a = isObj(auth) ? auth : {};
  return typeof a.key === "string" ? a.key.trim() : "";
}

export function bearerOf(auth) {
  const a = isObj(auth) ? auth : {};
  const key = keyOf(a);
  if (key) return key;
  if (a.type === "oauth" && typeof a.access === "string") return a.access.trim();
  return "";
}

export function managementKeyOf(auth) {
  const a = isObj(auth) ? auth : {};
  const meta = isObj(a.metadata) ? a.metadata : {};
  for (const k of ["managementKey", "management_key", "mgmtKey"]) {
    if (typeof meta[k] === "string" && meta[k].trim()) return meta[k].trim();
  }
  for (const k of ["managementKey", "management_key", "mgmtKey"]) {
    if (typeof a[k] === "string" && a[k].trim()) return a[k].trim();
  }
  return "";
}

export function billingKindOf(auth, options = {}) {
  const planOpt = typeof options?.plan === "string" ? options.plan.trim().toLowerCase() : "";
  if (planOpt === "payg" || planOpt === "pay-as-you-go") return "payg";
  if (["starter", "pro", "max", "ultra", "builder"].includes(planOpt)) return "builder";
  const metaPlan = typeof auth?.metadata?.plan === "string" ? auth.metadata.plan.trim().toLowerCase() : "";
  if (metaPlan === "payg") return "payg";
  if (metaPlan === "builder") return "builder";
  const key = keyOf(auth);
  if (isPaygKey(key)) return "payg";
  if (isSubscriptionKey(key)) return "builder";
  return isOAuth(auth) ? "auto" : "payg";
}

export function subscriptionToUsage(data, paygData = null) {
  const d = isObj(data) ? data : {};
  const plan = isObj(d.plan) ? d.plan : {};
  const tier = typeof plan.tier === "string" ? plan.tier.trim() : "";
  const until = typeof plan.expires_at === "string" && plan.expires_at ? plan.expires_at : undefined;

  const monthlyMax = num(d.quota_monthly?.max_flows);
  const monthlyUsd = num(d.quota_monthly?.max_value_usd);
  const windows = [];
  const addWindow = (q, name, span) => {
    if (!isObj(q)) return;
    const max = num(q.max_flows);
    const usedFlows = num(q.used_flows);
    const pct = num(q.usage_percentage);
    let used;
    if (pct !== undefined) used = round2(pct * 100);
    else if (max !== undefined && max > 0 && usedFlows !== undefined) used = round2((usedFlows / max) * 100);
    if (used === undefined && !(max !== undefined && max > 0)) return;
    windows.push({
      name,
      ...(used !== undefined ? { used } : {}),
      ...(typeof q.resets_at === "string" && q.resets_at ? { resetsAt: q.resets_at } : {}),
      span,
      ...(usedFlows !== undefined && max !== undefined
        ? { display: `${trimNum(usedFlows)} / ${trimNum(max)} Flows`, amount: usedFlows, limit: max, unit: "Flows" }
        : {}),
    });
  };
  addWindow(d.quota_5_hour, "5 hours", 5 * 3600);
  addWindow(d.quota_7_day, "7 days", 7 * 24 * 3600);

  if (monthlyMax !== undefined && monthlyMax > 0) {
    windows.push({
      name: "monthly",
      display: `${trimNum(monthlyMax)} Flows/month${monthlyUsd !== undefined ? ` ($${trimNum(monthlyUsd)})` : ""}`,
      aside: true,
    });
  }

  const totalCredits = num(paygData?.total_credits);
  const balance = totalCredits !== undefined && totalCredits > 0 ? `$${totalCredits.toFixed(2)}` : undefined;

  const resetsLeft = num(d.quota_5_hour?.remaining_resets);
  const status = typeof d.account_status === "string" ? d.account_status.trim() : "";

  const usage = {
    ...(tier ? { plan: `Builder ${cap(tier)}` } : { plan: "Builder Plan" }),
    ...(until ? { until } : {}),
    ...(balance ? { balance } : {}),
    windows,
    signIn: "kept",
    ...(resetsLeft !== undefined && resetsLeft > 0
      ? {
          resets: {
            count: resetsLeft,
            byWindow: true,
            fiveHour: resetsLeft,
            ...(until ? { until } : {}),
          },
        }
      : {}),
  };

  if (status === "suspended" || status === "banned") {
    return { ...usage, windows: [], error: `ZenMux says this account is ${status}` };
  }
  return usage;
}

export function paygToUsage(data) {
  const d = isObj(data) ? data : {};
  const total = num(d.total_credits);
  if (total === undefined) {
    return {
      plan: "Pay As You Go",
      windows: [],
      signIn: "kept",
      error: "ZenMux returned an unexpected PAYG balance payload",
    };
  }
  const topUp = num(d.top_up_credits);
  const bonus = num(d.bonus_credits);
  const windows = [];
  if (bonus !== undefined && bonus > 0) {
    windows.push({
      name: "bonus",
      display: `$${bonus.toFixed(2)} bonus + $${(topUp ?? 0).toFixed(2)} top-up`,
      aside: true,
    });
  }
  return {
    plan: "Pay As You Go",
    balance: `$${total.toFixed(2)}`,
    windows,
    signIn: "kept",
  };
}

export async function fetchManagementJson(path, managementKey, { baseUrl = MANAGEMENT_BASE_URL, fetchImpl = fetch, signal, timeoutMs = 15_000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const url = `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
  const res = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${managementKey}`,
      accept: "application/json",
    },
    signal: sig,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, ok: res.ok, body, text };
}

export async function fetchAccountUsage(auth, { managementBase = MANAGEMENT_BASE_URL, options = {}, fetchImpl = fetch, signal } = {}) {
  const kind = billingKindOf(auth, options);
  const mgmtKey = managementKeyOf(auth) || (typeof options?.managementKey === "string" ? options.managementKey.trim() : "");
  const defaultPlan = kind === "builder" ? "Builder Plan" : "Pay As You Go";
  if (!mgmtKey) {
    return {
      plan: defaultPlan,
      windows: [],
      signIn: "kept",
    };
  }

  if (kind === "payg") {
    const res = await fetchManagementJson("payg/balance", mgmtKey, { baseUrl: managementBase, fetchImpl, signal });
    if (!res.ok || res.body?.success === false) {
      const why = res.body?.message || res.body?.error?.message || `HTTP ${res.status}`;
      return { plan: "Pay As You Go", windows: [], signIn: "kept", error: `Management API: ${why}` };
    }
    return paygToUsage(res.body?.data);
  }

  if (kind === "builder") {
    const [subRes, paygRes] = await Promise.allSettled([
      fetchManagementJson("subscription/detail", mgmtKey, { baseUrl: managementBase, fetchImpl, signal }),
      fetchManagementJson("payg/balance", mgmtKey, { baseUrl: managementBase, fetchImpl, signal }),
    ]);
    if (subRes.status === "rejected") throw subRes.reason;
    const res = subRes.value;
    if (!res.ok || res.body?.success === false) {
      const why = res.body?.message || res.body?.error?.message || `HTTP ${res.status}`;
      return { plan: "Builder Plan", windows: [], signIn: "kept", error: `Management API: ${why}` };
    }
    const paygData = paygRes.status === "fulfilled" && paygRes.value.ok ? paygRes.value.body?.data : null;
    return subscriptionToUsage(res.body?.data, paygData);
  }

  // kind === "auto" (OAuth account): check both subscription and PAYG balance.
  const [subRes, paygRes] = await Promise.allSettled([
    fetchManagementJson("subscription/detail", mgmtKey, { baseUrl: managementBase, fetchImpl, signal }),
    fetchManagementJson("payg/balance", mgmtKey, { baseUrl: managementBase, fetchImpl, signal }),
  ]);
  const subOk = subRes.status === "fulfilled" && subRes.value.ok && isObj(subRes.value.body?.data);
  const paygOk = paygRes.status === "fulfilled" && paygRes.value.ok && isObj(paygRes.value.body?.data);
  const subData = subOk ? subRes.value.body.data : null;
  const paygData = paygOk ? paygRes.value.body.data : null;
  const tier = typeof subData?.plan?.tier === "string" ? subData.plan.tier.trim().toLowerCase() : "";
  if (subData && tier && tier !== "free") {
    return subscriptionToUsage(subData, paygData);
  }
  if (paygData && (num(paygData.total_credits) ?? 0) > 0) {
    return paygToUsage(paygData);
  }
  if (subData) {
    return subscriptionToUsage(subData, paygData);
  }
  return {
    plan: "ZenMux",
    windows: [],
    signIn: "kept",
    error: "Could not read subscription or PAYG balance from ZenMux Management API",
  };
}
