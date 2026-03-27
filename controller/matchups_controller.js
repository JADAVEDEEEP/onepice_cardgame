const matchupsDb = require("../model/matchups_db");
const cardsDb = require("../model/cards_db");

const normalizeLeaderCode = (value) => String(value || "").trim().replace(/^1x/i, "");
const parseNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const looksLikeCardCode = (value) => /^[A-Z]{2,}\d{2}-\d+/i.test(String(value || "").trim());

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
  if (direct && !looksLikeCardCode(direct)) return direct;
  const fromEffect = extractNameFromEffect(card?.effect);
  if (fromEffect) return fromEffect;
  return String(fallbackCode || "").trim();
};

const buildCardLookup = (cards) =>
  new Map(
    cards.map((card) => [
      String(card?.id || "").trim(),
      {
        id: String(card?.id || "").trim(),
        name: resolveCardName(card, card?.id),
        image: String(card?.img_full_url || card?.img_url || "").trim(),
        thumbnail: String(card?.img_url || "").trim(),
        colors: Array.isArray(card?.colors) ? card.colors : [],
      },
    ])
  );

const buildProxyImageUrl = (req, code) => {
  const normalized = normalizeLeaderCode(code);
  if (!looksLikeCardCode(normalized)) return "";
  return `${req.protocol}://${req.get("host")}/cardsApi/image/${encodeURIComponent(normalized)}`;
};

const enrichLeader = (req, item, cardLookup) => {
  const leaderCode = normalizeLeaderCode(item?.leader);
  const leaderCard = cardLookup.get(leaderCode);
  const rawMatchups = Array.isArray(item?.matchups) ? item.matchups : [];

  return {
    leader: String(item?.leader || "").trim(),
    leader_code: leaderCode,
    leader_name: resolveCardName(leaderCard, leaderCode),
    leader_image: buildProxyImageUrl(req, leaderCode),
    leader_thumbnail: String(leaderCard?.thumbnail || "").trim(),
    colors: Array.isArray(leaderCard?.colors) ? leaderCard.colors : [],
    wins: parseNumber(item?.wins, 0),
    losses: parseNumber(item?.losses, 0),
    number_of_matches: parseNumber(item?.number_of_matches, 0),
    duration: parseNumber(item?.duration, 0),
    winRate: parseNumber(item?.winRate, 0),
    avgDuration: parseNumber(item?.avgDuration, 0),
    popularity: parseNumber(item?.popularity, 0),
    matchups: rawMatchups.map((matchup) => {
      const opponentCode = normalizeLeaderCode(matchup?.opponent);
      const opponentCard = cardLookup.get(opponentCode);
      return {
        opponent: String(matchup?.opponent || "").trim(),
        opponent_code: opponentCode,
        opponent_name: looksLikeCardCode(opponentCode)
          ? resolveCardName(opponentCard, opponentCode)
          : String(matchup?.opponent || "").trim(),
        opponent_image: buildProxyImageUrl(req, opponentCode),
        opponent_thumbnail: String(opponentCard?.thumbnail || "").trim(),
        wins: parseNumber(matchup?.wins, 0),
        losses: parseNumber(matchup?.losses, 0),
        games: parseNumber(matchup?.games, 0),
        winRate: parseNumber(matchup?.winRate, 0),
        first_wr: parseNumber(matchup?.first_wr, 0),
        second_wr: parseNumber(matchup?.second_wr, 0),
        first_games: parseNumber(matchup?.first_games, 0),
        second_games: parseNumber(matchup?.second_games, 0),
      };
    }),
  };
};

const getMatchups = async (req, res) => {
  try {
    const dataset = await matchupsDb.findOne().sort({ updatedAt: -1, createdAt: -1 }).lean();
    if (!dataset) {
      return res.status(404).json({ message: "Matchup dataset not found" });
    }

    const leaders = Array.isArray(dataset?.matchups) ? dataset.matchups : [];
    const cardCodes = Array.from(
      new Set(
        leaders
          .flatMap((leader) => [
            normalizeLeaderCode(leader?.leader),
            ...(Array.isArray(leader?.matchups)
              ? leader.matchups.map((matchup) => normalizeLeaderCode(matchup?.opponent))
              : []),
          ])
          .filter((code) => looksLikeCardCode(code))
      )
    );

    const cards = await cardsDb
      .find({ id: { $in: cardCodes } })
      .select("id name effect img_url img_full_url colors")
      .lean();

    const cardLookup = buildCardLookup(cards);

    return res.json({
      _id: dataset?._id,
      total_matches: parseNumber(dataset?.total_matches, 0),
      matchups: leaders.map((leader) => enrichLeader(req, leader, cardLookup)),
      count: leaders.length,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch matchups", error: error.message });
  }
};

module.exports = {
  getMatchups,
};
