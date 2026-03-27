const metaLeaderDb = require("../model/meta_leader_db");
const cardsDb = require("../model/cards_db");
const { cacheGetJson, cacheSetJson } = require("../config/cache");

const META_LEADERS_CACHE_TTL_MS = Math.max(5_000, Number(process.env.META_LEADERS_CACHE_TTL_MS) || 120_000);

const normalizeLeaderCode = (value) => String(value || "").trim().replace(/^1x/i, "");
const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const extractNameFromEffect = (effect) => {
  const raw = String(effect || "").trim();
  if (!raw) return "";
  return String(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  ).trim();
};

const resolveCardName = (card, fallbackCode = "") => {
  const direct = String(card?.name || "").trim();
  if (direct) return direct;
  const fromEffect = extractNameFromEffect(card?.effect);
  if (fromEffect) return fromEffect;
  return String(fallbackCode || "").trim();
};

const averageCopiesFromPresence = (presence) => {
  const parsed = parseNumber(presence, 0);
  return Number((parsed / 100).toFixed(1));
};

const deriveCategory = (card, leaderWinRate) => {
  const presence = parseNumber(card?.avgPresence, 0);
  const winRate = parseNumber(card?.avgWinRate, 0);

  if (presence >= 300) return "Core";
  if (presence >= 200) return "Situational";
  if (presence >= 100 && winRate >= leaderWinRate) return "Sleeper";
  if (presence < 100 && winRate >= Math.max(0, leaderWinRate - 3)) return "Tech";
  return "Cope";
};

const buildCardLookup = (cards) =>
  new Map(
    cards.map((card) => [
      String(card?.id || "").trim(),
      {
        id: String(card?.id || "").trim(),
        name: resolveCardName(card, card?.id),
        image: String(card?.img_full_url || card?.img_url || "").trim(),
        img_url: String(card?.img_url || "").trim(),
        img_full_url: String(card?.img_full_url || "").trim(),
        category: String(card?.category || "").trim(),
        rarity: String(card?.rarity || "").trim(),
        cost: typeof card?.cost === "number" ? card.cost : null,
        types: Array.isArray(card?.types) ? card.types : [],
        colors: Array.isArray(card?.colors) ? card.colors : [],
        effect: String(card?.effect || "").trim(),
      },
    ])
  );

const buildLeaderSummary = (leader, leaderCard) => ({
  id: normalizeLeaderCode(leader?.leader),
  name: String(leaderCard?.name || normalizeLeaderCode(leader?.leader)).trim(),
  number: normalizeLeaderCode(leader?.leader),
  color: Array.isArray(leaderCard?.colors) ? leaderCard.colors.join("/") : "",
  image: String(leaderCard?.img_full_url || leaderCard?.img_url || "").trim(),
  winRate: parseNumber(leader?.winRate, 0),
  metaShare: parseNumber(leader?.popularity, 0),
  matches: parseNumber(leader?.number_of_matches, 0),
  avgDuration: parseNumber(leader?.avgDuration, 0),
  totalCards: parseNumber(leader?.totalCards, 0),
  setName: String(leader?.setName || "").trim(),
});

const buildLeaderDetail = (leader, leaderCard, cardLookup) => {
  const leaderCode = normalizeLeaderCode(leader?.leader);
  const leaderWinRate = parseNumber(leader?.winRate, 0);
  const rawCards = Array.isArray(leader?.cards) ? leader.cards : [];

  const cards = rawCards
    .map((entry, index) => {
      const code = String(entry?.card || "").trim();
      const baseCard = cardLookup.get(code);
      return {
        id: `${leaderCode}-${code}-${index}`,
        code,
        number: code,
        name: String(baseCard?.name || code).trim(),
        image: String(baseCard?.image || "").trim(),
        thumbnail: String(baseCard?.img_url || "").trim(),
        type: String(baseCard?.category || "Character"),
        cost: typeof baseCard?.cost === "number" ? baseCard.cost : 0,
        rarity: String(baseCard?.rarity || "C").trim(),
        avgCopies: averageCopiesFromPresence(entry?.avgPresence),
        presence: parseNumber(entry?.avgPresence, 0),
        avgWinRate: parseNumber(entry?.avgWinRate, 0),
        category: deriveCategory(entry, leaderWinRate),
        totalMatches: parseNumber(entry?.totalMatches, 0),
        totalWins: parseNumber(entry?.totalWins, 0),
        quantities: entry?.quantities || {},
        mulliganInfo: entry?.mulliganInfo || {},
        colors: Array.isArray(baseCard?.colors) ? baseCard.colors : [],
      };
    })
    .sort((a, b) => b.presence - a.presence || b.avgWinRate - a.avgWinRate);

  return {
    leader: buildLeaderSummary(leader, leaderCard),
    stats: {
      wins: parseNumber(leader?.wins, 0),
      losses: parseNumber(leader?.losses, 0),
      number_of_matches: parseNumber(leader?.number_of_matches, 0),
      duration: parseNumber(leader?.duration, 0),
      winRate: leaderWinRate,
      avgDuration: parseNumber(leader?.avgDuration, 0),
      popularity: parseNumber(leader?.popularity, 0),
      totalCards: parseNumber(leader?.totalCards, 0),
      setName: String(leader?.setName || "").trim(),
      debug: leader?.debug || {},
    },
    cards,
    grouped_cards: {
      Core: cards.filter((card) => card.category === "Core"),
      Situational: cards.filter((card) => card.category === "Situational"),
      Sleeper: cards.filter((card) => card.category === "Sleeper"),
      Cope: cards.filter((card) => card.category === "Cope"),
      Tech: cards.filter((card) => card.category === "Tech"),
    },
  };
};

const findLeaderDocument = async (leaderCode) => {
  const normalized = normalizeLeaderCode(leaderCode);
  const pattern = new RegExp(`^(?:1x)?${escapeRegex(normalized)}$`, "i");
  return metaLeaderDb.findOne({ leader: pattern }).lean();
};

const listMetaLeaders = async (req, res) => {
  try {
    const cacheKey = "meta:leaders:list";
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const leaders = await metaLeaderDb
      .find()
      .sort({ popularity: -1, winRate: -1 })
      .select("leader winRate popularity number_of_matches avgDuration totalCards setName")
      .lean();
    const leaderCodes = leaders.map((leader) => normalizeLeaderCode(leader?.leader)).filter(Boolean);
    const leaderCards = await cardsDb.find({ id: { $in: leaderCodes } }).select("id name effect img_url img_full_url colors").lean();
    const leaderCardLookup = buildCardLookup(leaderCards);

    const response = {
      leaders: leaders.map((leader) => buildLeaderSummary(leader, leaderCardLookup.get(normalizeLeaderCode(leader?.leader)))),
      count: leaders.length,
    };

    await cacheSetJson(cacheKey, response, META_LEADERS_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch meta leaders", error: error.message });
  }
};

const getMetaLeaderByCode = async (req, res) => {
  try {
    const leaderCode = normalizeLeaderCode(req.params?.leaderCode);
    if (!leaderCode) return res.status(400).json({ message: "leaderCode is required" });

    const cacheKey = `meta:leaders:${leaderCode}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const leader = await findLeaderDocument(leaderCode);
    if (!leader) return res.status(404).json({ message: "Meta leader not found" });

    const cardCodes = Array.from(
      new Set([
        leaderCode,
        ...(Array.isArray(leader?.cards) ? leader.cards.map((entry) => String(entry?.card || "").trim()) : []),
      ].filter(Boolean))
    );

    const cards = await cardsDb
      .find({ id: { $in: cardCodes } })
      .select("id name effect img_url img_full_url colors category rarity cost types")
      .lean();

    const cardLookup = buildCardLookup(cards);
    const response = buildLeaderDetail(leader, cardLookup.get(leaderCode), cardLookup);
    await cacheSetJson(cacheKey, response, META_LEADERS_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch meta leader", error: error.message });
  }
};

module.exports = {
  listMetaLeaders,
  getMetaLeaderByCode,
};
