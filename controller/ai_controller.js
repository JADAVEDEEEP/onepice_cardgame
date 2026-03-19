const PROVIDERS = {
  openai: {
    label: "OpenAI",
    envKeyName: "OPENAI_API_KEY",
    apiKey: process.env.OPENAI_API_KEY || "",
    url: "https://api.openai.com/v1/chat/completions",
    defaultModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    extraHeaders: {},
  },
  groq: {
    label: "Groq",
    envKeyName: "GROQ_API_KEY",
    apiKey: process.env.GROQ_API_KEY || "",
    url: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    extraHeaders: {},
  },
  openrouter: {
    label: "OpenRouter",
    envKeyName: "OPENROUTER_API_KEY",
    apiKey: process.env.OPENROUTER_API_KEY || "",
    url: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel:
      process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct",
    extraHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:5173",
      "X-Title": process.env.OPENROUTER_APP_NAME || "One Piece TCG AI Coach",
    },
  },
};

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "bestMove",
    "aggressiveMove",
    "safeMove",
    "boardInsight",
    "resourceInsight",
    "riskWarnings",
    "nextTurns",
  ],
  properties: {
    summary: { type: "string" },
    bestMove: { $ref: "#/$defs/recommendation" },
    aggressiveMove: { $ref: "#/$defs/recommendation" },
    safeMove: { $ref: "#/$defs/recommendation" },
    boardInsight: { type: "string" },
    resourceInsight: { type: "string" },
    riskWarnings: {
      type: "array",
      items: { type: "string" },
      minItems: 2,
      maxItems: 4,
    },
    nextTurns: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["turnLabel", "action", "outcome", "winProbability"],
        properties: {
          turnLabel: { type: "string" },
          action: { type: "string" },
          outcome: { type: "string" },
          winProbability: { type: "integer", minimum: 1, maximum: 99 },
        },
      },
    },
  },
  $defs: {
    recommendation: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "plan",
        "winProbability",
        "riskLevel",
        "cardAdvantage",
        "actions",
      ],
      properties: {
        title: { type: "string" },
        plan: { type: "string" },
        winProbability: { type: "integer", minimum: 1, maximum: 99 },
        riskLevel: {
          type: "string",
          enum: ["Low", "Medium", "High"],
        },
        cardAdvantage: { type: "string" },
        actions: {
          type: "array",
          items: { type: "string" },
          minItems: 3,
          maxItems: 5,
        },
      },
    },
  },
};

const ANALYSIS_SHAPE_GUIDE = JSON.stringify(ANALYSIS_SCHEMA, null, 2);

const toInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value) => Boolean(value);

const sanitizePayload = (body = {}) => ({
  selectedLeader: String(body.selectedLeader || "").trim(),
  turnNumber: toInteger(body.turnNumber, 1),
  yourLife: toInteger(body.yourLife, 0),
  oppLife: toInteger(body.oppLife, 0),
  yourHand: toInteger(body.yourHand, 0),
  oppHand: toInteger(body.oppHand, 0),
  donAvailable: toInteger(body.donAvailable, 0),
  attackers: toInteger(body.attackers, 0),
  blockers: toInteger(body.blockers, 0),
  restedChars: toInteger(body.restedChars, 0),
  triggerDeck: toBoolean(body.triggerDeck),
  aggressiveMode: toBoolean(body.aggressiveMode),
  defensiveMode: toBoolean(body.defensiveMode),
});

const validatePayload = (payload) => {
  if (!payload.selectedLeader) {
    return "Please select a leader before running AI analysis.";
  }

  const boundedFields = [
    ["turnNumber", 1, 50],
    ["yourLife", 0, 10],
    ["oppLife", 0, 10],
    ["yourHand", 0, 20],
    ["oppHand", 0, 20],
    ["donAvailable", 0, 10],
    ["attackers", 0, 8],
    ["blockers", 0, 8],
    ["restedChars", 0, 8],
  ];

  for (const [key, min, max] of boundedFields) {
    const value = payload[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      return `Invalid value for ${key}.`;
    }
  }

  return null;
};

const validateGuidePayload = (body = {}) => {
  const topic = String(body.topic || "").trim();
  const question = String(body.question || "").trim();
  const context = String(body.context || "").trim();

  if (!topic) {
    return { error: "Missing learning topic." };
  }

  if (!question) {
    return { error: "Ask a question before requesting AI guidance." };
  }

  if (question.length > 1500 || context.length > 4000) {
    return { error: "The learning request is too large." };
  }

  return { topic, question, context };
};

const resolveProvider = () => {
  const requestedProvider = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (requestedProvider && PROVIDERS[requestedProvider]?.apiKey) {
    return {
      name: requestedProvider,
      ...PROVIDERS[requestedProvider],
    };
  }

  const firstAvailable = Object.entries(PROVIDERS).find(([, config]) => config.apiKey);
  if (firstAvailable) {
    const [name, config] = firstAvailable;
    return { name, ...config };
  }

  return null;
};

const buildPrompt = (state) => `
You are an expert One Piece TCG strategy coach helping a player decide the best line in a live match.

Analyze this board state:
- Leader: ${state.selectedLeader}
- Turn number: ${state.turnNumber}
- Your life: ${state.yourLife}
- Opponent life: ${state.oppLife}
- Your hand: ${state.yourHand}
- Opponent hand: ${state.oppHand}
- DON available: ${state.donAvailable}
- Your active attackers: ${state.attackers}
- Your blockers: ${state.blockers}
- Your rested characters: ${state.restedChars}
- Trigger-focused deck: ${state.triggerDeck ? "yes" : "no"}
- Aggressive mode preference: ${state.aggressiveMode ? "yes" : "no"}
- Defensive mode preference: ${state.defensiveMode ? "yes" : "no"}

Rules for the answer:
- Treat this as coaching, not certainty.
- Keep the advice practical and beginner-friendly.
- Best move should balance win chance and safety.
- Aggressive move should maximize pressure even if riskier.
- Safe move should preserve resources and reduce blowout risk.
- cardAdvantage must be a short label like "+1", "-1", "Even".
- Keep each action short and concrete.
- nextTurns must describe the likely next 3 turns from the recommended plan.
- Return valid JSON only with no markdown fences, no commentary, and no extra text.
- Match this schema exactly:
${ANALYSIS_SHAPE_GUIDE}
`.trim();

const tryParseJson = (content) => {
  if (typeof content !== "string" || !content.trim()) return null;

  try {
    return JSON.parse(content);
  } catch (error) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (nestedError) {
      return null;
    }
  }
};

const requestProviderChat = async (provider, messages, options = {}) => {
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.extraHeaders,
    },
    body: JSON.stringify({
      model: provider.defaultModel,
      temperature: options.temperature ?? 0.3,
      messages,
      ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage =
      data?.error?.message ||
      `${provider.label} analysis request failed.`;
    const error = new Error(errorMessage);
    error.statusCode = response.status;
    throw error;
  }

  return data?.choices?.[0]?.message?.content || "";
};

const requestProviderAnalysis = async (provider, state) => {
  const content = await requestProviderChat(
    provider,
    [
      {
        role: "system",
        content:
          "You are a tournament-level One Piece TCG strategic assistant. Give concise, grounded analysis and output JSON only.",
      },
      {
        role: "user",
        content: buildPrompt(state),
      },
    ],
    {
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    },
  );

  const analysis = tryParseJson(content);
  if (!analysis) {
    throw new Error(`${provider.label} returned an unreadable analysis payload.`);
  }

  return analysis;
};

const buildGuidePrompt = ({ topic, context, question }) => `
You are a One Piece TCG learning coach inside the DeckLab Learning Guide.

Topic: ${topic}

Relevant page context:
${context || "No extra page context supplied."}

User question:
${question}

Instructions:
- Answer like a strong coach, not a vague chatbot.
- Keep the answer practical and easy to apply in a game.
- If the user is asking for a decision, explain the best line first.
- If useful, give 3 short next steps or checks.
- If the question depends on hidden information, say what assumption you are making.
- Do not mention being an AI model.
- Use plain text only.
`.trim();

const getGuideAssistance = async (req, res) => {
  const provider = resolveProvider();
  if (!provider) {
    return res.status(503).json({
      message:
        "No AI provider is configured. Add GROQ_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY on the backend.",
    });
  }

  const payload = validateGuidePayload(req.body);
  if (payload.error) {
    return res.status(400).json({ message: payload.error });
  }

  try {
    const answer = await requestProviderChat(
      provider,
      [
        {
          role: "system",
          content:
            "You are a patient, strong One Piece TCG coach helping a user learn decisions, matchups, sequencing, and practice spots.",
        },
        {
          role: "user",
          content: buildGuidePrompt(payload),
        },
      ],
      {
        temperature: 0.5,
      },
    );

    if (!String(answer || "").trim()) {
      return res.status(502).json({
        message: `${provider.label} returned an empty learning response.`,
      });
    }

    return res.json({
      provider: provider.name,
      model: provider.defaultModel,
      answer: String(answer).trim(),
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      message: error?.message || "Learning guide AI request failed.",
    });
  }
};

const getCoachAnalysis = async (req, res) => {
  const provider = resolveProvider();
  if (!provider) {
    return res.status(503).json({
      message:
        "No AI provider is configured. Add GROQ_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY on the backend.",
    });
  }

  const state = sanitizePayload(req.body);
  const validationError = validatePayload(state);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  try {
    const analysis = await requestProviderAnalysis(provider, state);

    return res.json({
      provider: provider.name,
      model: provider.defaultModel,
      analysis,
    });
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      message: error?.message || "AI Coach request failed.",
    });
  }
};

module.exports = {
  getCoachAnalysis,
  getGuideAssistance,
};
