const cardsDb = require("../model/cards_db");
const standingsDb = require("../model/standings_db");
const tournamentsDb = require("../model/tournaments_db");
const savedDeckDb = require("../model/saved_decks_db");
const mongoose = require("mongoose");
const { cacheGetJson, cacheSetJson } = require("../config/cache");
const { resolveProvider, requestProviderChat, requestProviderChatWithFallback } = require("./ai_controller");

// Yeh helper kisi bhi numeric value ko safe number me convert karta hai.
const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

// Yeh helper text ko trim + lowercase me normalize karta hai.
const normalizeText = (value) => String(value || "").trim().toLowerCase();
// Yeh helper deck/leader naam match karne ke liye special characters hata deta hai.
const normalizeNameForMatch = (value) => normalizeText(value).replace(/[^a-z0-9]/g, "");
// Yeh helper string date ko valid Date object me badalta hai.
const parseDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
// Yeh helper do dates ke beech days ka gap nikalta hai.
const daysBetween = (d1, d2) => Math.max(0, Math.floor((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));

// Yeh helper score values ko min-max range ke andar rakhta hai.
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const ANALYTICS_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_CACHE_TTL_MS, 60_000));
const ANALYTICS_OPTIMIZE_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_OPTIMIZE_CACHE_TTL_MS, 45_000));
const ANALYTICS_GENERATE_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_GENERATE_CACHE_TTL_MS, 120_000));
const ANALYTICS_COLOR_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_COLOR_CACHE_TTL_MS, 120_000));
const ANALYTICS_PROFILE_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_PROFILE_CACHE_TTL_MS, 60_000));
const ANALYTICS_COMPARE_CACHE_TTL_MS = Math.max(1000, parseNumber(process.env.ANALYTICS_COMPARE_CACHE_TTL_MS, 45_000));
const ANALYTICS_CARD_FIELDS =
  "id card_code name colors color category type cost power counter_value counter traits types effect trigger text_effect rarity pack_id set_code img_full_url img_url tournament_status tournamentStatus status legality is_banned banned";
const ANALYTICS_STANDING_FIELDS = "tournament date format placement player deck leaderImage";
const ANALYTICS_TOURNAMENT_FIELDS = "date region country name format players winner link";

const tryParseJsonObject = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (nestedError) {
      return null;
    }
  }
};

const COMPARE_DECKS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["deckAWinPercent", "deckBWinPercent", "summary", "explanation"],
  properties: {
    deckAWinPercent: { type: "integer", minimum: 1, maximum: 99 },
    deckBWinPercent: { type: "integer", minimum: 1, maximum: 99 },
    summary: { type: "string" },
    explanation: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string" },
    },
  },
};

const COMPARE_DECKS_SHAPE_GUIDE = JSON.stringify(COMPARE_DECKS_SCHEMA, null, 2);

// Yeh helper standings se top meta leaders nikalta hai (DB-driven, no static list).
const buildMetaLeaderRowsFromStandings = ({ standings, cards }) => {
  const leaders = cards.filter((card) => card.type === "leader");
  const leaderAliasToMeta = new Map();
  for (const leader of leaders) {
    const aliases = new Set([
      normalizeNameForMatch(leader.name),
      normalizeNameForMatch(leader.card_code),
      ...String(leader.name || "")
        .split(/\s+/)
        .map((p) => normalizeNameForMatch(p))
        .filter(Boolean),
    ]);
    for (const alias of aliases) {
      if (!alias || alias.length < 3) continue;
      if (!leaderAliasToMeta.has(alias)) {
        leaderAliasToMeta.set(alias, {
          name: leader.name || leader.card_code,
          color: leader.color || "red",
          code: leader.card_code,
        });
      }
    }
  }

  const byLeader = new Map();
  for (const row of standings || []) {
    const deckName = normalizeNameForMatch(row.deck || "");
    if (!deckName) continue;
    const placement = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
    if (!Number.isFinite(placement) || placement <= 0) continue;

    let matched = null;
    for (const [alias, meta] of leaderAliasToMeta.entries()) {
      if (deckName.includes(alias)) {
        matched = meta;
        break;
      }
    }
    if (!matched) continue;

    const key = matched.code || matched.name;
    if (!byLeader.has(key)) {
      byLeader.set(key, {
        leader: matched.name,
        color: matched.color,
        entries: 0,
        wins: 0,
        top8: 0,
        avgPlacementSum: 0,
      });
    }
    const ref = byLeader.get(key);
    ref.entries += 1;
    ref.wins += placement === 1 ? 1 : 0;
    ref.top8 += placement <= 8 ? 1 : 0;
    ref.avgPlacementSum += placement;
  }

  return Array.from(byLeader.values())
    .map((row) => ({
      ...row,
      top8Rate: row.entries ? (row.top8 / row.entries) * 100 : 0,
      winRate: row.entries ? (row.wins / row.entries) * 100 : 0,
      avgPlacement: row.entries ? row.avgPlacementSum / row.entries : 99,
    }))
    .sort((a, b) => b.top8Rate - a.top8Rate || b.entries - a.entries)
    .slice(0, 6);
};

// Yeh helper banned/suspended cards ko active pool se filter karta hai.
const isCardActive = (card) => {
  const status = normalizeText(card?.tournament_status || card?.tournamentStatus || card?.status || card?.legality);
  if (status.includes("banned") || status.includes("forbidden") || status.includes("suspended")) return false;
  if (card?.is_banned === true || card?.banned === true) return false;
  return true;
};

// Yeh helper raw card document ko internal analytics format me map karta hai.
const toInternalCard = (card) => ({
  card_code: String(card.id || card.card_code || "").trim(),
  name: card.name || "Unknown Card",
  color: normalizeText((card.colors && card.colors[0]) || card.color || "red"),
  type: normalizeText(card.category || card.type || "character"),
  cost: parseNumber(card.cost, 0),
  power: parseNumber(card.power, 0),
  counter_value: parseNumber(card.counter_value ?? card.counter, 0),
  traits: Array.isArray(card.traits) ? card.traits : Array.isArray(card.types) ? card.types : [],
  text_effect: [card.effect, card.trigger, card.text_effect].filter(Boolean).join(" | "),
  rarity: card.rarity || "-",
  set_code: card.pack_id || card.set_code || "SET",
  image_url: card.img_full_url || card.img_url || card.image_url || "",
});

// Yeh helper incoming deck payload ko uniform items list me convert karta hai.
const normalizeDeckItems = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .map((item) => ({
        card_code: String(item?.card_code || item?.id || item?.code || "").trim(),
        count: parseNumber(item?.count, 0),
        card: item?.card || item,
      }))
      .filter((item) => item.card_code && item.count > 0);
  }

  if (typeof payload === "object") {
    return Object.entries(payload)
      .map(([card_code, count]) => ({
        card_code: String(card_code || "").trim(),
        count: parseNumber(count, 0),
        card: null,
      }))
      .filter((item) => item.card_code && item.count > 0);
  }

  return [];
};

// Yeh helper card text ke basis par card roles detect karta hai.
const detectCardRoles = (card) => {
  const text = normalizeText(card.text_effect);
  const roles = new Set();

  if (card.type === "character") roles.add("character");
  if (card.type === "event") roles.add("event");
  if (card.type === "stage") roles.add("stage");

  if (text.includes("blocker")) roles.add("blocker");
  if (/k\.o\.| ko |trash|rest|return|bottom of|remove/.test(text)) roles.add("removal");
  if ((text.includes("look at") && text.includes("add")) || text.includes("search")) roles.add("searcher");
  if (text.includes("draw")) roles.add("draw");
  if (card.cost >= 7 || card.power >= 8000 || /rush|double attack|banish/.test(text)) roles.add("finisher");
  if (/rest|return|cannot attack|cannot activate/.test(text)) roles.add("board_control");

  return Array.from(roles);
};

// Yeh helper deck stats dekh kar archetype infer karta hai.
const inferArchetype = ({ lowCostDensity, avgCost, removalDensity, blockerDensity }) => {
  if (lowCostDensity >= 45 && avgCost <= 3) return "aggro";
  if (removalDensity >= 18 || blockerDensity >= 14) return "control";
  return "midrange";
};

// Yeh helper deck ka cost curve distribution aur issues nikalta hai.
const buildCostCurve = (expandedDeck) => {
  const distribution = {};
  for (let i = 0; i <= 8; i += 1) distribution[String(i)] = 0;
  distribution["9+"] = 0;

  for (const card of expandedDeck) {
    if (card.cost >= 9) distribution["9+"] += 1;
    else distribution[String(Math.max(0, card.cost))] += 1;
  }

  const total = expandedDeck.length;
  const early = expandedDeck.filter((c) => c.cost <= 2).length;
  const mid = expandedDeck.filter((c) => c.cost >= 3 && c.cost <= 5).length;
  const late = expandedDeck.filter((c) => c.cost >= 6).length;

  const earlyPct = total ? Math.round((early / total) * 100) : 0;
  const midPct = total ? Math.round((mid / total) * 100) : 0;
  const latePct = total ? Math.round((late / total) * 100) : 0;

  const issues = [];
  const suggestions = [];
  if (earlyPct < 28) {
    issues.push("Weak early game curve (too few 0-2 cost cards).");
    suggestions.push("Add more 1-2 cost units and searchers for early tempo.");
  }
  if (midPct < 30) {
    issues.push("Mid-game pressure is low (3-5 cost slots underrepresented).");
    suggestions.push("Increase 3-5 cost value cards for stable turn progression.");
  }
  if (latePct > 30) {
    issues.push("Curve is top-heavy (too many 6+ cost cards).");
    suggestions.push("Cut some high-cost cards and improve low/mid curve.");
  }

  return {
    distribution,
    phases: {
      earlyGame: { count: early, percent: earlyPct },
      midGame: { count: mid, percent: midPct },
      lateGame: { count: late, percent: latePct },
    },
    issues,
    suggestedImprovements: suggestions,
  };
};

// Yeh helper deck ka type/role breakdown calculate karta hai.
const computeRoleBreakdown = (expandedDeck) => {
  const typeCounts = { characters: 0, events: 0, stages: 0 };
  const roleCounts = { blockers: 0, removal: 0, searchers: 0, finishers: 0, draw: 0, boardControl: 0 };

  for (const card of expandedDeck) {
    if (card.type === "character") typeCounts.characters += 1;
    if (card.type === "event") typeCounts.events += 1;
    if (card.type === "stage") typeCounts.stages += 1;

    const roles = detectCardRoles(card);
    if (roles.includes("blocker")) roleCounts.blockers += 1;
    if (roles.includes("removal")) roleCounts.removal += 1;
    if (roles.includes("searcher")) roleCounts.searchers += 1;
    if (roles.includes("finisher")) roleCounts.finishers += 1;
    if (roles.includes("draw")) roleCounts.draw += 1;
    if (roles.includes("board_control")) roleCounts.boardControl += 1;
  }

  const missingRoles = [];
  if (roleCounts.blockers < 6) missingRoles.push("blockers");
  if (roleCounts.removal < 6) missingRoles.push("removal");
  if (roleCounts.searchers < 4) missingRoles.push("searchers");
  if (roleCounts.finishers < 4) missingRoles.push("finishers");

  return { typeCounts, roleCounts, missingRoles };
};

// Yeh helper leader ke against deck synergy score calculate karta hai.
const computeSynergy = (expandedDeck, leader) => {
  const total = expandedDeck.length || 1;
  const leaderColor = normalizeText(leader?.color);
  const sameColor = expandedDeck.filter((card) => !leaderColor || card.color === leaderColor).length;
  const sameColorPct = Math.round((sameColor / total) * 100);

  const archetypeSignals = expandedDeck.filter((card) => {
    const text = normalizeText(card.text_effect);
    return text.includes("don!!") || text.includes("your turn") || text.includes("on play") || text.includes("when attacking");
  }).length;
  const archetypePct = Math.round((archetypeSignals / total) * 100);

  const score = clamp(Math.round(sameColorPct * 0.65 + archetypePct * 0.35));
  const offSynergyCards = expandedDeck
    .filter((card) => leaderColor && card.color !== leaderColor)
    .slice(0, 8)
    .map((card) => ({
      cardName: card.name,
      cardId: card.card_code,
      reason: `Color mismatch with leader (${leaderColor}).`,
    }));

  return {
    score,
    archetype: leaderColor ? `${leaderColor} core` : "mixed",
    details: {
      sameColorPercent: sameColorPct,
      archetypeSignalPercent: archetypePct,
    },
    offSynergyCards,
  };
};

// Yeh helper deck consistency score aur ratio issues return karta hai.
const computeConsistency = ({ expandedDeck, costCurve, roleBreakdown }) => {
  const total = expandedDeck.length || 1;
  const searchCards = roleBreakdown.roleCounts.searchers;
  const drawCards = roleBreakdown.roleCounts.draw;
  const lowCurveStable = costCurve.phases.earlyGame.percent >= 28 ? 100 : Math.round((costCurve.phases.earlyGame.percent / 28) * 100);
  const searchDrawDensity = Math.round(((searchCards + drawCards) / total) * 100);

  const score = clamp(
    Math.round(lowCurveStable * 0.45 + clamp(Math.round((searchDrawDensity / 20) * 100)) * 0.35 + (total >= 49 ? 100 : Math.round((total / 50) * 100)) * 0.2)
  );

  const ratioIssues = [];
  if (searchCards < 4) ratioIssues.push("Low search card density.");
  if (drawCards < 3) ratioIssues.push("Low draw support.");
  if (costCurve.phases.earlyGame.percent < 28) ratioIssues.push("Early curve instability.");

  return {
    score,
    details: {
      searchCards,
      drawCards,
      searchDrawDensity,
      curveStability: lowCurveStable,
    },
    ratioIssues,
  };
};

// Yeh helper common meta leaders ke against estimated fit score banata hai.
const computeMetaFit = ({ leader, roleBreakdown, costCurve, consistencyScore, metaLeaders }) => {
  const leaderColor = normalizeText(leader?.color || "red");
  const blockers = roleBreakdown.roleCounts.blockers;
  const removal = roleBreakdown.roleCounts.removal;
  const early = costCurve.phases.earlyGame.percent;
  const liveMetaLeaders = Array.isArray(metaLeaders) && metaLeaders.length > 0
    ? metaLeaders
    : [{ leader: "Open Meta", color: leaderColor || "red", top8Rate: 50, entries: 1, avgPlacement: 8 }];

  const byLeader = liveMetaLeaders.map((meta) => {
    const colorFit = meta.color === leaderColor ? 3 : -1;
    const roleAdjust = Math.round((blockers >= 8 ? 2 : -2) + (removal >= 8 ? 2 : -2) + (early >= 30 ? 2 : -2));
    const consistencyAdjust = Math.round((consistencyScore.score - 50) * 0.12);
    const metaStrengthAdjust = Math.round(((meta.top8Rate || 50) - 50) * 0.08);
    const sampleAdjust = Math.round(Math.log2((meta.entries || 1) + 1));
    const placementAdjust = Math.round((10 - Math.min(10, meta.avgPlacement || 10)) * 0.35);
    const estimatedWinRate = clamp(50 + colorFit + roleAdjust + consistencyAdjust - metaStrengthAdjust + sampleAdjust + placementAdjust, 20, 80);

    return {
      metaLeader: String(meta.leader || "Meta Leader"),
      estimatedWinRate,
      confidence: estimatedWinRate >= 58 ? "high" : estimatedWinRate >= 50 ? "medium" : "low",
    };
  });

  const overall = Math.round(byLeader.reduce((sum, row) => sum + row.estimatedWinRate, 0) / byLeader.length);
  return { score: clamp(overall), byLeader };
};

// Yeh helper deck ki major weaknesses list banata hai.
const findWeaknesses = ({ roleBreakdown, costCurve, expandedDeck }) => {
  const weaknesses = [];
  const total = expandedDeck.length || 1;

  if (roleBreakdown.typeCounts.events < Math.round(total * 0.12)) {
    weaknesses.push("Low event count");
  }
  if (roleBreakdown.roleCounts.blockers < 6) {
    weaknesses.push("Lack of blockers");
  }
  if (costCurve.phases.earlyGame.percent < 28) {
    weaknesses.push("Weak early game");
  }
  if (roleBreakdown.roleCounts.removal < 6 || roleBreakdown.roleCounts.boardControl < 4) {
    weaknesses.push("No board control");
  }
  if (roleBreakdown.roleCounts.finishers < 4) {
    weaknesses.push("Poor late game finishers");
  }

  return weaknesses;
};

// Yeh helper weaknesses ke hisaab se add/remove suggestions banata hai.
const buildOptimizationSuggestions = ({ weaknesses, expandedDeck, allCards, leaderColor }) => {
  const deckCountMap = new Map();
  for (const card of expandedDeck) {
    deckCountMap.set(card.card_code, (deckCountMap.get(card.card_code) || 0) + 1);
  }
  const canAdd = (card) => (deckCountMap.get(card.card_code) || 0) < 4;

  const colorPool = allCards.filter((card) => {
    if (card.type === "leader") return false;
    if (!leaderColor) return true;
    return card.color === leaderColor;
  });

  const addBlockers = colorPool.filter((c) => detectCardRoles(c).includes("blocker") && canAdd(c)).slice(0, 5);
  const addRemoval = colorPool.filter((c) => detectCardRoles(c).includes("removal") && canAdd(c)).slice(0, 5);
  const addEarly = colorPool.filter((c) => c.type === "character" && c.cost <= 2 && canAdd(c)).slice(0, 5);
  const addFinishers = colorPool.filter((c) => detectCardRoles(c).includes("finisher") && canAdd(c)).slice(0, 5);

  const removeCandidates = expandedDeck
    .filter((c) => c.cost >= 7 && c.counter_value === 0)
    .slice(0, 6)
    .map((card) => ({
      cardName: card.name,
      cardId: card.card_code,
      reason: "Top-heavy slot with low flexibility.",
    }));

  const suggestions = [];
  if (weaknesses.includes("Lack of blockers")) {
    suggestions.push({
      action: "add",
      reason: "Improve survivability against aggro and tempo pressure.",
      cards: addBlockers.slice(0, 3).map((c) => ({ cardName: c.name, cardId: c.card_code })),
    });
  }
  if (weaknesses.includes("No board control")) {
    suggestions.push({
      action: "add",
      reason: "Increase interaction and control over opponent board.",
      cards: addRemoval.slice(0, 3).map((c) => ({ cardName: c.name, cardId: c.card_code })),
    });
  }
  if (weaknesses.includes("Weak early game")) {
    suggestions.push({
      action: "add",
      reason: "Smooth opening turns and reduce dead starts.",
      cards: addEarly.slice(0, 3).map((c) => ({ cardName: c.name, cardId: c.card_code })),
    });
  }
  if (weaknesses.includes("Poor late game finishers")) {
    suggestions.push({
      action: "add",
      reason: "Add stronger closing threats for late turns.",
      cards: addFinishers.slice(0, 3).map((c) => ({ cardName: c.name, cardId: c.card_code })),
    });
  }

  if (removeCandidates.length > 0) {
    suggestions.push({
      action: "remove",
      reason: "Reduce clunky high-cost cards and free slots for consistency.",
      cards: removeCandidates.slice(0, 3).map((c) => ({ cardName: c.cardName, cardId: c.cardId })),
    });
  }

  return suggestions;
};

// Yeh helper suggestions se recommended cards ka compact list banata hai.
const buildRecommendedCards = (optimizationSuggestions, allCardsByCode) => {
  const seen = new Set();
  const recommended = [];

  for (const suggestion of optimizationSuggestions) {
    for (const cardRef of suggestion.cards || []) {
      const key = cardRef.cardId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const card = allCardsByCode.get(key);
      recommended.push({
        cardName: cardRef.cardName,
        cardId: cardRef.cardId,
        explanation:
          suggestion.action === "remove"
            ? "Can be cut to improve curve and consistency."
            : `${card ? `Cost ${card.cost}, ${card.type}` : "Strong role fit"} - ${suggestion.reason}`,
      });
      if (recommended.length >= 10) return recommended;
    }
  }

  return recommended;
};

// Yeh helper card ko current generation context ke hisaab se score deta hai.
const scoreCardForDeck = (card, context) => {
  const roles = detectCardRoles(card);
  const playstyle = context.playstyle || "balanced";
  const riskMode = context.riskMode || "consistency";
  const metaContext = context.metaContext || "balanced";

  let score = 0;

  // Base value from raw stat profile.
  score += clamp(card.power / 120, 0, 100) * 0.25;
  score += clamp(card.counter_value / 20, 0, 100) * 0.2;
  score += (card.type === "event" ? 65 : 45) * 0.1;

  // Curve fit.
  if (playstyle === "aggressive") {
    score += card.cost <= 2 ? 22 : card.cost <= 4 ? 12 : 4;
  } else if (playstyle === "control") {
    score += card.cost >= 5 ? 20 : card.cost >= 3 ? 12 : 6;
  } else {
    score += card.cost >= 2 && card.cost <= 5 ? 18 : 8;
  }

  // Role bonuses.
  if (roles.includes("searcher")) score += 14;
  if (roles.includes("draw")) score += 12;
  if (roles.includes("blocker")) score += 10;
  if (roles.includes("removal")) score += 12;
  if (roles.includes("finisher")) score += 10;

  // Meta context bias.
  if (metaContext === "fast-aggro" && roles.includes("blocker")) score += 10;
  if (metaContext === "fast-aggro" && roles.includes("removal")) score += 8;
  if (metaContext === "control-heavy" && roles.includes("finisher")) score += 8;
  if (metaContext === "removal-heavy" && card.counter_value >= 1000) score += 6;

  // Risk mode.
  if (riskMode === "consistency") {
    if (card.counter_value >= 1000) score += 6;
    if (card.cost <= 3) score += 6;
  } else {
    if (card.power >= 7000) score += 8;
    if (roles.includes("finisher")) score += 8;
  }

  return score;
};

// Yeh helper card ka primary role label choose karta hai.
const getRoleLabel = (card) => {
  const roles = detectCardRoles(card);
  if (roles.includes("removal")) return "Removal";
  if (roles.includes("searcher") || roles.includes("draw")) return "Draw";
  if (roles.includes("blocker")) return "Blocker";
  if (roles.includes("finisher")) return "Finisher";
  return "Engine";
};

// Yeh helper scored pool se target-based generated deck banata hai.
const generateDeckFromPool = ({ pool, deckSize, playstyle, riskMode, metaContext }) => {
  const scored = pool
    .map((card) => ({
      card,
      score: scoreCardForDeck(card, { playstyle, riskMode, metaContext }),
      role: getRoleLabel(card),
    }))
    .sort((a, b) => b.score - a.score);

  const desiredRoleTargets =
    playstyle === "aggressive"
      ? { Removal: 8, Blocker: 6, Draw: 5, Finisher: 4, Engine: 27 }
      : playstyle === "control"
      ? { Removal: 12, Blocker: 8, Draw: 6, Finisher: 6, Engine: 18 }
      : { Removal: 10, Blocker: 7, Draw: 6, Finisher: 5, Engine: 22 };

  const deckMap = new Map();
  const roleCounts = { Removal: 0, Blocker: 0, Draw: 0, Finisher: 0, Engine: 0 };
  let total = 0;

  const tryAddCard = (entry) => {
    const code = entry.card.card_code;
    const current = deckMap.get(code) || 0;
    if (current >= 4) return false;
    if (total >= deckSize) return false;
    deckMap.set(code, current + 1);
    roleCounts[entry.role] += 1;
    total += 1;
    return true;
  };

  // First pass: satisfy role targets.
  for (const [role, target] of Object.entries(desiredRoleTargets)) {
    let guard = 0;
    while (roleCounts[role] < target && guard < 2000) {
      guard += 1;
      const candidate = scored.find((entry) => entry.role === role && (deckMap.get(entry.card.card_code) || 0) < 4);
      if (!candidate) break;
      if (!tryAddCard(candidate)) break;
    }
  }

  // Fill remaining by best score.
  for (const entry of scored) {
    while (total < deckSize && (deckMap.get(entry.card.card_code) || 0) < 4) {
      if (!tryAddCard(entry)) break;
    }
    if (total >= deckSize) break;
  }

  const deckCards = Array.from(deckMap.entries())
    .map(([code, count]) => {
      const base = scored.find((entry) => entry.card.card_code === code);
      if (!base) return null;
      return {
        count,
        name: base.card.name,
        code: base.card.card_code,
        role: base.role,
        cost: base.card.cost,
        power: base.card.power,
        counter: base.card.counter_value,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.cost - b.cost || b.count - a.count);

  return { deckCards, total };
};

const rebalanceGeneratedDeck = ({ aiDeckCards, seedDeckCards, deckSize }) => {
  const seedByCode = new Map(seedDeckCards.map((card) => [card.code, card]));
  const orderedSeedCodes = seedDeckCards.map((card) => card.code);
  const draft = [];
  const used = new Set();

  for (const item of Array.isArray(aiDeckCards) ? aiDeckCards : []) {
    const code = String(item?.code || "").trim();
    if (!code || used.has(code) || !seedByCode.has(code)) continue;
    const count = clamp(parseNumber(item?.count, 0), 0, 4);
    if (!count) continue;
    const seed = seedByCode.get(code);
    draft.push({
      ...seed,
      count,
      role: String(item?.role || seed.role || "").trim() || seed.role,
    });
    used.add(code);
  }

  if (draft.length === 0) return seedDeckCards;

  let total = draft.reduce((sum, card) => sum + card.count, 0);

  if (total > deckSize) {
    for (let i = draft.length - 1; i >= 0 && total > deckSize; i -= 1) {
      while (draft[i].count > 1 && total > deckSize) {
        draft[i].count -= 1;
        total -= 1;
      }
    }
  }

  if (total < deckSize) {
    for (const code of orderedSeedCodes) {
      if (total >= deckSize) break;
      const existing = draft.find((card) => card.code === code);
      if (existing) {
        while (existing.count < 4 && total < deckSize) {
          existing.count += 1;
          total += 1;
        }
      } else {
        const seed = seedByCode.get(code);
        if (!seed) continue;
        draft.push({ ...seed, count: 1 });
        total += 1;
      }
    }
  }

  return draft
    .filter((card) => card.count > 0)
    .sort((a, b) => a.cost - b.cost || b.count - a.count);
};

const refineGeneratedDeckWithAI = async ({
  color,
  colorList,
  playstyle,
  riskMode,
  metaContext,
  deckSize,
  selectedLeader,
  seedDeckCards,
  matchupPreview,
}) => {
  const prompt = `
You are a high-level One Piece TCG deckbuilding assistant inside DeckLab.

Your job:
- Refine a seed decklist into a stronger "best deck" recommendation.
- Keep the leader/color logic from the app unchanged.
- Only use the candidate cards already provided.
- Return valid JSON only.

Inputs:
- Color request: ${colorList.join("/") || color}
- Playstyle: ${playstyle}
- Risk mode: ${riskMode}
- Meta context: ${metaContext}
- Deck size target: ${deckSize}
- Leader: ${selectedLeader ? `${selectedLeader.name} (${selectedLeader.card_code})` : "Auto-selected best leader"}
- Matchup preview leaders: ${matchupPreview.map((item) => `${item.leader} ${item.winRate}%`).join(", ")}

Candidate seed deck:
${seedDeckCards
  .map((card) => `- ${card.code} | ${card.name} | count ${card.count} | role ${card.role} | cost ${card.cost} | power ${card.power} | counter ${card.counter}`)
  .join("\n")}

Return this JSON shape exactly:
{
  "tags": ["tag1", "tag2", "tag3"],
  "insights": ["insight 1", "insight 2", "insight 3", "insight 4"],
  "deckCards": [
    { "code": "OP01-001", "count": 4, "role": "Starter" }
  ]
}

Rules:
- deckCards must use only codes from the candidate seed deck.
- counts should be between 1 and 4.
- Aim for exactly ${deckSize} cards total.
- Prefer practical competitive tuning, not flavor.
- insights should explain why this refined deck is strong for the requested playstyle/meta.
  `.trim();

  try {
    const { content, provider } = await requestProviderChatWithFallback(
      [
        {
          role: "system",
          content:
            "You are a precise One Piece TCG deckbuilding analyst. Return JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        temperature: 0.4,
        responseFormat: { type: "json_object" },
      },
    );

    const parsed = tryParseJsonObject(content);
    if (!parsed || !Array.isArray(parsed.deckCards)) return null;

    return {
      provider: provider.name,
      model: provider.defaultModel,
      deckCards: rebalanceGeneratedDeck({
        aiDeckCards: parsed.deckCards,
        seedDeckCards,
        deckSize,
      }),
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter(Boolean).slice(0, 4) : [],
      insights: Array.isArray(parsed.insights)
        ? parsed.insights.filter(Boolean).slice(0, 5)
        : [],
    };
  } catch (error) {
    return null;
  }
};

const refineOptimizedDeckWithAI = async ({
  leader,
  expandedDeck,
  costCurve,
  roleBreakdown,
  synergyScore,
  consistencyScore,
  metaFitScore,
  weaknesses,
  targetPlan,
  nextBestSwaps,
  recommendedCards,
  deckPowerScore,
}) => {
  const compactDeck = expandedDeck.slice(0, 60).map((card) => ({
    code: card.card_code,
    name: card.name,
    cost: card.cost,
    type: card.type,
    color: card.color,
    power: card.power,
    counter: card.counter_value,
  }));

  const prompt = `
You are a tournament-level One Piece TCG deck optimization analyst.

Your task:
- Analyze the provided built deck.
- Improve the optimization report using strategic reasoning.
- Return JSON only.

Inputs:
- Leader: ${leader ? `${leader.name || leader.card_code || "Unknown"} (${leader.color || "unknown"})` : "Unknown"}
- Deck cards:
${compactDeck.map((card) => `- ${card.code} | ${card.name} | ${card.type} | ${card.color} | cost ${card.cost} | power ${card.power} | counter ${card.counter}`).join("\n")}

- Existing heuristic summary:
costCurve: ${JSON.stringify(costCurve)}
roleBreakdown: ${JSON.stringify(roleBreakdown)}
synergyScore: ${JSON.stringify(synergyScore)}
consistencyScore: ${JSON.stringify(consistencyScore)}
metaFitScore: ${JSON.stringify(metaFitScore)}
weaknesses: ${JSON.stringify(weaknesses)}
targetPlan: ${JSON.stringify(targetPlan)}
nextBestSwaps: ${JSON.stringify(nextBestSwaps)}
recommendedCards: ${JSON.stringify(recommendedCards)}
deckPowerScore: ${deckPowerScore}

Return this JSON shape exactly:
{
  "summary": "short overall optimization summary",
  "deckPower": { "score": 78, "tier": "A" },
  "consistencyScore": { "score": 70, "explanation": "..." },
  "metaFitScore": { "score": 66, "explanation": "...", "estimatedWinPercent": 61 },
  "pilotProfile": { "title": "Aggressive Pressure Player", "explanation": "..." },
  "weaknesses": ["...", "..."],
  "recommendedCards": [
    { "cardName": "Card", "cardId": "OP01-001", "explanation": "..." }
  ],
  "nextBestSwaps": [
    {
      "remove": { "cardName": "Old Card", "cardId": "OP01-002" },
      "add": { "cardName": "New Card", "cardId": "OP01-003" },
      "reason": "...",
      "expectedImpact": 6
    }
  ],
  "insights": ["...", "...", "..."]
}

Rules:
- Keep the response practical and competitive.
- Do not invent cards that are not already mentioned in nextBestSwaps or recommendedCards inputs.
- estimatedWinPercent must be between 1 and 99.
- deckPower.score, consistencyScore.score, metaFitScore.score must be between 1 and 100.
- nextBestSwaps expectedImpact must be between 1 and 15.
`.trim();

  try {
    const { content, provider } = await requestProviderChatWithFallback(
      [
        {
          role: "system",
          content: "You are a precise One Piece TCG optimization analyst. Return JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        temperature: 0.35,
        responseFormat: { type: "json_object" },
      }
    );

    const parsed = tryParseJsonObject(content);
    if (!parsed || typeof parsed !== "object") return null;

    return {
      provider: provider.name,
      model: provider.defaultModel,
      summary: String(parsed.summary || "").trim(),
      deckPower: parsed.deckPower || null,
      consistencyScore: parsed.consistencyScore || null,
      metaFitScore: parsed.metaFitScore || null,
      pilotProfile: parsed.pilotProfile || null,
      weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.filter(Boolean).slice(0, 6) : [],
      recommendedCards: Array.isArray(parsed.recommendedCards) ? parsed.recommendedCards.slice(0, 10) : [],
      nextBestSwaps: Array.isArray(parsed.nextBestSwaps) ? parsed.nextBestSwaps.slice(0, 8) : [],
      insights: Array.isArray(parsed.insights) ? parsed.insights.filter(Boolean).slice(0, 5) : [],
    };
  } catch (error) {
    return null;
  }
};

// Yeh helper card pool fallback se color-wise high-level stats banata hai.
const buildBestColorStatsFromCards = (cards) => {
  const colors = ["red", "blue", "green", "purple", "black", "yellow"];

  const total = cards.length || 1;
  const rows = colors.map((color) => {
    const pool = cards.filter((card) => card.color === color);
    const pickRate = Math.round((pool.length / total) * 1000) / 10;
    const avgPower = pool.length ? pool.reduce((s, c) => s + c.power, 0) / pool.length : 0;
    const avgCounter = pool.length ? pool.reduce((s, c) => s + c.counter_value, 0) / pool.length : 0;
    const removals = pool.filter((c) => detectCardRoles(c).includes("removal")).length;
    const blockers = pool.filter((c) => detectCardRoles(c).includes("blocker")).length;
    const searchers = pool.filter((c) => detectCardRoles(c).includes("searcher")).length;
    const leaders = pool.filter((c) => c.type === "leader").slice(0, 3).map((c) => c.card_code);

    const consistency = clamp(Math.round((avgCounter / 20) * 45 + clamp((searchers / Math.max(pool.length, 1)) * 400) + 20));
    const winRate = clamp(
      Math.round(
        42 +
          (avgPower / 10000) * 20 +
          (avgCounter / 2000) * 16 +
          clamp((removals / Math.max(pool.length, 1)) * 180) * 0.25 +
          clamp((blockers / Math.max(pool.length, 1)) * 180) * 0.2
      ),
      35,
      75
    );
    const metaFit = clamp(Math.round(winRate * 0.55 + consistency * 0.45));
    const badMatchups = winRate >= 60 ? 1 : winRate >= 55 ? 2 : winRate >= 50 ? 3 : 4;

    return {
      color,
      win_rate: winRate,
      pick_rate: pickRate,
      bad_matchups_count: badMatchups,
      consistency,
      skill_floor: color === "red" || color === "green" ? 6 : 7,
      skill_ceiling: color === "blue" || color === "yellow" ? 10 : 9,
      top_leaders: leaders,
      meta_fit: metaFit,
    };
  });

  return rows.sort((a, b) => b.win_rate - a.win_rate);
};

// Yeh helper standings ke deck naam se possible color infer karta hai.
const inferColorFromDeckName = (deckName, leaderNameIndex) => {
  const text = normalizeNameForMatch(deckName);
  if (!text) return null;

  if (text.includes("red")) return "red";
  if (text.includes("blue")) return "blue";
  if (text.includes("green")) return "green";
  if (text.includes("purple")) return "purple";
  if (text.includes("black")) return "black";
  if (text.includes("yellow")) return "yellow";

  for (const [leaderName, color] of leaderNameIndex.entries()) {
    if (leaderName && text.includes(leaderName)) return color;
  }

  return null;
};

// Yeh helper leader name ke aliases bana kar color inference strong karta hai.
const buildLeaderAliasIndex = (leaderCards) => {
  const aliasToColor = new Map();
  const addAlias = (alias, color) => {
    const key = normalizeNameForMatch(alias);
    if (!key || key.length < 3) return;
    if (!aliasToColor.has(key)) aliasToColor.set(key, color);
  };

  for (const leader of leaderCards) {
    addAlias(leader.name, leader.color);
    addAlias(leader.card_code, leader.color);

    const baseName = String(leader.name || "")
      .replace(/[{}()[\]."']/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const parts = baseName.split(" ").filter(Boolean);
    for (const part of parts) addAlias(part, leader.color);

    if (parts.length >= 2) {
      addAlias(parts.slice(-2).join(" "), leader.color);
      addAlias(parts[parts.length - 1], leader.color);
    }
  }

  return aliasToColor;
};

// Yeh helper meta standings + tournaments se filter-aware color stats nikalta hai.
const buildBestColorStatsFromMeta = ({ standings, tournaments, cards, playstyle, budgetMode, metaWeight }) => {
  const colors = ["red", "blue", "green", "purple", "black", "yellow"];
  const leaderCards = cards.filter((card) => card.type === "leader" && colors.includes(card.color));

  const leaderNameToColor = new Map();
  const leadersByColor = new Map(colors.map((color) => [color, []]));
  for (const leader of leaderCards) {
    const key = normalizeNameForMatch(leader.name);
    if (key) leaderNameToColor.set(key, leader.color);
    leadersByColor.get(leader.color)?.push(leader.card_code);
  }
  const leaderAliasToColor = buildLeaderAliasIndex(leaderCards);
  const leaderCodeToColor = new Map(leaderCards.map((leader) => [normalizeText(leader.card_code), leader.color]));

  const tournamentByName = new Map();
  const tournamentByNameFormat = new Map();
  for (const t of tournaments) {
    const nameKey = normalizeText(t.name);
    const formatKey = normalizeText(t.format);
    if (nameKey) tournamentByName.set(nameKey, t);
    if (nameKey && formatKey) tournamentByNameFormat.set(`${nameKey}|${formatKey}`, t);
  }

  const now = new Date();
  const byColor = new Map(colors.map((color) => [color, { entries: 0, wins: 0, top8: 0, placementSum: 0, weightedScore: 0 }]));
  let usedRows = 0;

  for (const row of standings) {
    const deckName = String(row.deck || "").trim();
    const placement = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
    if (!deckName || !Number.isFinite(placement) || placement <= 0) continue;

    let inferredColor = inferColorFromDeckName(deckName, leaderNameToColor);
    if (!inferredColor) inferredColor = inferColorFromDeckName(deckName, leaderAliasToColor);
    if (!inferredColor) {
      const leaderImage = String(row.leaderImage || "");
      const codeMatch = leaderImage.match(/([A-Z]{1,3}\d{2}-\d{3}[A-Z0-9_-]*)/i);
      const codeKey = normalizeText(codeMatch?.[1] || "");
      if (codeKey && leaderCodeToColor.has(codeKey)) inferredColor = leaderCodeToColor.get(codeKey);
    }
    if (!inferredColor) continue;

    const tName = normalizeText(row.tournament);
    const tFormat = normalizeText(row.format);
    const tournament = tournamentByNameFormat.get(`${tName}|${tFormat}`) || tournamentByName.get(tName);
    const players = parseNumber(tournament?.players, 64);
    const resultDate = parseDate(row.date || tournament?.date);
    const ageDays = resultDate ? daysBetween(now, resultDate) : 365;

    const placementWeight = 1 / placement;
    const sizeWeight = Math.log10(players + 1);
    const recencyWeight = Math.exp(-ageDays / 365);
    const styleWeight =
      playstyle === "aggro"
        ? placement <= 8
          ? 1.08
          : 1
        : playstyle === "control"
        ? placement <= 16
          ? 1.05
          : 1
        : 1;
    const budgetWeight = budgetMode ? (players <= 200 ? 1.08 : 0.96) : 1;
    const score = placementWeight * sizeWeight * recencyWeight * styleWeight * budgetWeight * 100;

    const ref = byColor.get(inferredColor);
    ref.entries += 1;
    ref.wins += placement === 1 ? 1 : 0;
    ref.top8 += placement <= 8 ? 1 : 0;
    ref.placementSum += placement;
    ref.weightedScore += score;
    usedRows += 1;
  }

  const totalEntries = Array.from(byColor.values()).reduce((sum, row) => sum + row.entries, 0);
  if (usedRows === 0 || totalEntries === 0) {
    return { colorStats: buildBestColorStatsFromCards(cards), usedRows: 0 };
  }

  const weightedAverages = colors.map((color) => {
    const ref = byColor.get(color);
    return ref.entries ? ref.weightedScore / ref.entries : 0;
  });
  const minWeighted = Math.min(...weightedAverages);
  const maxWeighted = Math.max(...weightedAverages);
  const weightedSpan = Math.max(0.001, maxWeighted - minWeighted);
  const avgPickRate = totalEntries / colors.length;

  const playstyleBias = {
    aggro: { red: 3, purple: 1.5, yellow: 1, green: 0.5, black: -1, blue: -2 },
    control: { blue: 3, black: 2, yellow: 1, purple: 0.5, green: -1, red: -2 },
    midrange: { green: 2, black: 1.2, blue: 1, red: 1, purple: 0.8, yellow: 0.2 },
  };
  const budgetBias = { red: 2, green: 1.5, purple: 0.8, black: 0.5, blue: -0.7, yellow: -1 };

  const rows = colors.map((color) => {
    const ref = byColor.get(color);
    const entries = ref.entries;
    const pickRate = totalEntries ? Number(((entries / totalEntries) * 100).toFixed(1)) : 0;
    const rawWinRate = entries ? Number(((ref.wins / entries) * 100).toFixed(1)) : 0;
    const top8Rate = entries ? Number(((ref.top8 / entries) * 100).toFixed(1)) : 0;
    const avgPlacement = entries ? Number((ref.placementSum / entries).toFixed(2)) : 99;
    const confidenceScore = clamp(Math.round(Math.log2(entries + 1) * 18), 5, 100);
    const weightedAvg = entries ? ref.weightedScore / entries : 0;
    const weightedNorm = (weightedAvg - minWeighted) / weightedSpan; // 0..1

    const styleBoost = playstyleBias[playstyle]?.[color] || 0;
    const budgetBoost = budgetMode ? budgetBias[color] || 0 : 0;
    const safeBoost = metaWeight === "safe" ? confidenceScore * 0.06 + (entries / avgPickRate) * 2.2 : 0;
    const counterBoost = metaWeight === "counter" ? ((entries < avgPickRate ? 3.5 : -2) + (50 - pickRate) * 0.04) : 0;
    const balancedBoost = metaWeight === "balanced" ? 0.8 : 0;

    // Win-rate ko weighted performance + top-cut trend + filters ke saath smooth kiya gaya hai.
    const winRate = clamp(
      Math.round(
        42 +
          weightedNorm * 18 +
          top8Rate * 0.08 +
          rawWinRate * 0.12 +
          styleBoost +
          budgetBoost +
          (metaWeight === "safe" ? 1.5 : metaWeight === "counter" ? -0.5 : 0)
      ),
      35,
      75
    );

    const consistency = clamp(Math.round(top8Rate * 0.45 + confidenceScore * 0.5 + (metaWeight === "safe" ? 4 : 0)));
    const metaFit = clamp(
      Math.round(
        46 +
          weightedNorm * 22 +
          top8Rate * 0.18 +
          styleBoost * 2 +
          budgetBoost * 1.5 +
          safeBoost +
          counterBoost +
          balancedBoost
      )
    );
    const badMatchups =
      winRate >= 60 ? 1 : winRate >= 55 ? 2 : winRate >= 50 ? 3 : 4;
    const finalRankScore = winRate * 0.52 + metaFit * 0.3 + consistency * 0.18;

    return {
      color,
      win_rate: winRate,
      pick_rate: pickRate,
      bad_matchups_count: badMatchups,
      consistency,
      skill_floor: color === "red" || color === "green" ? 6 : 7,
      skill_ceiling: color === "blue" || color === "yellow" ? 10 : 9,
      top_leaders: (leadersByColor.get(color) || []).slice(0, 3),
      meta_fit: metaFit,
      _rank_score: finalRankScore,
    };
  });

  return {
    colorStats: rows
      .sort((a, b) => b._rank_score - a._rank_score || b.win_rate - a.win_rate)
      .map(({ _rank_score, ...row }) => row),
    usedRows,
  };
};

// Yeh helper archetype ke hisaab se ideal target plan create karta hai.
const buildTargetPlan = ({ archetype, deckSize }) => {
  const targetsByArchetype = {
    aggro: {
      early: Math.round(deckSize * 0.44),
      mid: Math.round(deckSize * 0.36),
      late: Math.round(deckSize * 0.2),
      events: Math.round(deckSize * 0.12),
      blockers: Math.round(deckSize * 0.12),
      removal: Math.round(deckSize * 0.12),
      searchers: Math.round(deckSize * 0.1),
      finishers: Math.round(deckSize * 0.08),
    },
    control: {
      early: Math.round(deckSize * 0.3),
      mid: Math.round(deckSize * 0.4),
      late: Math.round(deckSize * 0.3),
      events: Math.round(deckSize * 0.2),
      blockers: Math.round(deckSize * 0.16),
      removal: Math.round(deckSize * 0.16),
      searchers: Math.round(deckSize * 0.1),
      finishers: Math.round(deckSize * 0.12),
    },
    midrange: {
      early: Math.round(deckSize * 0.36),
      mid: Math.round(deckSize * 0.4),
      late: Math.round(deckSize * 0.24),
      events: Math.round(deckSize * 0.16),
      blockers: Math.round(deckSize * 0.14),
      removal: Math.round(deckSize * 0.14),
      searchers: Math.round(deckSize * 0.1),
      finishers: Math.round(deckSize * 0.1),
    },
  };

  return {
    archetype,
    deckSize,
    targets: targetsByArchetype[archetype] || targetsByArchetype.midrange,
  };
};

// Yeh helper optimization suggestions se practical card swap pairs banata hai.
const buildNextBestSwaps = ({ optimizationSuggestions, expandedDeck, allCardsByCode }) => {
  const addPool = [];
  for (const suggestion of optimizationSuggestions) {
    if (suggestion.action !== "add") continue;
    for (const ref of suggestion.cards || []) {
      const card = allCardsByCode.get(ref.cardId);
      if (!card) continue;
      addPool.push({ ...card, reason: suggestion.reason });
    }
  }

  const uniqueAddPool = [];
  const seenAdd = new Set();
  for (const card of addPool) {
    if (seenAdd.has(card.card_code)) continue;
    seenAdd.add(card.card_code);
    uniqueAddPool.push(card);
  }

  const removePool = expandedDeck
    .filter((card) => card.cost >= 6 || card.counter_value === 0 || card.type === "stage")
    .sort((a, b) => b.cost - a.cost || a.counter_value - b.counter_value);

  const swaps = [];
  const usedRemove = new Set();
  for (const addCard of uniqueAddPool) {
    const removeCard = removePool.find((candidate) => !usedRemove.has(candidate.card_code));
    if (!removeCard) break;
    usedRemove.add(removeCard.card_code);

    const impact = clamp(
      Math.round(
        (addCard.counter_value > removeCard.counter_value ? 18 : 0) +
          (addCard.cost <= 3 && removeCard.cost >= 6 ? 20 : 0) +
          (detectCardRoles(addCard).includes("removal") ? 15 : 0) +
          (detectCardRoles(addCard).includes("blocker") ? 15 : 0) +
          25
      ),
      1,
      100
    );

    swaps.push({
      remove: { cardName: removeCard.name, cardId: removeCard.card_code },
      add: { cardName: addCard.name, cardId: addCard.card_code },
      reason: addCard.reason,
      expectedImpact: impact,
    });
    if (swaps.length >= 10) break;
  }

  return swaps;
};

// Yeh helper deck performance ke basis par matchup matrix score estimate karta hai.
const estimateDeckVsDeck = (deckA, deckB) => {
  if (deckA.deck === deckB.deck) return 50;

  const winDelta = (deckA.win_rate_estimate - deckB.win_rate_estimate) * 0.65;
  const top8Delta = (deckA.top8_rate - deckB.top8_rate) * 0.3;
  const placementDelta = ((deckB.avg_placement || 20) - (deckA.avg_placement || 20)) * 0.9;
  const confidenceAdjust = Math.min(4, Math.log2(Math.max(1, Math.min(deckA.entries, deckB.entries))));

  return clamp(Math.round(50 + winDelta + top8Delta + placementDelta + confidenceAdjust), 20, 80);
};

// Yeh helper standings data ko matrix-friendly ranked deck stats me convert karta hai.
const buildDeckStatsFromStandings = (standings) => {
  const byDeck = new Map();

  for (const row of standings) {
    const deck = String(row.deck || "").trim();
    const placement = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
    if (!deck || !Number.isFinite(placement) || placement <= 0) continue;

    if (!byDeck.has(deck)) {
      byDeck.set(deck, {
        deck,
        entries: 0,
        wins: 0,
        top8: 0,
        placement_sum: 0,
      });
    }

    const ref = byDeck.get(deck);
    ref.entries += 1;
    ref.wins += placement === 1 ? 1 : 0;
    ref.top8 += placement <= 8 ? 1 : 0;
    ref.placement_sum += placement;
  }

  return Array.from(byDeck.values())
    .map((item) => ({
      deck: item.deck,
      entries: item.entries,
      wins: item.wins,
      top8: item.top8,
      win_rate_estimate: Number(((item.wins / item.entries) * 100).toFixed(1)),
      top8_rate: Number(((item.top8 / item.entries) * 100).toFixed(1)),
      avg_placement: Number((item.placement_sum / item.entries).toFixed(2)),
    }))
    .sort((a, b) => {
      const scoreA = a.win_rate_estimate * 0.5 + a.top8_rate * 0.35 + (100 - a.avg_placement * 4) * 0.15;
      const scoreB = b.win_rate_estimate * 0.5 + b.top8_rate * 0.35 + (100 - b.avg_placement * 4) * 0.15;
      return scoreB - scoreA;
    });
};

// Yeh helper saved deck document se deck cards ko alag-alag schema variants se nikalta hai.
const normalizeSavedDeckCards = (savedDeck) => {
  const rawItems = Array.isArray(savedDeck?.deck_cards)
    ? savedDeck.deck_cards
    : Array.isArray(savedDeck?.decklist)
    ? savedDeck.decklist
    : Array.isArray(savedDeck?.deckCards)
    ? savedDeck.deckCards
    : [];

  return rawItems
    .map((item) => ({
      card_code: String(item?.card_code || item?.code || item?.id || "").trim(),
      count: parseNumber(item?.count ?? item?.qty ?? item?.quantity ?? item?.copies, 0),
    }))
    .filter((item) => item.card_code && item.count > 0);
};

// Yeh helper saved deck ko matrix/compare compatible pseudo-meta stats me convert karta hai.
const buildDeckStatFromSavedDeck = ({ savedDeck, cardsByCode }) => {
  const expanded = [];
  const normalizedItems = normalizeSavedDeckCards(savedDeck);
  for (const item of normalizedItems) {
    const code = String(item?.card_code || "").trim();
    const count = parseNumber(item?.count, 0);
    const card = cardsByCode.get(code);
    if (!card || count <= 0) continue;
    for (let i = 0; i < count; i += 1) expanded.push(card);
  }

  const total = expanded.length || 1;
  const counterDensity = Math.round((expanded.filter((c) => c.counter_value > 0).length / total) * 100);
  const lowCurve = Math.round((expanded.filter((c) => c.cost <= 3).length / total) * 100);
  const blockers = expanded.filter((c) => detectCardRoles(c).includes("blocker")).length;
  const removal = expanded.filter((c) => detectCardRoles(c).includes("removal")).length;
  const avgPlacementProxy = clamp(16 - (lowCurve * 0.06 + counterDensity * 0.04 + blockers * 0.08 + removal * 0.05), 2, 20);

  const winRate = clamp(40 + lowCurve * 0.14 + counterDensity * 0.08 + blockers * 0.25 + removal * 0.18, 35, 72);
  const top8 = clamp(22 + lowCurve * 0.12 + counterDensity * 0.1 + blockers * 0.35, 18, 70);
  const entries = 12;
  const wins = Math.max(1, Math.round((winRate / 100) * entries));
  const top8Count = Math.max(1, Math.round((top8 / 100) * entries));

  return {
    deck: savedDeck.deck_name,
    entries,
    wins,
    top8: top8Count,
    win_rate_estimate: Number(winRate.toFixed(1)),
    top8_rate: Number(top8.toFixed(1)),
    avg_placement: Number(avgPlacementProxy.toFixed(2)),
    is_custom: true,
    saved_deck_id: String(savedDeck._id),
  };
};

// Yeh endpoint matchup matrix ke liye dynamic deck-vs-deck grid return karta hai.
const getMatchupMatrix = async (req, res) => {
  try {
    const format = normalizeText(req.query?.format || req.body?.format || "");
    const limitRaw = req.query?.limit || req.body?.limit;
    const pageRaw = req.query?.page || req.body?.page;
    const dateFrom = req.query?.date_from || req.body?.date_from || null;
    const dateTo = req.query?.date_to || req.body?.date_to || null;
    const savedDeckId = String(req.query?.saved_deck_id || req.body?.saved_deck_id || "").trim();
    const deckQuery = normalizeText(req.query?.deck_query || req.body?.deck_query || "");

    const parsedLimit = parseNumber(limitRaw, 8);
    const limit = clamp(parsedLimit, 4, 30);
    const page = Math.max(1, parseNumber(pageRaw, 1));

    const cacheKey = `analytics:matchup-matrix:${JSON.stringify({
      format: format || "all",
      limit,
      page,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      savedDeckId: savedDeckId || null,
      deckQuery: deckQuery || null,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json({ ...cached, cache: "hit" });

    const standingsQuery = {};
    if (format && format !== "all") standingsQuery.format = format;
    if (dateFrom || dateTo) {
      standingsQuery.date = {};
      if (dateFrom) standingsQuery.date.$gte = dateFrom;
      if (dateTo) standingsQuery.date.$lte = dateTo;
    }

    const [standings, cardsRaw] = await Promise.all([
      standingsDb.find(standingsQuery).select(ANALYTICS_STANDING_FIELDS).lean(),
      cardsDb.find({}).select(ANALYTICS_CARD_FIELDS).lean(),
    ]);
    const cardsByCode = new Map(
      cardsRaw.filter(isCardActive).map(toInternalCard).map((card) => [card.card_code, card])
    );

    let rankedDecks = buildDeckStatsFromStandings(standings);

    if (deckQuery) {
      rankedDecks = rankedDecks.filter((row) => normalizeText(row.deck).includes(deckQuery));
    }

    const totalDecks = rankedDecks.length;
    const skip = (page - 1) * limit;
    rankedDecks = rankedDecks.slice(skip, skip + limit);

    if (savedDeckId && mongoose.Types.ObjectId.isValid(savedDeckId)) {
      const savedDeck = await savedDeckDb.findById(savedDeckId).lean();
      if (savedDeck) {
        const customDeckStat = buildDeckStatFromSavedDeck({ savedDeck, cardsByCode });
        const hasNameConflict = rankedDecks.some((deck) => deck.deck === customDeckStat.deck);
        if (hasNameConflict) {
          customDeckStat.deck = `${customDeckStat.deck} (Your Deck)`;
        }
        rankedDecks.unshift(customDeckStat);
      }
    }

    const uniqueByDeck = Array.from(new Map(rankedDecks.map((d) => [d.deck, d])).values());
    const rows = uniqueByDeck.map((d) => d.deck);
    const cols = uniqueByDeck.map((d) => d.deck);

    const deckByName = new Map(uniqueByDeck.map((d) => [d.deck, d]));
    const cells = [];
    for (const row of rows) {
      for (const col of cols) {
        const a = deckByName.get(row);
        const b = deckByName.get(col);
        if (!a || !b) continue;
        const value = estimateDeckVsDeck(a, b);
        const sampleSize = Math.max(1, Math.round(Math.min(a.entries, b.entries) * 1.8));
        cells.push({ row, col, value, sampleSize });
      }
    }

    const response = {
      filters: {
        format: format || "all",
        date_from: dateFrom,
        date_to: dateTo,
        deck_query: deckQuery || null,
        limit,
        page,
      },
      pagination: {
        total_decks: totalDecks,
        total_pages: Math.max(1, Math.ceil(totalDecks / limit)),
        has_next: skip + limit < totalDecks,
        has_prev: page > 1,
      },
      rows,
      cols,
      cells,
      decks: uniqueByDeck,
      generated_at: new Date().toISOString(),
      cache: "miss",
    };
    await cacheSetJson(cacheKey, response, ANALYTICS_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to build matchup matrix", error: error.message });
  }
};

// Yeh endpoint saved deck ko compare-friendly summary profile me return karta hai.
const getSavedDeckProfile = async (req, res) => {
  try {
    const deckId = String(req.params?.deckId || "").trim();
    if (!deckId) return res.status(400).json({ message: "deckId is required" });
    const cacheKey = `analytics:saved-deck-profile:${deckId}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const [savedDeck, cardsRaw] = await Promise.all([
      savedDeckDb.findById(deckId).lean(),
      cardsDb.find({}).select(ANALYTICS_CARD_FIELDS).lean(),
    ]);
    if (!savedDeck) return res.status(404).json({ message: "Saved deck not found" });

    const cardsByCode = new Map(cardsRaw.filter(isCardActive).map(toInternalCard).map((c) => [c.card_code, c]));
    const stat = buildDeckStatFromSavedDeck({ savedDeck, cardsByCode });

    const response = {
      deck: savedDeck.deck_name,
      summary: {
        entries: stat.entries,
        wins: stat.wins,
        top8: stat.top8,
        win_rate_estimate: stat.win_rate_estimate,
        top8_rate: stat.top8_rate,
        avg_placement: stat.avg_placement,
        tournaments_covered: stat.entries,
      },
      saved_deck_id: String(savedDeck._id),
      is_custom: true,
      generated_at: new Date().toISOString(),
    };
    await cacheSetJson(cacheKey, response, ANALYTICS_PROFILE_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to build saved deck profile", error: error.message });
  }
};

// Yeh endpoint best color finder ke liye analytics response return karta hai.
const bestColorFinder = async (req, res) => {
  try {
    const dateWindow = parseNumber(req.body?.dateWindow, 30);
    const requestedFormat = normalizeText(req.body?.format || "all");
    const playstyle = normalizeText(req.body?.playstyle || "midrange");
    const budgetMode = Boolean(req.body?.budgetMode);
    const metaWeight = normalizeText(req.body?.metaWeight || "balanced");
    const cacheKey = `analytics:best-color:${JSON.stringify({
      dateWindow,
      requestedFormat,
      playstyle,
      budgetMode,
      metaWeight,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - Math.max(1, dateWindow));
    const dateFromIso = dateFrom.toISOString().slice(0, 10);

    const standingsQuery = { date: { $gte: dateFromIso } };
    const tournamentsQuery = { date: { $gte: dateFromIso } };

    // Format sirf tab apply karenge jab actual set-format jaisa ho (e.g., OP14).
    if (requestedFormat && requestedFormat !== "all" && /^op\d+/i.test(requestedFormat)) {
      standingsQuery.format = requestedFormat.toUpperCase();
      tournamentsQuery.format = requestedFormat.toUpperCase();
    }

    let [cardsRaw, standings, tournaments] = await Promise.all([
      cardsDb.find({}).select(ANALYTICS_CARD_FIELDS).lean(),
      standingsDb.find(standingsQuery).select(ANALYTICS_STANDING_FIELDS).lean(),
      tournamentsDb.find(tournamentsQuery).select(ANALYTICS_TOURNAMENT_FIELDS).lean(),
    ]);

    // Agar selected window me data na mile to date filter hata kar broader meta try karo.
    if (standings.length === 0) {
      const broaderStandingsQuery = {};
      const broaderTournamentsQuery = {};
      if (requestedFormat && requestedFormat !== "all" && /^op\d+/i.test(requestedFormat)) {
        broaderStandingsQuery.format = requestedFormat.toUpperCase();
        broaderTournamentsQuery.format = requestedFormat.toUpperCase();
      }
      [standings, tournaments] = await Promise.all([
        standingsDb.find(broaderStandingsQuery).select(ANALYTICS_STANDING_FIELDS).lean(),
        tournamentsDb.find(broaderTournamentsQuery).select(ANALYTICS_TOURNAMENT_FIELDS).lean(),
      ]);
    }

    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const { colorStats, usedRows } = buildBestColorStatsFromMeta({
      standings,
      tournaments,
      cards: activeCards,
      playstyle,
      budgetMode,
      metaWeight,
    });
    const topColor = colorStats[0] || null;

    const response = {
      colorStats,
      topRecommendation: topColor,
      filters: {
        dateWindow,
        format: requestedFormat,
        playstyle,
        budgetMode,
        metaWeight,
      },
      source: usedRows > 0 ? "standings+tournaments" : "cards-derived",
      reasons: topColor
        ? [
            { type: "matchup", text: `Estimated ${topColor.bad_matchups_count} difficult matchup lanes in current matrix.` },
            { type: "trend", text: `Meta fit score ${topColor.meta_fit}/100 from recent ${dateWindow}-day results.` },
            { type: "consistency", text: `Consistency score ${topColor.consistency}/100 based on top-cut stability.` },
            { type: "meta", text: `Leader pool available: ${(topColor.top_leaders || []).length} strong options in this color.` },
          ]
        : [],
      generated_at: new Date().toISOString(),
    };
    await cacheSetJson(cacheKey, response, ANALYTICS_COLOR_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to compute best color stats", error: error.message });
  }
};

// Yeh endpoint selected inputs ke basis par best deck generate karta hai.
const generateBestDeck = async (req, res) => {
  try {
    const rawColorInput = normalizeText(req.body?.color || "red");
    const colorList = rawColorInput.split(/[\\/,&]/).map((part) => normalizeText(part)).filter(Boolean);
    const color = colorList[0] || "red";
    const playstyle = normalizeText(req.body?.playstyle || "balanced");
    const riskMode = normalizeText(req.body?.riskMode || "consistency");
    const metaContext = normalizeText(req.body?.metaContext || "balanced");
    const preferredLeader = normalizeText(req.body?.leader || "");
    const deckSize = clamp(parseNumber(req.body?.deckSize, 50), 40, 60);
    const cacheKey = `analytics:generate-best-deck:${JSON.stringify({
      color,
      playstyle,
      riskMode,
      metaContext,
      preferredLeader,
      deckSize,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const [cardsRaw, standingsRaw] = await Promise.all([
      cardsDb.find({}).select(ANALYTICS_CARD_FIELDS).lean(),
      standingsDb.find({}).select(ANALYTICS_STANDING_FIELDS).lean(),
    ]);
    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const matchesRequestedColor = (cardColor) =>
      colorList.some((col) => normalizeText(cardColor).includes(col));
    const colorPool = activeCards.filter(
      (card) => card.type !== "leader" && matchesRequestedColor(card.color)
    );
    const leaders = activeCards.filter((card) => card.type === "leader" && matchesRequestedColor(card.color));
    const metaLeaders = buildMetaLeaderRowsFromStandings({ standings: standingsRaw, cards: activeCards });

    const selectedLeader =
      leaders.find(
        (l) =>
          normalizeText(l.name).includes(preferredLeader) ||
          normalizeText(l.card_code).includes(preferredLeader)
      ) ||
      leaders.sort((a, b) => b.power - a.power)[0] ||
      null;

    const { deckCards: seedDeckCards } = generateDeckFromPool({
      pool: colorPool,
      deckSize,
      playstyle,
      riskMode,
      metaContext,
    });

    const colorTagLabel = colorList.join("/");
    const metaColorMatchesRequest = (meta) =>
      colorList.some((col) => normalizeText(meta.color).includes(col));
    const matchingColorLeaders = metaLeaders.filter(metaColorMatchesRequest);
    const liveMatchupLeaders =
      matchingColorLeaders.length > 0
        ? matchingColorLeaders
        : metaLeaders.length > 0
          ? metaLeaders
          : [{ leader: "Open Meta", color, top8Rate: 50, entries: 1, avgPlacement: 8 }];
    const matchupPreview = liveMatchupLeaders.slice(0, 5).map((meta) => {
      const colorAdjust = meta.color === color ? 3 : -1;
      const metaStrengthAdjust = Math.round(((meta.top8Rate || 50) - 50) * 0.1);
      const sampleAdjust = Math.round(Math.log2((meta.entries || 1) + 1));
      const placementAdjust = Math.round((10 - Math.min(10, meta.avgPlacement || 10)) * 0.4);
      return {
        leader: meta.leader,
        winRate: clamp(58 + colorAdjust - metaStrengthAdjust + sampleAdjust + placementAdjust, 35, 75),
      };
    });

    const aiRefined = await refineGeneratedDeckWithAI({
      color,
      colorList,
      playstyle,
      riskMode,
      metaContext,
      deckSize,
      selectedLeader,
      seedDeckCards,
      matchupPreview,
    });

    const deckCards = aiRefined?.deckCards || seedDeckCards;
    const total = deckCards.reduce((s, c) => s + c.count, 0) || 1;
    const eventCount = deckCards.filter((c) => c.role === "Removal").reduce((s, c) => s + c.count, 0);
    const blockerCount = deckCards.filter((c) => c.role === "Blocker").reduce((s, c) => s + c.count, 0);
    const lowCost = deckCards.filter((c) => c.cost <= 3).reduce((s, c) => s + c.count, 0);
    const avgCost = deckCards.reduce((s, c) => s + c.cost * c.count, 0) / total;
    const counterDensity = Math.round((deckCards.reduce((s, c) => s + (c.counter > 0 ? c.count : 0), 0) / total) * 100);
    const finisherCount = deckCards.filter((c) => c.cost >= 7).reduce((s, c) => s + c.count, 0);

    const optimizationScore = clamp(
      Math.round(
        35 +
          Math.min(25, lowCost * 0.5) +
          Math.min(15, blockerCount * 1.5) +
          Math.min(15, eventCount * 1.1) +
          Math.min(10, counterDensity * 0.08) +
          (aiRefined ? 4 : 0)
      )
    );

    const analytics = {
      consistency: clamp(Math.round(65 + counterDensity * 0.2)),
      tempo: clamp(Math.round(55 + (lowCost / total) * 100 * 0.5)),
      control: clamp(Math.round(45 + (eventCount / total) * 100 * 1.2)),
      lateGame: clamp(Math.round(50 + finisherCount * 3)),
      brickRisk: clamp(Math.round(22 - lowCost * 0.4), 5, 50),
      counterDensity,
    };

    const curveMap = new Map();
    for (const card of deckCards) curveMap.set(card.cost, (curveMap.get(card.cost) || 0) + card.count);
    const curve = Array.from({ length: 9 }).map((_, idx) => {
      const cost = idx < 8 ? idx + 1 : "9+";
      const count = idx < 8 ? curveMap.get(idx + 1) || 0 : deckCards.filter((c) => c.cost >= 9).reduce((s, c) => s + c.count, 0);
      return { cost, count };
    });

    const insights = aiRefined?.insights?.length
      ? aiRefined.insights
      : [
      `Curve tuned for ${playstyle} profile with avg cost ${avgCost.toFixed(1)}.`,
      `Counter density at ${counterDensity}% for defensive stability.`,
      `Event/removal package includes ${eventCount} slots for board interaction.`,
      `Blocker coverage at ${blockerCount} improves aggro survivability.`,
      `Estimated optimization score ${optimizationScore}/100 under ${metaContext} meta context.`,
    ];

    const response = {
      leader: selectedLeader
        ? { name: selectedLeader.name, code: selectedLeader.card_code, image_url: selectedLeader.image_url }
        : null,
      tags: aiRefined?.tags?.length ? aiRefined.tags : [playstyle, riskMode, colorTagLabel || color],
      optimizationScore,
      analytics,
      deckCards,
      insights,
      curve,
      matchupPreview,
      generationMode: aiRefined ? "ai-refined" : "heuristic",
      generationProvider: aiRefined?.provider || null,
      generated_at: new Date().toISOString(),
    };
    await cacheSetJson(cacheKey, response, ANALYTICS_GENERATE_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to generate best deck", error: error.message });
  }
};

// Yeh endpoint provided decklist ko analyze karke optimization output deta hai.
const optimizeDeck = async (req, res) => {
  try {
    const leader = req.body?.leader || null;
    const deckItems = normalizeDeckItems(req.body?.decklist || req.body?.deck_cards || req.body?.deckCards);
    const deckSize = parseNumber(req.body?.deck_size, 50);

    if (deckItems.length === 0) {
      return res.status(400).json({ message: "decklist/deck_cards is required and must not be empty" });
    }
    const deckSignature = deckItems
      .map((item) => `${item.card_code}:${item.count}`)
      .sort()
      .join("|");
    const cacheKey = `analytics:optimize:${JSON.stringify({
      leader_code: normalizeText(leader?.card_code || leader?.id || leader?.name || ""),
      leader_color: normalizeText(leader?.color || ""),
      deckSize,
      deckSignature,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const [cardsRaw, standingsRaw] = await Promise.all([
      cardsDb.find({}).select(ANALYTICS_CARD_FIELDS).lean(),
      standingsDb.find({}).select(ANALYTICS_STANDING_FIELDS).lean(),
    ]);
    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const allCardsByCode = new Map(activeCards.map((card) => [card.card_code, card]));
    const metaLeaders = buildMetaLeaderRowsFromStandings({ standings: standingsRaw, cards: activeCards });

    // Build deck from provided full decklist first; fallback to DB lookup by id.
    const expandedDeck = [];
    for (const item of deckItems) {
      const providedCardLooksComplete = Boolean(item.card && item.card.card_code && item.card.name);
      const sourceCard = providedCardLooksComplete ? item.card : allCardsByCode.get(item.card_code);
      if (!sourceCard) continue;
      const card = toInternalCard(sourceCard);
      for (let i = 0; i < item.count; i += 1) expandedDeck.push(card);
    }

    const costCurve = buildCostCurve(expandedDeck);
    const roleBreakdown = computeRoleBreakdown(expandedDeck);
    const synergyScore = computeSynergy(expandedDeck, leader);
    const consistencyScore = computeConsistency({ expandedDeck, costCurve, roleBreakdown });
    const metaFitScore = computeMetaFit({ leader, roleBreakdown, costCurve, consistencyScore, metaLeaders });
    const weaknesses = findWeaknesses({ roleBreakdown, costCurve, expandedDeck });

    const leaderColor = normalizeText(leader?.color || "");
    const removalDensity = expandedDeck.length ? Math.round((roleBreakdown.roleCounts.removal / expandedDeck.length) * 100) : 0;
    const blockerDensity = expandedDeck.length ? Math.round((roleBreakdown.roleCounts.blockers / expandedDeck.length) * 100) : 0;
    const archetype = inferArchetype({
      lowCostDensity: costCurve.phases.earlyGame.percent,
      avgCost: parseNumber(
        expandedDeck.length
          ? expandedDeck.reduce((sum, c) => sum + c.cost, 0) / expandedDeck.length
          : 0
      ),
      removalDensity,
      blockerDensity,
    });
    const optimizationSuggestions = buildOptimizationSuggestions({
      weaknesses,
      expandedDeck,
      allCards: activeCards,
      leaderColor,
    });
    const recommendedCards = buildRecommendedCards(optimizationSuggestions, allCardsByCode);
    const targetPlan = buildTargetPlan({ archetype, deckSize: Math.max(deckSize, expandedDeck.length || 50) });
    const nextBestSwaps = buildNextBestSwaps({ optimizationSuggestions, expandedDeck, allCardsByCode });

    // Backward-compat suggestions for existing deck builder widget
    const suggestions = optimizationSuggestions.map((item) => ({
      title: item.action === "remove" ? "Cards to Remove" : "Cards to Add",
      detail: item.reason,
      candidates: (item.cards || [])
        .map((cardRef) => allCardsByCode.get(cardRef.cardId))
        .filter(Boolean),
    }));

    // Keep deck_power for existing UI card.
    const deckPowerScore = clamp(
      Math.round(
        consistencyScore.score * 0.4 +
          synergyScore.score * 0.25 +
          metaFitScore.score * 0.25 +
          clamp(Math.round((expandedDeck.length / Math.max(deckSize, 50)) * 100)) * 0.1
      )
    );

    const aiRefined = await refineOptimizedDeckWithAI({
      leader,
      expandedDeck,
      costCurve,
      roleBreakdown,
      synergyScore,
      consistencyScore,
      metaFitScore,
      weaknesses,
      targetPlan,
      nextBestSwaps,
      recommendedCards,
      deckPowerScore,
    });

    const response = {
      costCurve,
      roleBreakdown,
      synergyScore,
      consistencyScore: aiRefined?.consistencyScore?.score
        ? {
            ...consistencyScore,
            score: clamp(parseNumber(aiRefined.consistencyScore.score, consistencyScore.score)),
            aiExplanation: String(aiRefined.consistencyScore.explanation || "").trim(),
          }
        : consistencyScore,
      metaFitScore: aiRefined?.metaFitScore?.score
        ? {
            ...metaFitScore,
            score: clamp(parseNumber(aiRefined.metaFitScore.score, metaFitScore.score)),
            estimatedWinPercent: clamp(parseNumber(aiRefined.metaFitScore.estimatedWinPercent, metaFitScore.score), 1, 99),
            aiExplanation: String(aiRefined.metaFitScore.explanation || "").trim(),
          }
        : {
            ...metaFitScore,
            estimatedWinPercent: clamp(parseNumber(metaFitScore.score, 50), 1, 99),
          },
      weaknesses: aiRefined?.weaknesses?.length ? aiRefined.weaknesses : weaknesses,
      targetPlan,
      optimizationSuggestions,
      nextBestSwaps: aiRefined?.nextBestSwaps?.length ? aiRefined.nextBestSwaps : nextBestSwaps,
      recommendedCards: aiRefined?.recommendedCards?.length ? aiRefined.recommendedCards : recommendedCards,
      deck_power: {
        score: aiRefined?.deckPower?.score
          ? clamp(parseNumber(aiRefined.deckPower.score, deckPowerScore))
          : deckPowerScore,
        tier:
          String(aiRefined?.deckPower?.tier || "").trim() ||
          (deckPowerScore >= 85 ? "S" : deckPowerScore >= 70 ? "A" : deckPowerScore >= 55 ? "B" : deckPowerScore >= 40 ? "C" : "D"),
      },
      suggestions,
      ai_summary: aiRefined?.summary || "",
      ai_insights: aiRefined?.insights || [],
      pilot_profile: aiRefined?.pilotProfile || null,
      analysis_mode: aiRefined ? "ai-refined" : "heuristic",
      analysis_provider: aiRefined?.provider || null,
      analysis_model: aiRefined?.model || null,
      generated_at: new Date().toISOString(),
    };
    await cacheSetJson(cacheKey, response, ANALYTICS_OPTIMIZE_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to optimize deck", error: error.message });
  }
};

const compareDecksWithAI = async (req, res) => {
  try {
    const deckA = req.body?.deckA || null;
    const deckB = req.body?.deckB || null;

    if (!deckA || !deckB) {
      return res.status(400).json({ message: "deckA and deckB are required" });
    }

    const normalizeCompareDeck = (deck) => ({
      name: String(deck?.name || "").trim(),
      source: String(deck?.source || "").trim(),
      leaderName: String(deck?.leaderName || "").trim(),
      leaderCode: String(deck?.leaderCode || "").trim(),
      color: String(deck?.color || "").trim(),
      baselineWinRate: clamp(parseNumber(deck?.baselineWinRate, 50), 1, 99),
      cards: normalizeDeckItems(deck?.cards || deck?.deck_cards || [])
        .slice(0, 25)
        .map((item) => ({
          card_code: item.card_code,
          count: item.count,
        })),
    });

    const normalizedA = normalizeCompareDeck(deckA);
    const normalizedB = normalizeCompareDeck(deckB);

    if (!normalizedA.name || normalizedA.cards.length === 0 || !normalizedB.name || normalizedB.cards.length === 0) {
      return res.status(400).json({ message: "Both decks must include a name and at least one card." });
    }

    const cacheKey = `analytics:compare-ai:${JSON.stringify({
      providerPreference: String(process.env.AI_PROVIDER || "").trim().toLowerCase() || "auto",
      deckA: normalizedA,
      deckB: normalizedB,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const prompt = `
You are a One Piece TCG matchup analyst.

Compare these two decks and estimate which deck is more likely to win in a head-to-head matchup.

Deck A:
${JSON.stringify(normalizedA, null, 2)}

Deck B:
${JSON.stringify(normalizedB, null, 2)}

Instructions:
- Return only valid JSON.
- deckAWinPercent and deckBWinPercent must sum to 100.
- Use real matchup logic: speed, curve, interaction, consistency, leader fit, and card package.
- summary should clearly say which deck is favored and why.
- explanation must be 3 to 5 short reasons.
- Match this schema exactly:
${COMPARE_DECKS_SHAPE_GUIDE}
    `.trim();

    const { content, provider } = await requestProviderChatWithFallback(
      [
        {
          role: "system",
          content:
            "You are a sharp One Piece TCG matchup specialist. Return only structured JSON and keep probabilities realistic.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      {
        temperature: 0.35,
        responseFormat: { type: "json_object" },
      }
    );

    const parsed = tryParseJsonObject(content);
    if (!parsed) {
      throw new Error(`${provider.label} returned an unreadable compare payload.`);
    }

    let deckAWinPercent = clamp(parseNumber(parsed.deckAWinPercent, 50), 1, 99);
    let deckBWinPercent = clamp(parseNumber(parsed.deckBWinPercent, 50), 1, 99);
    const total = deckAWinPercent + deckBWinPercent;
    if (total !== 100) {
      deckAWinPercent = clamp(Math.round((deckAWinPercent / total) * 100), 1, 99);
      deckBWinPercent = 100 - deckAWinPercent;
    }

    const response = {
      provider: provider.name,
      model: provider.defaultModel,
      deckAWinPercent,
      deckBWinPercent,
      summary: String(parsed.summary || "").trim(),
      explanation: Array.isArray(parsed.explanation)
        ? parsed.explanation.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
        : [],
      generated_at: new Date().toISOString(),
    };

    await cacheSetJson(cacheKey, response, ANALYTICS_COMPARE_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      message: error?.message || "Failed to compare decks with AI",
    });
  }
};

module.exports = {
  getMatchupMatrix,
  getSavedDeckProfile,
  bestColorFinder,
  generateBestDeck,
  optimizeDeck,
  compareDecksWithAI,
};
