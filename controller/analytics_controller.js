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
  optimizeDeck,
};
