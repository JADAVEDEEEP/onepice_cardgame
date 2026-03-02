const standingsDb = require("../model/standings_db");
const tournamentsDb = require("../model/tournaments_db");

const parseNumber = (value, fallback = 0) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const numeric = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  return fallback;
};

const normalize = (value) => String(value || "").trim().toLowerCase();

const parseDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const daysBetween = (d1, d2) => Math.max(0, Math.floor((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));

const getBestDeck = async (req, res) => {
  try {
    const { format, date_from, date_to, region, country, min_players } = req.query;
    const minPlayers = parseNumber(min_players, 0);

    const standingsQuery = {};
    if (format) standingsQuery.format = format;
    if (date_from || date_to) {
      standingsQuery.date = {};
      if (date_from) standingsQuery.date.$gte = date_from;
      if (date_to) standingsQuery.date.$lte = date_to;
    }

    const tournamentsQuery = {};
    if (format) tournamentsQuery.format = format;
    if (date_from || date_to) {
      tournamentsQuery.date = {};
      if (date_from) tournamentsQuery.date.$gte = date_from;
      if (date_to) tournamentsQuery.date.$lte = date_to;
    }
    if (region) tournamentsQuery.region = region;
    if (country) tournamentsQuery.country = country;

    const [standings, tournaments] = await Promise.all([
      standingsDb.find(standingsQuery).lean(),
      tournamentsDb.find(tournamentsQuery).lean(),
    ]);

    const tournamentByName = new Map();
    const tournamentByNameFormat = new Map();
    const tournamentByNameDateFormat = new Map();

    for (const tournament of tournaments) {
      const nameKey = normalize(tournament.name);
      const formatKey = normalize(tournament.format);
      const dateKey = normalize(tournament.date);
      if (nameKey) tournamentByName.set(nameKey, tournament);
      if (nameKey && formatKey) tournamentByNameFormat.set(`${nameKey}|${formatKey}`, tournament);
      if (nameKey && dateKey && formatKey) {
        tournamentByNameDateFormat.set(`${nameKey}|${dateKey}|${formatKey}`, tournament);
      }
    }

    const now = new Date();
    const deckScores = new Map();
    const formatScores = new Map();
    let usedRows = 0;

    for (const standing of standings) {
      const deck = String(standing.deck || "").trim();
      if (!deck) continue;

      const placement = parseNumber(standing.placement, Number.MAX_SAFE_INTEGER);
      if (!Number.isFinite(placement) || placement <= 0) continue;

      const standingName = normalize(standing.tournament);
      const standingDate = normalize(standing.date);
      const standingFormat = normalize(standing.format || format);

      const tournament =
        tournamentByNameDateFormat.get(`${standingName}|${standingDate}|${standingFormat}`) ||
        tournamentByNameFormat.get(`${standingName}|${standingFormat}`) ||
        tournamentByName.get(standingName);

      if ((region || country) && !tournament) continue;

      const players = parseNumber(tournament?.players, 64);
      if (players < minPlayers) continue;

      const resultDate = parseDate(standing.date || tournament?.date);
      const ageDays = resultDate ? daysBetween(now, resultDate) : 365;

      const placementWeight = 1 / placement;
      const sizeWeight = Math.log10(players + 1);
      const eventWeight = players >= 1000 ? 1.25 : players >= 500 ? 1.15 : players >= 200 ? 1.08 : 1;
      const recencyWeight = Math.exp(-ageDays / 365);
      const score = placementWeight * sizeWeight * eventWeight * recencyWeight * 100;
      const rowFormat = standing.format || tournament?.format || "UNKNOWN";

      const deckKey = normalize(deck);
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

      const aggregate = deckScores.get(deckKey);
      aggregate.total_score += score;
      aggregate.entries += 1;
      aggregate.wins += placement === 1 ? 1 : 0;
      aggregate.top8 += placement <= 8 ? 1 : 0;
      aggregate.placement_sum += placement;
      aggregate.weighted_players += players;
      aggregate.formats.add(rowFormat);

      if (!formatScores.has(rowFormat)) formatScores.set(rowFormat, new Map());
      const byFormat = formatScores.get(rowFormat);
      if (!byFormat.has(deckKey)) byFormat.set(deckKey, { deck, total_score: 0, entries: 0, wins: 0 });
      const fmt = byFormat.get(deckKey);
      fmt.total_score += score;
      fmt.entries += 1;
      fmt.wins += placement === 1 ? 1 : 0;

      usedRows += 1;
    }

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
      .sort((a, b) => b.total_score - a.total_score);

    const bestByFormat = Array.from(formatScores.entries())
      .map(([fmt, map]) => {
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
      .filter(Boolean);

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
      top_10_ranked_decks: rankedDecks.slice(0, 10),
      generated_at: new Date().toISOString(),
    };

    return res.json(response);
  } catch (error) {
    return res.status(500).json({ message: "Failed to compute best deck", error: error.message });
  }
};

const getDeckDetails = async (req, res) => {
  try {
    const deckNameRaw = String(req.params.deckName || "").trim();
    if (!deckNameRaw) {
      return res.status(400).json({ message: "deckName is required" });
    }

    const { format, date_from, date_to } = req.query;
    const deckRegex = new RegExp(`^${deckNameRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

    const standingsQuery = { deck: deckRegex };
    if (format) standingsQuery.format = format;
    if (date_from || date_to) {
      standingsQuery.date = {};
      if (date_from) standingsQuery.date.$gte = date_from;
      if (date_to) standingsQuery.date.$lte = date_to;
    }

    const standings = await standingsDb.find(standingsQuery).lean();
    if (standings.length === 0) {
      return res.status(404).json({ message: `No standings data found for deck '${deckNameRaw}'` });
    }

    const tournamentNames = Array.from(
      new Set(standings.map((row) => normalize(row.tournament)).filter(Boolean))
    );

    const tournaments = await tournamentsDb
      .find({ name: { $in: standings.map((row) => row.tournament).filter(Boolean) } })
      .lean();
    const tournamentByName = new Map(tournaments.map((t) => [normalize(t.name), t]));

    const placements = standings
      .map((row) => parseNumber(row.placement, Number.MAX_SAFE_INTEGER))
      .filter((value) => Number.isFinite(value) && value > 0);
    const wins = placements.filter((p) => p === 1).length;
    const top8 = placements.filter((p) => p <= 8).length;
    const avgPlacement = placements.length
      ? Number((placements.reduce((sum, p) => sum + p, 0) / placements.length).toFixed(2))
      : null;

    const byFormat = new Map();
    for (const row of standings) {
      const key = row.format || "UNKNOWN";
      if (!byFormat.has(key)) byFormat.set(key, { format: key, entries: 0, wins: 0, top8: 0, placementSum: 0 });
      const ref = byFormat.get(key);
      const p = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
      ref.entries += 1;
      if (p === 1) ref.wins += 1;
      if (p <= 8) ref.top8 += 1;
      if (Number.isFinite(p) && p > 0) ref.placementSum += p;
    }

    const formatBreakdown = Array.from(byFormat.values()).map((item) => ({
      format: item.format,
      entries: item.entries,
      wins: item.wins,
      top8: item.top8,
      top8_rate: Number(((item.top8 / item.entries) * 100).toFixed(1)),
      win_rate_estimate: Number(((item.wins / item.entries) * 100).toFixed(1)),
      avg_placement: item.entries ? Number((item.placementSum / item.entries).toFixed(2)) : null,
    }));

    const byPlayer = new Map();
    for (const row of standings) {
      const player = row.player || "Unknown";
      if (!byPlayer.has(player)) byPlayer.set(player, { player, entries: 0, wins: 0, best_placement: Number.MAX_SAFE_INTEGER });
      const ref = byPlayer.get(player);
      const p = parseNumber(row.placement, Number.MAX_SAFE_INTEGER);
      ref.entries += 1;
      if (p === 1) ref.wins += 1;
      if (p < ref.best_placement) ref.best_placement = p;
    }
    const topPlayers = Array.from(byPlayer.values())
      .sort((a, b) => b.wins - a.wins || a.best_placement - b.best_placement || b.entries - a.entries)
      .slice(0, 10)
      .map((p) => ({ ...p, best_placement: Number.isFinite(p.best_placement) ? p.best_placement : null }));

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
        const da = parseDate(a.date);
        const db = parseDate(b.date);
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.getTime() - da.getTime();
      })
      .slice(0, 30);

    return res.json({
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
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch deck details", error: error.message });
  }
};

module.exports = {
  getBestDeck,
  getDeckDetails,
};
