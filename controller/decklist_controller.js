const decklistDb = require("../model/decklist_db");
const cardsDb = require("../model/cards_db");
const { cacheGetJson, cacheSetJson } = require("../config/cache");

const DECKLIST_CACHE_TTL_MS = Math.max(5_000, Number(process.env.DECKLIST_CACHE_TTL_MS) || 120_000);

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseDeckCodeEntry = (entry) => {
  const raw = String(entry || "").trim();
  const match = raw.match(/^(\d+)x(.+)$/i);
  if (!match) {
    return {
      raw,
      count: 1,
      code: raw,
    };
  }

  return {
    raw,
    count: parseNumber(match[1], 1),
    code: String(match[2] || "").trim(),
  };
};

const buildCardLookup = (cards) =>
  new Map(
    cards.map((card) => [
      String(card?.id || "").trim(),
      {
        code: String(card?.id || "").trim(),
        name: String(card?.name || "").trim(),
        image: String(card?.img_full_url || card?.img_url || "").trim(),
        thumbnail: String(card?.img_url || "").trim(),
        category: String(card?.category || "").trim(),
      },
    ])
  );

const enrichDeckEntry = (entry, cardLookup) => {
  const sourceDeck = Array.isArray(entry?.deck) ? entry.deck : [];
  const deck_cards = sourceDeck.map((item) => {
    const parsed = parseDeckCodeEntry(item);
    const card = cardLookup.get(parsed.code);

    return {
      raw: parsed.raw,
      code: parsed.code,
      count: parsed.count,
      name: card?.name || parsed.code,
      image: card?.image || "",
      thumbnail: card?.thumbnail || "",
      category: card?.category || "",
    };
  });

  return {
    ...entry,
    deck_cards,
  };
};

const enrichDecklistRecord = (record, cardLookup) => {
  const leaderCode = String(record?.leader || record?.card_id || "").trim();
  const leader = cardLookup.get(leaderCode);
  const leaderName = leader?.name || leaderCode;

  return {
    ...record,
    leader: leaderName,
    card_id: String(record?.card_id || leaderCode).trim(),
    leader_code: leaderCode,
    leader_name: leaderName,
    leader_image: leader?.image || "",
    leader_thumbnail: leader?.thumbnail || "",
    leader_details: leader || null,
    decklists: (Array.isArray(record?.decklists) ? record.decklists : []).map((deck) =>
      enrichDeckEntry(deck, cardLookup)
    ),
  };
};

const listDecklists = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseNumber(req.query?.limit, 100)));
    const page = Math.max(1, parseNumber(req.query?.page, 1));
    const skip = (page - 1) * limit;
    const leader = String(req.query?.leader || "").trim();
    const setName = String(req.query?.setName || "").trim();

    const query = {};
    if (leader) query.leader = leader;
    if (setName) query.setName = setName;

    const cacheKey = `decklists:${JSON.stringify({
      leader: leader || null,
      setName: setName || null,
      page,
      limit,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    const [decklists, total] = await Promise.all([
      decklistDb
        .find(query)
        .sort({ leader: 1, card_id: 1 })
        .skip(skip)
        .limit(limit)
        .select("leader card_id image leaderCard setName leaderWinRate totalDecklists decklists url")
        .lean(),
      decklistDb.countDocuments(query),
    ]);

    const cardCodes = new Set();
    for (const record of decklists) {
      if (record?.leader) cardCodes.add(String(record.leader).trim());
      const sourceDecklists = Array.isArray(record?.decklists) ? record.decklists : [];
      for (const deck of sourceDecklists) {
        const sourceDeck = Array.isArray(deck?.deck) ? deck.deck : [];
        for (const item of sourceDeck) {
          const parsed = parseDeckCodeEntry(item);
          if (parsed.code) cardCodes.add(parsed.code);
        }
      }
    }

    const cards = await cardsDb
      .find({ id: { $in: Array.from(cardCodes) } })
      .select("id name img_url img_full_url category")
      .lean();

    const cardLookup = buildCardLookup(cards);
    const enrichedDecklists = decklists.map((record) => enrichDecklistRecord(record, cardLookup));

    const response = {
      decklists: enrichedDecklists,
      count: enrichedDecklists.length,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
        has_next: skip + limit < total,
        has_prev: page > 1,
      },
      filters: {
        leader: leader || null,
        setName: setName || null,
      },
    };

    await cacheSetJson(cacheKey, response, DECKLIST_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({
      message: "Failed to fetch decklists",
      error: error.message,
    });
  }
};

module.exports = {
  listDecklists,
};
