// The only piece of this project that talks to an external service. Jev can
// be reached two ways — pick with JEV_PROVIDER (default "openrouter"):
//
// "openrouter" — Jev called as a model through OpenRouter's alpha Decisions
// API. VERIFIED against first-party docs:
// https://openrouter.ai/docs/guides/community/jev-tutorial
// Needs OPENROUTER_API_KEY (a normal OpenRouter key — no waitlist).
//
// "direct" — TypeSafe's own console API, no OpenRouter in the path. NOT
// verified against a first-party TypeSafe docs page (typesafe.ai/docs 404s
// as of writing) — sourced from third-party docs (jevplayground.com) only.
// Also early-access/waitlisted: most users won't have a key for this.
// Confirm the contract yourself against console.typesafe.ai before trusting
// it. Needs TYPESAFE_API_KEY.
//
// Both providers share the same request/response shape:
//
// POST <provider base URL>
// Authorization: Bearer <key>
// {
//   "model": "<provider-specific model id>",
//   "state": "<task text>",
//   "questions": {
//     "profile": {
//       "type": "choice",
//       "instructions": "...",
//       "criteria": { "<profileId>": "<description>", ... }
//     }
//   }
// }
//
// Response:
// {
//   "answers": {
//     "profile": {
//       "type": "choice",
//       "choice": "<profileId>",
//       "confidence": 0.67,
//       "probabilities": { "<profileId>": 0.78, ... }
//     }
//   },
//   "usage": { "input_tokens": ..., "output_tokens": ... }
// }

const PROVIDERS = {
  openrouter: {
    url: process.env.OPENROUTER_DECISIONS_URL || "https://openrouter.ai/api/alpha/decisions",
    keyEnvName: "OPENROUTER_API_KEY",
    model: process.env.JEV_MODEL || "~typesafe/jev-latest",
  },
  direct: {
    url: process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone",
    keyEnvName: "TYPESAFE_API_KEY",
    model: process.env.JEV_MODEL || "jev-latest",
  },
};

function activeProvider() {
  const name = process.env.JEV_PROVIDER || "openrouter";
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(
      `Unknown JEV_PROVIDER "${name}". Valid: ${Object.keys(PROVIDERS).join(", ")}`
    );
  }
  return { name, ...provider };
}

// 0.8/0.6 (the architecture doc's example) assumes a small option set. With
// N profiles, a uniform random guess only gets ~1/N confidence, so a fixed
// absolute threshold silently discards good signal as N grows — observed in
// testing: real Jev calls against 12 profiles picked sensible answers at
// 0.52-0.60 confidence and were being thrown away every time. Lower these
// as the profile count grows, or better, tune them against a real benchmark
// (architecture doc §30) rather than trusting either value long-term.
const CONFIDENCE_HIGH = Number(process.env.JEV_CONFIDENCE_HIGH ?? 0.55);
const CONFIDENCE_MEDIUM = Number(process.env.JEV_CONFIDENCE_MEDIUM ?? 0.35);

function fallbackProfile(profiles, reason) {
  // Deviates from the architecture doc's §14 "strongest" recommendation by
  // design: fallback often means "broken and staying broken" (e.g. no key
  // configured yet), and defaulting every task to the most expensive model
  // in that state is worse than a mostly-fine cheap default. Defaults to
  // the weakest profile instead — assumes profiles are generated with
  // models in strongest-first order (see DEFAULT_MODELS in each adapter)
  // and efforts in weakest-first order, so the first profile sharing the
  // last model is that model's lowest effort tier. Configurable via
  // JEV_FALLBACK_PROFILE_ID if the caller wants to pin something specific.
  const pinnedId = process.env.JEV_FALLBACK_PROFILE_ID;
  const pinned = pinnedId && profiles.find((p) => p.id === pinnedId);
  let chosen = pinned;
  if (!chosen) {
    const weakestModel = profiles[profiles.length - 1].model;
    const sameModel = profiles.filter((p) => p.model === weakestModel);
    chosen = sameModel[0];
  }
  return {
    profileId: chosen.id,
    model: chosen.model,
    effort: chosen.effort,
    confidence: null,
    source: "fallback",
    reason,
  };
}

async function callJev(task, profiles) {
  const provider = activeProvider();
  const key = process.env[provider.keyEnvName];
  if (!key) {
    return { error: "not_configured", provider: provider.name };
  }

  const criteria = Object.fromEntries(profiles.map((p) => [p.id, p.description]));
  const body = {
    model: provider.model,
    state: task,
    questions: {
      profile: {
        type: "choice",
        instructions:
          "Select the execution profile most appropriate for completing the supplied coding task. Consider implementation complexity, debugging complexity, architectural reasoning, number of files likely affected, ambiguity, and testing requirements.",
        criteria,
      },
    },
  };

  let res;
  try {
    res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { error: "network_error", detail: String(err), provider: provider.name };
  }

  if (res.status === 401 || res.status === 403) {
    return { error: "auth_error", provider: provider.name };
  }
  if (res.status === 429) {
    return { error: "rate_limited", provider: provider.name };
  }
  if (!res.ok) {
    return { error: "api_error", detail: `HTTP ${res.status}`, provider: provider.name };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { error: "invalid_response", detail: String(err), provider: provider.name };
  }

  const answer = json?.answers?.profile;
  if (!answer || typeof answer.choice !== "string") {
    return {
      error: "invalid_response",
      detail: "missing answers.profile.choice",
      provider: provider.name,
    };
  }

  return {
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    usage: json.usage,
    provider: provider.name,
  };
}

export async function decide(task, profiles) {
  if (!profiles || profiles.length === 0) {
    throw new Error("decide() requires a non-empty profiles list");
  }

  const result = await callJev(task, profiles);

  if (result.error) {
    return { ...fallbackProfile(profiles, result.error), jevProvider: result.provider };
  }

  const matched = profiles.find((p) => p.id === result.choice);
  if (!matched) {
    return {
      ...fallbackProfile(profiles, "invalid_choice"),
      jevChoice: result.choice,
      jevProvider: result.provider,
    };
  }

  const confidence = typeof result.confidence === "number" ? result.confidence : null;

  if (confidence === null || confidence < CONFIDENCE_MEDIUM) {
    return {
      ...fallbackProfile(profiles, "low_confidence"),
      jevChoice: result.choice,
      jevConfidence: confidence,
      jevProbabilities: result.probabilities,
      jevProvider: result.provider,
    };
  }

  const decision = {
    profileId: matched.id,
    model: matched.model,
    effort: matched.effort,
    confidence,
    probabilities: result.probabilities,
    source: "jev",
    jevProvider: result.provider,
  };

  if (result.usage) {
    decision.jevUsage = result.usage;
  }

  if (confidence < CONFIDENCE_HIGH) {
    decision.warning = "medium_confidence";
  }

  return decision;
}
