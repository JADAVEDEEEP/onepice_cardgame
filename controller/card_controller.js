const cards_db = require("../model/cards_db");
const { cacheGetJson, cacheSetJson } = require("../config/cache");

const CARDS_CACHE_TTL_MS = Math.max(5_000, Number(process.env.CARDS_CACHE_TTL_MS) || 300_000);

// Yeh function database se saare cards nikal kar client ko JSON me bhejta hai.
const getCards = async (req, res) => {
  try {
    const cacheKey = "cards:all";
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    // Yahan cards collection par simple find() chalaya gaya hai.
    const cards = await cards_db.find();
    await cacheSetJson(cacheKey, cards, CARDS_CACHE_TTL_MS);
    // Yahan final cards list response me return ho rahi hai.
    return res.json(cards);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch cards", error: error.message });
  }
};
module.exports = {
  getCards,
};
