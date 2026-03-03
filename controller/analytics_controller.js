const cardsDb = require("../model/cards_db");

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const normalizeText = (value) => String(value || "").trim().toLowerCase();

const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));

const isCardActive = (card) => {
  const status = normalizeText(card?.tournament_status || card?.tournamentStatus || card?.status || card?.legality);
  if (status.includes("banned") || status.includes("forbidden") || status.includes("suspended")) return false;
  if (card?.is_banned === true || card?.banned === true) return false;
  return true;
};

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

const inferArchetype = ({ lowCostDensity, avgCost, removalDensity, blockerDensity }) => {
  if (lowCostDensity >= 45 && avgCost <= 3) return "aggro";
  if (removalDensity >= 18 || blockerDensity >= 14) return "control";
  return "midrange";
};

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

const computeMetaFit = ({ leader, roleBreakdown, costCurve, consistencyScore }) => {
  const metaLeaders = [
    { leader: "Red Aggro", color: "red", style: "rush" },
    { leader: "Blue Control", color: "blue", style: "control" },
    { leader: "Purple Ramp", color: "purple", style: "ramp" },
    { leader: "Black Midrange", color: "black", style: "midrange" },
    { leader: "Yellow Value", color: "yellow", style: "tempo" },
  ];

  const leaderColor = normalizeText(leader?.color || "red");
  const blockers = roleBreakdown.roleCounts.blockers;
  const removal = roleBreakdown.roleCounts.removal;
  const early = costCurve.phases.earlyGame.percent;

  const colorMatrix = {
    red: { red: 50, blue: 46, purple: 54, black: 52, yellow: 56 },
    blue: { red: 54, blue: 50, purple: 51, black: 49, yellow: 53 },
    purple: { red: 46, blue: 49, purple: 50, black: 51, yellow: 48 },
    black: { red: 48, blue: 51, purple: 49, black: 50, yellow: 52 },
    yellow: { red: 44, blue: 47, purple: 52, black: 48, yellow: 50 },
    green: { red: 47, blue: 50, purple: 50, black: 49, yellow: 51 },
  };

  const byLeader = metaLeaders.map((meta) => {
    const base = colorMatrix[leaderColor]?.[meta.color] ?? 50;
    const roleAdjust = Math.round((blockers >= 8 ? 2 : -2) + (removal >= 8 ? 2 : -2) + (early >= 30 ? 2 : -2));
    const consistencyAdjust = Math.round((consistencyScore.score - 50) * 0.12);
    const estimatedWinRate = clamp(base + roleAdjust + consistencyAdjust, 20, 80);

    return {
      metaLeader: meta.leader,
      estimatedWinRate,
      confidence: estimatedWinRate >= 58 ? "high" : estimatedWinRate >= 50 ? "medium" : "low",
    };
  });

  const overall = Math.round(byLeader.reduce((sum, row) => sum + row.estimatedWinRate, 0) / byLeader.length);
  return { score: clamp(overall), byLeader };
};

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

const getRoleLabel = (card) => {
  const roles = detectCardRoles(card);
  if (roles.includes("removal")) return "Removal";
  if (roles.includes("searcher") || roles.includes("draw")) return "Draw";
  if (roles.includes("blocker")) return "Blocker";
  if (roles.includes("finisher")) return "Finisher";
  return "Engine";
};

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

const buildBestColorStats = (cards) => {
  const colors = ["red", "blue", "green", "purple", "black", "yellow"];
  const matchupBase = {
    red: { bad: 2, fit: 64 },
    blue: { bad: 2, fit: 61 },
    green: { bad: 3, fit: 57 },
    purple: { bad: 2, fit: 60 },
    black: { bad: 3, fit: 56 },
    yellow: { bad: 4, fit: 54 },
  };

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

    return {
      color,
      win_rate: winRate,
      pick_rate: pickRate,
      bad_matchups_count: matchupBase[color].bad,
      consistency,
      skill_floor: color === "red" || color === "green" ? 6 : 7,
      skill_ceiling: color === "blue" || color === "yellow" ? 10 : 9,
      top_leaders: leaders,
      meta_fit: matchupBase[color].fit,
    };
  });

  return rows.sort((a, b) => b.win_rate - a.win_rate);
};

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

const bestColorFinder = async (req, res) => {
  try {
    const cardsRaw = await cardsDb.find({}).lean();
    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const colorStats = buildBestColorStats(activeCards);
    const topColor = colorStats[0] || null;

    return res.json({
      colorStats,
      topRecommendation: topColor,
      reasons: topColor
        ? [
            { type: "matchup", text: `Favorable profile with only ${topColor.bad_matchups_count} difficult matchups` },
            { type: "trend", text: `Meta fit score ${topColor.meta_fit}/100 for current tournament environment` },
            { type: "consistency", text: `Consistency score ${topColor.consistency}/100 for reliable performance` },
            { type: "meta", text: `Leader pool available: ${(topColor.top_leaders || []).length} strong options` },
          ]
        : [],
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to compute best color stats", error: error.message });
  }
};

const generateBestDeck = async (req, res) => {
  try {
    const color = normalizeText(req.body?.color || "red");
    const playstyle = normalizeText(req.body?.playstyle || "balanced");
    const riskMode = normalizeText(req.body?.riskMode || "consistency");
    const metaContext = normalizeText(req.body?.metaContext || "balanced");
    const preferredLeader = normalizeText(req.body?.leader || "");
    const deckSize = clamp(parseNumber(req.body?.deckSize, 50), 40, 60);

    const cardsRaw = await cardsDb.find({}).lean();
    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const colorPool = activeCards.filter((card) => card.color === color && card.type !== "leader");
    const leaders = activeCards.filter((card) => card.color === color && card.type === "leader");

    const selectedLeader =
      leaders.find((l) => normalizeText(l.name).includes(preferredLeader)) ||
      leaders.sort((a, b) => b.power - a.power)[0] ||
      null;

    const { deckCards } = generateDeckFromPool({
      pool: colorPool,
      deckSize,
      playstyle,
      riskMode,
      metaContext,
    });

    const total = deckCards.reduce((s, c) => s + c.count, 0) || 1;
    const eventCount = deckCards.filter((c) => c.role === "Removal").reduce((s, c) => s + c.count, 0);
    const blockerCount = deckCards.filter((c) => c.role === "Blocker").reduce((s, c) => s + c.count, 0);
    const lowCost = deckCards.filter((c) => c.cost <= 3).reduce((s, c) => s + c.count, 0);
    const avgCost = deckCards.reduce((s, c) => s + c.cost * c.count, 0) / total;
    const counterDensity = Math.round((deckCards.reduce((s, c) => s + (c.counter > 0 ? c.count : 0), 0) / total) * 100);

    const optimizationScore = clamp(
      Math.round(
        35 +
          Math.min(25, lowCost * 0.5) +
          Math.min(15, blockerCount * 1.5) +
          Math.min(15, eventCount * 1.1) +
          Math.min(10, counterDensity * 0.08)
      )
    );

    const analytics = {
      consistency: clamp(Math.round(65 + counterDensity * 0.2)),
      tempo: clamp(Math.round(55 + (lowCost / total) * 100 * 0.5)),
      control: clamp(Math.round(45 + (eventCount / total) * 100 * 1.2)),
      lateGame: clamp(Math.round(50 + deckCards.filter((c) => c.cost >= 7).reduce((s, c) => s + c.count, 0) * 3)),
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

    const matchupBase = {
      red: [66, 60, 58, 63, 55],
      blue: [57, 64, 61, 59, 62],
      green: [61, 58, 57, 60, 59],
      purple: [59, 60, 63, 57, 58],
      black: [58, 59, 60, 62, 56],
      yellow: [55, 57, 58, 56, 64],
    };

    const matchupLeaders = ["Red Aggro", "Blue Control", "Purple Ramp", "Black Midrange", "Yellow Value"];
    const matchupPreview = matchupLeaders.map((leader, idx) => ({
      leader,
      winRate: clamp((matchupBase[color] || matchupBase.red)[idx] + Math.round((optimizationScore - 70) * 0.08), 35, 75),
    }));

    const insights = [
      `Curve tuned for ${playstyle} profile with avg cost ${avgCost.toFixed(1)}.`,
      `Counter density at ${counterDensity}% for defensive stability.`,
      `Event/removal package includes ${eventCount} slots for board interaction.`,
      `Blocker coverage at ${blockerCount} improves aggro survivability.`,
      `Estimated optimization score ${optimizationScore}/100 under ${metaContext} meta context.`,
    ];

    return res.json({
      leader: selectedLeader
        ? { name: selectedLeader.name, code: selectedLeader.card_code, image_url: selectedLeader.image_url }
        : null,
      tags: [playstyle, riskMode, color],
      optimizationScore,
      analytics,
      deckCards,
      insights,
      curve,
      matchupPreview,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to generate best deck", error: error.message });
  }
};

const optimizeDeck = async (req, res) => {
  try {
    const leader = req.body?.leader || null;
    const deckItems = normalizeDeckItems(req.body?.decklist || req.body?.deck_cards || req.body?.deckCards);
    const deckSize = parseNumber(req.body?.deck_size, 50);

    if (deckItems.length === 0) {
      return res.status(400).json({ message: "decklist/deck_cards is required and must not be empty" });
    }

    const cardsRaw = await cardsDb.find({}).lean();
    const activeCards = cardsRaw.filter(isCardActive).map(toInternalCard);
    const allCardsByCode = new Map(activeCards.map((card) => [card.card_code, card]));

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
    const metaFitScore = computeMetaFit({ leader, roleBreakdown, costCurve, consistencyScore });
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

    return res.json({
      costCurve,
      roleBreakdown,
      synergyScore,
      consistencyScore,
      metaFitScore,
      weaknesses,
      targetPlan,
      optimizationSuggestions,
      nextBestSwaps,
      recommendedCards,
      deck_power: {
        score: deckPowerScore,
        tier: deckPowerScore >= 85 ? "S" : deckPowerScore >= 70 ? "A" : deckPowerScore >= 55 ? "B" : deckPowerScore >= 40 ? "C" : "D",
      },
      suggestions,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to optimize deck", error: error.message });
  }
};

module.exports = {
  bestColorFinder,
  generateBestDeck,
  optimizeDeck,
};
