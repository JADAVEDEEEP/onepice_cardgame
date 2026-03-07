// standings collection ka model import (deck placements yaha se aate hain)
const standingsDb = require("../model/standings_db");
// tournaments collection ka model import (event metadata yaha se aata hai)
const tournamentsDb = require("../model/tournaments_db");
const { cacheGetJson, cacheSetJson } = require("../config/cache");

const META_CACHE_TTL_MS = Math.max(5_000, parseInt(process.env.META_CACHE_TTL_MS || "120000", 10));

// Generic helper: value ko number me convert karta hai
// Agar value invalid ho to fallback return karta hai
const parseNumber = (value, fallback = 0) => {
  // Agar already number hai to finite check ke baad return
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;

  // Agar string hai (jaise "1,000") to numeric part nikalta hai
  if (typeof value === "string") {
    // Non-numeric chars hata ke Number me convert
    const numeric = Number(value.replace(/[^0-9.-]/g, ""));
    // Finite hua to numeric, warna fallback
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  // Na number na string -> fallback
  return fallback;
};

// Text normalize helper: trim + lowercase
// Isse maps me case-insensitive matching easy ho jata hai
const normalize = (value) => String(value || "").trim().toLowerCase();

// Date parser helper: invalid date ho to null
const parseDate = (value) => {
  // JS Date object banaya
  const date = new Date(value);
  // Invalid date check
  return Number.isNaN(date.getTime()) ? null : date;
};

// 2 dates ke beech days difference nikalta hai
// Negative na ho isliye Math.max(0, ...)
const daysBetween = (d1, d2) => Math.max(0, Math.floor((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));

// API: GET /meta/best-deck
// Purpose: standings + tournaments ke basis pe top decks score karke return karna
const getBestDeck = async (req, res) => {
  try {
    // Query params read kar rahe hain
    const { format, date_from, date_to, region, country, min_players, limit } = req.query;
    const cacheKey = `meta:best-deck:${JSON.stringify({
      format: format || null,
      date_from: date_from || null,
      date_to: date_to || null,
      region: region || null,
      country: country || null,
      min_players: min_players || null,
      limit: limit || null,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);
    // min_players ko safe number me parse kiya
    const minPlayers = parseNumber(min_players, 0);

    // Standings query object build ho raha hai
    const standingsQuery = {};

    // Agar format ???? hai to standings pe format filter lagao
    if (format) standingsQuery.format = format;

    // Date range filter agar ??? hai to standings query me add karo
    if (date_from || date_to) {
      standingsQuery.date = {};
      if (date_from) standingsQuery.date.$gte = date_from;
      if (date_to) standingsQuery.date.$lte = date_to;
    }

    // Tournaments query object alag se build ho raha hai
    const tournamentsQuery = {};

    // Agar format ???? hai to tournament pe bhi apply karo
    if (format) tournamentsQuery.format = format;

    // Date range tournament query pe bhi apply
    if (date_from || date_to) {
      tournamentsQuery.date = {};
      if (date_from) tournamentsQuery.date.$gte = date_from;
      if (date_to) tournamentsQuery.date.$lte = date_to;
    }

    // Optional region/country filters
    if (region) tournamentsQuery.region = region;
    if (country) tournamentsQuery.country = country;

    // Dono collections parallel me fetch kar rahe hain performance ke liye
    const [standings, tournaments] = await Promise.all([
      standingsDb.find(standingsQuery).lean(),
      tournamentsDb.find(tournamentsQuery).lean(),
    ]);

    // Tournament lookup maps ban rahe hain fast matching ke liye
    const tournamentByName = new Map();
    const tournamentByNameFormat = new Map();
    const tournamentByNameDateFormat = new Map();

    // Har tournament ko normalized keys se map me store karo
    for (const tournament of tournaments) {
      const nameKey = normalize(tournament.name);
      const formatKey = normalize(tournament.format);
      const dateKey = normalize(tournament.date);

      // Basic name match map
      if (nameKey) tournamentByName.set(nameKey, tournament);

      // Name + format match map
      if (nameKey && formatKey) tournamentByNameFormat.set(`${nameKey}|${formatKey}`, tournament);

      // Name + date + format strict match map
      if (nameKey && dateKey && formatKey) {
        tournamentByNameDateFormat.set(`${nameKey}|${dateKey}|${formatKey}`, tournament);
      }
    }

    // Current date for recency weight
    const now = new Date();

    // Deck-level aggregate scores yaha store honge
    const deckScores = new Map();

    // Format-wise deck aggregates yaha store honge
    const formatScores = new Map();

    // Kitni rows scoring me use hui count
    let usedRows = 0;

    // Har standing row process kar rahe hain
    for (const standing of standings) {
      // Deck name sanitize
      const deck = String(standing.deck || "").trim();

      // Deck missing ho to row skip
      if (!deck) continue;

      // Placement safe parse
      const placement = parseNumber(standing.placement, Number.MAX_SAFE_INTEGER);

      // Invalid placement ho to skip
      if (!Number.isFinite(placement) || placement <= 0) continue;

      // Matching keys normalize karo
      const standingName = normalize(standing.tournament);
      const standingDate = normalize(standing.date);
      const standingFormat = normalize(standing.format || format);

      // Tournament lookup strict -> medium -> basic fallback order me
      const tournament =
        tournamentByNameDateFormat.get(`${standingName}|${standingDate}|${standingFormat}`) ||
        tournamentByNameFormat.get(`${standingName}|${standingFormat}`) ||
        tournamentByName.get(standingName);

      // Region/country filter diya ho aur tournament match na mile to skip
      if ((region || country) && !tournament) continue;

      // Players count tournament se lo, nahi to default 64
      const players = parseNumber(tournament?.players, 64);

      // Min players threshold se kam ho to row ignore
      if (players < minPlayers) continue;

      // Result date standings se lo, warna tournament date use karo
      const resultDate = parseDate(standing.date || tournament?.date);

      // Kitne din purana result hai
      const ageDays = resultDate ? daysBetween(now, resultDate) : 365;

      // Scoring factors:
      // placementWeight: 1st place sabse high
      const placementWeight = 1 / placement;

      // sizeWeight: bade tournament ko zyada weight
      const sizeWeight = Math.log10(players + 1);

      // eventWeight: very large event bonus
      const eventWeight = players >= 1000 ? 1.25 : players >= 500 ? 1.15 : players >= 200 ? 1.08 : 1;

      // recencyWeight: naya result zyada valuable
      const recencyWeight = Math.exp(-ageDays / 365);

      // Final row score
      const score = placementWeight * sizeWeight * eventWeight * recencyWeight * 100;

      // Row format fallback chain
      const rowFormat = standing.format || tournament?.format || "UNKNOWN";

      // Deck key normalize for map stability
      const deckKey = normalize(deck);

      // Agar deck aggregate exist nahi karta to initialize karo
      if (!deckScores.has(deckKey)) {
        deckScores.set(deckKey, {
          deck,
          total_score: 0,
          entries: 0,
          wins: 0,
          top8: 0,
          placement_sum: 0,
          weighted_players: 0,
          formats: new Set(),
        });
      }

      // Existing aggregate lo aur update karo
      const aggregate = deckScores.get(deckKey);
      aggregate.total_score += score;
      aggregate.entries += 1;
      aggregate.wins += placement === 1 ? 1 : 0;
      aggregate.top8 += placement <= 8 ? 1 : 0;
      aggregate.placement_sum += placement;
      aggregate.weighted_players += players;
      aggregate.formats.add(rowFormat);

      // Format-wise map initialize karo agar missing ho
      if (!formatScores.has(rowFormat)) formatScores.set(rowFormat, new Map());
      const byFormat = formatScores.get(rowFormat);

      // Format map me is deck ka entry initialize karo
      if (!byFormat.has(deckKey)) byFormat.set(deckKey, { deck, total_score: 0, entries: 0, wins: 0 });
      const fmt = byFormat.get(deckKey);

      // Format aggregate update
      fmt.total_score += score;
      fmt.entries += 1;
      fmt.wins += placement === 1 ? 1 : 0;

      // Used row count badhao
      usedRows += 1;
    }

    // deckScores map ko ranked array me convert kar rahe hain
    const rankedDecks = Array.from(deckScores.values())
      .map((item) => ({
        deck: item.deck,
        total_score: Number(item.total_score.toFixed(2)),
        entries: item.entries,
        wins: item.wins,
        top8: item.top8,
        avg_placement: Number((item.placement_sum / item.entries).toFixed(2)),
        avg_players: Math.round(item.weighted_players / item.entries),
        win_rate_estimate: Number(((item.wins / item.entries) * 100).toFixed(1)),
        top8_rate: Number(((item.top8 / item.entries) * 100).toFixed(1)),
        formats: Array.from(item.formats),
      }))
      // Highest score first sort
      .sort((a, b) => b.total_score - a.total_score);

    // Har format ka top deck nikal rahe hain
    const bestByFormat = Array.from(formatScores.entries())
      .map(([fmt, map]) => {
        // Is format ke decks score desc order me
        const ranked = Array.from(map.values()).sort((a, b) => b.total_score - a.total_score);
        const top = ranked[0];
        if (!top) return null;
        return {
          format: fmt,
          deck: top.deck,
          total_score: Number(top.total_score.toFixed(2)),
          entries: top.entries,
          wins: top.wins,
        };
      })
      // null entries hatao
      .filter(Boolean);

    const parsedLimit = String(limit || "").toLowerCase() === "all" ? null : parseNumber(limit, 10);
    const safeLimit = parsedLimit && parsedLimit > 0 ? parsedLimit : 10;

    // Final response object
    const response = {
      filters: {
        format: format || null,
        date_from: date_from || null,
        date_to: date_to || null,
        region: region || null,
        country: country || null,
        min_players: minPlayers || null,
      },
      summary: {
        standings_rows_scanned: standings.length,
        tournaments_rows_scanned: tournaments.length,
        rows_used_for_scoring: usedRows,
      },
      overall_best_deck: rankedDecks[0] || null,
      best_by_format: bestByFormat,
      ranked_decks: parsedLimit === null ? rankedDecks : rankedDecks.slice(0, safeLimit),
      top_10_ranked_decks: rankedDecks.slice(0, 10),
      generated_at: new Date().toISOString(),
    };

    // Success response send
    await cacheSetJson(cacheKey, response, META_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    // Unexpected failure case
    return res.status(500).json({ message: "Failed to compute best deck", error: error.message });
  }
};

// API: GET /meta/deck/:deckName
// Purpose: ek specific deck ka detailed analytics profile dena
const getDeckDetails = async (req, res) => {
  try {
    // Path param se deck name read
    const deckNameRaw = String(req.params.deckName || "").trim();

    // Empty deck name reject
    if (!deckNameRaw) {
      return res.status(400).json({ message: "deckName is required" });
    }

    // Optional query filters
    const { format, date_from, date_to } = req.query;
    const cacheKey = `meta:deck-details:${JSON.stringify({
      deck: deckNameRaw,
      format: format || null,
      date_from: date_from || null,
      date_to: date_to || null,
    })}`;
    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json(cached);

    // Regex-safe exact match (case-insensitive)
    const deckRegex = new RegExp(`^${deckNameRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

    // Standings query start with deck filter
    const standingsQuery = { deck: deckRegex };

    // Format/date filters add
    if (format) standingsQuery.format = format;
    if (date_from || date_to) {
      standingsQuery.date = {};
      if (date_from) standingsQuery.date.$gte = date_from;
      if (date_to) standingsQuery.date.$lte = date_to;
    }

    // Matching standings rows fetch
    const standings = await standingsDb.find(standingsQuery).lean();

    // No data found case
    if (standings.length === 0) {
      return res.status(404).json({ message: `No standings data found for deck '${deckNameRaw}'` });
    }

    // Unique tournament names count ke liye
    const tournamentNames = Array.from(
      new Set(standings.map((row) => normalize(row.tournament)).filter(Boolean))
    );

    // Tournament docs fetch using raw tournament names
    const tournaments = await tournamentsDb
      .find({ name: { $in: standings.map((row) => row.tournament).filter(Boolean) } })
      .lean();

    // Quick tournament lookup map
    const tournamentByName = new Map(tournaments.map((t) => [normalize(t.name), t]));

    // Valid placements list banai
    const placements = standings
      .map((row) => parseNumber(row.placement, Number.MAX_SAFE_INTEGER))
      .filter((value) => Number.isFinite(value) && value > 0);

    // Summary stats
    const wins = placements.filter((p) => p === 1).length;
    const top8 = placements.filter((p) => p <= 8).length;
    const avgPlacement = placements.length
      ? Number((placements.reduce((sum, p) => sum + p, 0) / placements.length).toFixed(2))
      : null;

    // Format-wise bucket ban raha hai
    const byFormat = new Map();
    for (const row of standings) {
      const key = row.format || "UNKNOWN";

      // New format bucket init
      if (!byFormat.has(key)) byFormat.set(key, { format: key, entries: 0, wins: 0, top8: 0, placementSum: 0 });
      const ref = byFormat.get(key);

      // Placement parse and aggregate update
      const p = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
      ref.entries += 1;
      if (p === 1) ref.wins += 1;
      if (p <= 8) ref.top8 += 1;
      if (Number.isFinite(p) && p > 0) ref.placementSum += p;
    }

    // Format buckets ko response-ready objects me convert
    const formatBreakdown = Array.from(byFormat.values()).map((item) => ({
      format: item.format,
      entries: item.entries,
      wins: item.wins,
      top8: item.top8,
      top8_rate: Number(((item.top8 / item.entries) * 100).toFixed(1)),
      win_rate_estimate: Number(((item.wins / item.entries) * 100).toFixed(1)),
      avg_placement: item.entries ? Number((item.placementSum / item.entries).toFixed(2)) : null,
    }));

    // Player-wise deck performance aggregate
    const byPlayer = new Map();
    for (const row of standings) {
      const player = row.player || "Unknown";

      // Player bucket init
      if (!byPlayer.has(player)) byPlayer.set(player, { player, entries: 0, wins: 0, best_placement: Number.MAX_SAFE_INTEGER });
      const ref = byPlayer.get(player);

      // Player stats update
      const p = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
      ref.entries += 1;
      if (p === 1) ref.wins += 1;
      if (p < ref.best_placement) ref.best_placement = p;
    }

    // Top 10 players choose based on wins -> best placement -> entries
    const topPlayers = Array.from(byPlayer.values())
      .sort((a, b) => b.wins - a.wins || a.best_placement - b.best_placement || b.entries - a.entries)
      .slice(0, 10)
      .map((p) => ({ ...p, best_placement: Number.isFinite(p.best_placement) ? p.best_placement : null }));

    // Recent results list with tournament metadata merge
    const recentResults = standings
      .map((row) => {
        const t = tournamentByName.get(normalize(row.tournament));
        return {
          tournament: row.tournament || null,
          date: row.date || t?.date || null,
          format: row.format || t?.format || null,
          region: t?.region || null,
          country: t?.country || null,
          players: parseNumber(t?.players, null),
          player: row.player || null,
          placement: parseNumber(row.placement, null),
          link: t?.link || null,
        };
      })
      .sort((a, b) => {
        // Newest date first sort
        const da = parseDate(a.date);
        const db = parseDate(b.date);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.getTime() - da.getTime();
      })
      // Latest 30 results only
      .slice(0, 30);

    // Final deck-details response
    const response = {
      deck: standings[0].deck || deckNameRaw,
      summary: {
        entries: standings.length,
        wins,
        top8,
        win_rate_estimate: Number(((wins / standings.length) * 100).toFixed(1)),
        top8_rate: Number(((top8 / standings.length) * 100).toFixed(1)),
        avg_placement: avgPlacement,
        tournaments_covered: tournamentNames.length,
      },
      format_breakdown: formatBreakdown.sort((a, b) => b.entries - a.entries),
      top_players: topPlayers,
      recent_results: recentResults,
      generated_at: new Date().toISOString(),
    };
    await cacheSetJson(cacheKey, response, META_CACHE_TTL_MS);
    return res.json(response);
  } catch (error) {
    // Unexpected failure case
    return res.status(500).json({ message: "Failed to fetch deck details", error: error.message });
  }
};

// Dono controllers export kar rahe hain route usage ke liye
module.exports = {
  getBestDeck,
  getDeckDetails,
};
