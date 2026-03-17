const express = require("express");
const TopicAlertState = require("../model/topic_alert_state_db");
const {
  getTopicWatcherStatus,
  runTopicWatcherOnce,
  sendTopicWatcherTestEmail,
  fetchTopicPostsOnce,
} = require("../services/topic_watcher_service");

const router = express.Router();
const parsePublishedAt = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
};

router.get("/", (req, res) => {
  return res.json({
    message: "Watcher API available",
    endpoints: {
      status: "GET /watcher/status",
      run_now_post: "POST /watcher/run-now",
      run_now_get: "GET /watcher/run-now",
      test_email: "POST /watcher/test-email",
      scrape_preview: "GET /watcher/scrape-preview?limit=20",
      recent: "GET /watcher/recent (all) or /watcher/recent?limit=20",
    },
    status: getTopicWatcherStatus(),
  });
});

router.get("/status", (req, res) => {
  return res.json(getTopicWatcherStatus());
});

const runNowHandler = async (req, res) => {
  try {
    const result = await runTopicWatcherOnce();
    return res.json({
      message: "Watcher run completed",
      ...result,
      status: getTopicWatcherStatus(),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Watcher run failed",
      error: error.message,
      status: getTopicWatcherStatus(),
    });
  }
};

router.get("/run-now", runNowHandler);
router.post("/run-now", runNowHandler);

const testEmailHandler = async (req, res) => {
  try {
    const result = await sendTopicWatcherTestEmail();
    return res.json({
      message: result?.sent ? "Test email sent" : "Test email not sent",
      ...result,
      status: getTopicWatcherStatus(),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Test email failed",
      error: String(error?.message || error || "unknown_error"),
      status: getTopicWatcherStatus(),
    });
  }
};

router.get("/test-email", testEmailHandler);
router.post("/test-email", testEmailHandler);

router.get("/scrape-preview", async (req, res) => {
  try {
    const limitParam = Number(req.query?.limit || 20);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitParam) ? limitParam : 20));
    const posts = await fetchTopicPostsOnce();
    const sorted = [...posts].sort((a, b) => parsePublishedAt(b.published_at) - parsePublishedAt(a.published_at));
    return res.json({
      count: sorted.length,
      events: sorted.slice(0, limit),
    });
  } catch (error) {
    return res.status(500).json({
      message: "Scrape preview failed",
      error: error.message,
    });
  }
});

router.get("/recent", async (req, res) => {
  try {
    const limitParam = String(req.query?.limit || "").trim().toLowerCase();
    const showAll = !limitParam || limitParam === "all" || limitParam === "0";
    const limitRaw = Number(limitParam);
    const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 20));

    const query = TopicAlertState.find({})
      .select("url title published_at summary first_seen_at last_notified_at createdAt")
      .sort({ first_seen_at: -1 });
    if (!showAll) {
      query.limit(limit);
    }
    const rows = await query.lean();
    const events = rows
      .map((row) => ({
        url: row.url,
        title: row.title || "",
        published_at: row.published_at || "",
        summary: row.summary || "",
        first_seen_at: row.first_seen_at || row.createdAt || null,
        last_notified_at: row.last_notified_at || null,
      }))
      .sort((a, b) => {
        const byPublished = parsePublishedAt(b.published_at) - parsePublishedAt(a.published_at);
        if (byPublished !== 0) return byPublished;
        return Date.parse(String(b.first_seen_at || 0)) - Date.parse(String(a.first_seen_at || 0));
      });

    const allowFallback = String(req.query?.fallback || "true").toLowerCase() !== "false";
    if (events.length === 0 && allowFallback) {
      const livePosts = await fetchTopicPostsOnce();
      const sortedLive = [...livePosts].sort(
        (a, b) => parsePublishedAt(b.published_at) - parsePublishedAt(a.published_at)
      );
      const liveEvents = (showAll ? sortedLive : sortedLive.slice(0, limit)).map((post) => ({
        url: post.url,
        title: post.title || "",
        published_at: post.published_at || "",
        summary: post.summary || "",
        first_seen_at: null,
        last_notified_at: null,
        source: "live_scrape",
      }));
      return res.json({
        count: liveEvents.length,
        events: liveEvents,
      });
    }

    return res.json({
      count: events.length,
      events,
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch recent watcher events", error: error.message });
  }
});

module.exports = router;
