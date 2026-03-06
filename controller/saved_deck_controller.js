const savedDeckDb = require("../model/saved_decks_db");
const mongoose = require("mongoose");

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

// Yeh helper saved deck payload ke different field formats ko ek hi shape me normalize karta hai.
const normalizeSavedDeckItems = (body = {}) => {
  const sourceCards = Array.isArray(body?.deck_cards)
    ? body.deck_cards
    : Array.isArray(body?.decklist)
    ? body.decklist
    : Array.isArray(body?.deckCards)
    ? body.deckCards
    : [];

  return sourceCards
    .map((item) => ({
      card_code: String(item?.card_code || item?.code || item?.id || "").trim(),
      count: parseNumber(item?.count ?? item?.qty ?? item?.quantity ?? item?.copies, 0),
    }))
    .filter((item) => item.card_code && item.count > 0);
};

// Yeh endpoint public app ke liye deck save karta hai (without user auth).
const saveDeck = async (req, res) => {
  try {
    const deckNameRaw = String(req.body?.deck_name || "").trim();
    const leader = req.body?.leader || {};
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const notes = String(req.body?.notes || "").trim();

    const normalizedCards = normalizeSavedDeckItems(req.body);

    if (normalizedCards.length === 0) {
      return res.status(400).json({ message: "deck_cards/decklist is required and must not be empty" });
    }

    const deckSize = normalizedCards.reduce((sum, item) => sum + item.count, 0);
    if (deckSize > 60) {
      return res.status(400).json({ message: "deck_size too large; expected 50 or close variants" });
    }

    const defaultName = `Public Deck ${new Date().toISOString().slice(0, 10)}`;
    const payload = {
      deck_name: deckNameRaw || defaultName,
      leader: {
        card_code: String(leader?.card_code || leader?.code || "").trim(),
        name: String(leader?.name || "").trim(),
        color: String(leader?.color || "").trim().toLowerCase(),
      },
      deck_cards: normalizedCards,
      // Backward compatibility: purane consumers decklist field padte hain.
      decklist: normalizedCards,
      tags: tags.map((tag) => String(tag || "").trim()).filter(Boolean),
      notes,
      deck_size: deckSize,
      source: "public",
    };

    const saved = await savedDeckDb.create(payload);

    return res.status(201).json({
      message: "Deck saved successfully",
      deck_id: saved._id,
      deck_name: saved.deck_name,
      deck_size: saved.deck_size,
      created_at: saved.createdAt,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save deck", error: error.message });
  }
};

// Yeh endpoint latest saved public decks list karta hai.
const listSavedDecks = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseNumber(req.query?.limit, 20)));
    const page = Math.max(1, parseNumber(req.query?.page, 1));
    const skip = (page - 1) * limit;
    const queryText = String(req.query?.q || "").trim();

    const query = {};
    if (queryText) {
      query.$or = [
        { deck_name: { $regex: queryText, $options: "i" } },
        { "leader.name": { $regex: queryText, $options: "i" } },
        { "leader.card_code": { $regex: queryText, $options: "i" } },
      ];
    }

    const [decks, total] = await Promise.all([
      savedDeckDb
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("deck_name leader deck_size tags createdAt updatedAt")
        .lean(),
      savedDeckDb.countDocuments(query),
    ]);

    return res.json({
      decks,
      count: decks.length,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
        has_next: skip + limit < total,
        has_prev: page > 1,
      },
      filters: {
        q: queryText || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch saved decks", error: error.message });
  }
};

// Yeh endpoint saved deck ko update karta hai (public mode, no auth).
const updateSavedDeck = async (req, res) => {
  try {
    const deckId = String(req.params?.deckId || "").trim();
    if (!deckId) return res.status(400).json({ message: "deckId is required" });
    if (!mongoose.Types.ObjectId.isValid(deckId)) {
      return res.status(400).json({ message: "Invalid deckId" });
    }

    const existing = await savedDeckDb.findById(deckId).lean();
    if (!existing) return res.status(404).json({ message: "Saved deck not found" });

    const deckNameRaw = String(req.body?.deck_name || "").trim();
    const leader = req.body?.leader || {};
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const notes = req.body?.notes != null ? String(req.body?.notes || "").trim() : existing.notes || "";
    const normalizedCards = normalizeSavedDeckItems(req.body);

    const updatePayload = {
      ...(deckNameRaw ? { deck_name: deckNameRaw } : {}),
      ...(req.body?.leader
        ? {
            leader: {
              card_code: String(leader?.card_code || leader?.code || "").trim(),
              name: String(leader?.name || "").trim(),
              color: String(leader?.color || "").trim().toLowerCase(),
            },
          }
        : {}),
      ...(req.body?.tags ? { tags: tags.map((tag) => String(tag || "").trim()).filter(Boolean) } : {}),
      ...(req.body?.notes != null ? { notes } : {}),
    };

    if (normalizedCards.length > 0) {
      const deckSize = normalizedCards.reduce((sum, item) => sum + item.count, 0);
      if (deckSize > 60) {
        return res.status(400).json({ message: "deck_size too large; expected 50 or close variants" });
      }
      updatePayload.deck_cards = normalizedCards;
      updatePayload.decklist = normalizedCards;
      updatePayload.deck_size = deckSize;
    }

    const updated = await savedDeckDb
      .findByIdAndUpdate(deckId, { $set: updatePayload }, { new: true })
      .select("deck_name leader deck_cards deck_size tags notes createdAt updatedAt")
      .lean();

    return res.json({
      message: "Deck updated successfully",
      deck: updated,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update saved deck", error: error.message });
  }
};

// Yeh endpoint ek specific saved deck ka full detail return karta hai.
const getSavedDeckById = async (req, res) => {
  try {
    const deckId = String(req.params?.deckId || "").trim();
    if (!deckId) return res.status(400).json({ message: "deckId is required" });
    if (!mongoose.Types.ObjectId.isValid(deckId)) {
      return res.status(400).json({ message: "Invalid deckId" });
    }

    const deck = await savedDeckDb.findById(deckId).lean();
    if (!deck) return res.status(404).json({ message: "Saved deck not found" });

    return res.json(deck);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch saved deck", error: error.message });
  }
};

// Yeh endpoint saved deck delete karta hai.
const deleteSavedDeck = async (req, res) => {
  try {
    const deckId = String(req.params?.deckId || "").trim();
    if (!deckId) return res.status(400).json({ message: "deckId is required" });
    if (!mongoose.Types.ObjectId.isValid(deckId)) {
      return res.status(400).json({ message: "Invalid deckId" });
    }

    const deleted = await savedDeckDb.findByIdAndDelete(deckId);
    if (!deleted) return res.status(404).json({ message: "Saved deck not found" });

    return res.json({ message: "Deck deleted successfully", deck_id: deckId });
  } catch (error) {
    return res.status(500).json({ message: "Failed to delete saved deck", error: error.message });
  }
};

module.exports = {
  saveDeck,
  listSavedDecks,
  getSavedDeckById,
  updateSavedDeck,
  deleteSavedDeck,
};
