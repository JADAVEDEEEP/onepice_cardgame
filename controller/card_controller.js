const cards_db = require("../model/cards_db");
const { cacheGetJson, cacheSetJson } = require("../config/cache");

const CARDS_CACHE_TTL_MS = Math.max(5_000, Number(process.env.CARDS_CACHE_TTL_MS) || 300_000);
const OFFICIAL_CARD_IMAGE_BASE = "https://en.onepiece-cardgame.com/images/cardlist/card";

// Yeh function database se saare cards nikal kar client ko JSON me bhejta hai.
const getCards = async (req, res) => {
  try {
    const cacheKey = "cards:all";
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    // Yahan cards collection par simple find() chalaya gaya hai.
    const cards = await cards_db.find().lean();
    await cacheSetJson(cacheKey, cards, CARDS_CACHE_TTL_MS);
    // Yahan final cards list response me return ho rahi hai.
    return res.json(cards);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch cards", error: error.message });
  }
};

const getCardImage = async (req, res) => {
  try {
    const rawCode = String(req.params.cardCode || "").trim();
    if (!rawCode) {
      return res.status(400).json({ message: "cardCode is required" });
    }

    const sanitizedCode = rawCode.replace(/[^A-Za-z0-9_-]/g, "");
    const baseCode = sanitizedCode.replace(/_p\d+$/i, "");
    const candidates = Array.from(
      new Set([
        `${OFFICIAL_CARD_IMAGE_BASE}/${sanitizedCode}.png`,
        `${OFFICIAL_CARD_IMAGE_BASE}/${sanitizedCode}.jpg`,
        sanitizedCode !== baseCode ? `${OFFICIAL_CARD_IMAGE_BASE}/${baseCode}.png` : "",
        sanitizedCode !== baseCode ? `${OFFICIAL_CARD_IMAGE_BASE}/${baseCode}.jpg` : "",
      ].filter(Boolean))
    );

    for (const url of candidates) {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "DeckLab-Image-Proxy/1.0",
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });

      if (!response.ok) {
        continue;
      }

      const contentType = response.headers.get("content-type") || "image/png";
      const arrayBuffer = await response.arrayBuffer();

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(Buffer.from(arrayBuffer));
    }

    return res.status(404).json({ message: `Card image not found for ${sanitizedCode}` });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch card image", error: error.message });
  }
};

module.exports = {
  getCards,
  getCardImage,
};
