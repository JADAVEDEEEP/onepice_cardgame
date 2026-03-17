const nodemailer = require("nodemailer");
const { load } = require("cheerio");
const TopicAlertState = require("../model/topic_alert_state_db");

const TOPICS_URL =
  process.env.TOPICS_WATCH_URL || "https://en.onepiece-cardgame.com/topics/";
const WATCH_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.TOPICS_WATCH_INTERVAL_MS) || 10 * 60_000
);
const WATCH_ENABLED = String(process.env.TOPICS_WATCH_ENABLED || "true").toLowerCase() === "true";
const BOOTSTRAP_SILENT =
  String(process.env.TOPICS_WATCH_BOOTSTRAP_SILENT || "false").toLowerCase() === "true";

const status = {
  running: false,
  last_run_at: null,
  last_error: null,
  last_new_count: 0,
  last_email_sent_at: null,
  last_email_error: null,
  last_email_reason: null,
  source_url: TOPICS_URL,
  interval_ms: WATCH_INTERVAL_MS,
};

let timer = null;

const withTimeout = async (promise, ms, label) => {
  const timeoutMs = Math.max(1000, Number(ms) || 0);
  if (!timeoutMs) return promise;
  let t = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(`${label || "timeout"}_${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};

const toAbsoluteUrl = (href) => {
  try {
    return new URL(href, TOPICS_URL).toString();
  } catch {
    return "";
  }
};

const normalizeSpace = (text) => String(text || "").replace(/\s+/g, " ").trim();
const DATE_PATTERN =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+\d{4}\b/i;

const extractDateFromText = (text) => {
  const normalized = normalizeSpace(text);
  if (!normalized) return "";
  const match = normalized.match(DATE_PATTERN);
  return match ? normalizeSpace(match[0]) : "";
};

const extractTopicPosts = (html) => {
  const $ = load(html);
  const seen = new Set();
  const posts = [];

  $("a[href]").each((_, el) => {
    const href = normalizeSpace($(el).attr("href"));
    if (!href) return;
    const url = toAbsoluteUrl(href);
    if (!url || url === TOPICS_URL || url.endsWith("/topics/")) return;

    const title = normalizeSpace($(el).text());
    if (!title || title.length < 3) return;

    const card = $(el).closest(
      "li, article, section, .topics-list-item, .news-list-item, .news_item, .topics_item, .post, .item, .entry"
    );
    const parentText = normalizeSpace($(el).parent().text());
    const grandParentText = normalizeSpace($(el).parent().parent().text());
    const cardText = normalizeSpace(card.text());
    const dateText = normalizeSpace(
      card.find("time").first().attr("datetime") ||
      card.find("time").first().text() ||
      card.find(".date, .news-date, .topics-date, .entry-date, .post-date").first().text() ||
      extractDateFromText(parentText) ||
      extractDateFromText(grandParentText) ||
      extractDateFromText(cardText) ||
      extractDateFromText(title) ||
      ""
    );
    const summary = normalizeSpace(
      card.find("p, .lead, .desc, .summary").first().text() || title
    );
    const publishedAt = dateText || extractDateFromText(`${title} ${summary}`) || "";

    // Use URL as the stable event key (date may not be parseable on all sites)
    const eventKey = url;
    if (seen.has(eventKey)) return;

    seen.add(eventKey);
    posts.push({
      event_key: eventKey,
      url,
      title,
      published_at: publishedAt,
      summary: summary || title,
    });
  });

  return posts;
};

const sendNewTopicEmail = async (posts) => {
  const user = process.env.MAIL_USER || "deepjadav71691@gmail.com";
  const pass = process.env.MAIL_PASS || "olaonvllisgsdvwa";
  const to = process.env.TOPICS_ALERT_TO || user;
  if (!user || !pass || !to || posts.length === 0) return { sent: false, reason: "mail_not_configured" };

  const mailHost = process.env.MAIL_HOST || "";
  const mailPort = Number(process.env.MAIL_PORT || 0) || undefined;
  const mailSecure = String(process.env.MAIL_SECURE || "").toLowerCase() === "true";
  const mailTimeoutMs = Math.max(3_000, Number(process.env.MAIL_TIMEOUT_MS) || 12_000);

  const transporter = mailHost
    ? nodemailer.createTransport({
      host: mailHost,
      port: mailPort || 587,
      secure: mailSecure,
      auth: { user, pass },
      connectionTimeout: mailTimeoutMs,
      greetingTimeout: mailTimeoutMs,
      socketTimeout: Math.max(mailTimeoutMs, 20_000),
    })
    : nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
      connectionTimeout: mailTimeoutMs,
      greetingTimeout: mailTimeoutMs,
      socketTimeout: Math.max(mailTimeoutMs, 20_000),
    });

  const subject =
    posts.length === 1
      ? `[OPTCG Alert] New topic: ${posts[0].title}`
      : `[OPTCG Alert] ${posts.length} new topics posted`;

  const textLines = posts.map(
    (p, idx) =>
      `${idx + 1}. ${p.title}\nDate: ${p.published_at || "N/A"}\nSummary: ${p.summary}\nLink: ${p.url}`
  );

  const htmlItems = posts
    .map(
      (p) => `
      <li style="margin-bottom:12px;">
        <strong>${p.title}</strong><br/>
        <span>Date: ${p.published_at || "N/A"}</span><br/>
        <span>${p.summary}</span><br/>
        <a href="${p.url}" target="_blank" rel="noopener noreferrer">${p.url}</a>
      </li>`
    )
    .join("");

  await withTimeout(transporter.verify(), mailTimeoutMs, "mail_verify_timeout");
  await withTimeout(
    transporter.sendMail({
      from: `"OPTCG Watcher" <${user}>`,
      to,
      subject,
      text: textLines.join("\n\n"),
      html: `<div><p>New One Piece Card Game topics detected:</p><ol>${htmlItems}</ol></div>`,
    }),
    Math.max(mailTimeoutMs, 20_000),
    "mail_send_timeout"
  );

  return { sent: true };
};

const sendTopicWatcherTestEmail = async () => {
  const now = new Date().toISOString();
  try {
    const result = await sendNewTopicEmail([
      {
        title: "Watcher Test Email",
        published_at: now,
        summary: "If you received this, topic watcher email configuration is working.",
        url: TOPICS_URL,
      },
    ]);
    if (result?.sent) {
      status.last_email_sent_at = now;
      status.last_email_error = null;
      status.last_email_reason = "test_email_sent";
    } else {
      status.last_email_reason = result?.reason || "test_email_not_sent";
    }
    return result;
  } catch (error) {
    status.last_email_error = String(error?.message || error || "test_email_failed");
    status.last_email_reason = "test_email_failed";
    throw error;
  }
};

const fetchTopicPostsOnce = async () => {
  const cacheBustUrl = `${TOPICS_URL}${TOPICS_URL.includes("?") ? "&" : "?"}_ts=${Date.now()}`;
  const fetchTimeoutMs = Math.max(3_000, Number(process.env.TOPICS_FETCH_TIMEOUT_MS) || 12_000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), fetchTimeoutMs);
  const response = await fetch(cacheBustUrl, {
    headers: {
      "user-agent": "OPTCGDeckLabWatcher/1.0 (+email-alert)",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    signal: controller.signal,
  });
  clearTimeout(t);
  if (!response.ok) {
    throw new Error(`Topics fetch failed with status ${response.status}`);
  }
  const html = await response.text();
  return extractTopicPosts(html);
};

const runTopicWatcherOnce = async () => {
  try {
    status.running = true;
    status.last_error = null;

    const posts = await fetchTopicPostsOnce();

    if (posts.length === 0) {
      status.last_run_at = new Date().toISOString();
      status.last_new_count = 0;
      return { scanned: 0, new_posts: 0, sent_email: false };
    }

    const existingCount = await TopicAlertState.countDocuments({});
    const eventKeys = posts.map((p) => p.event_key);
    const urls = posts.map((p) => p.url);
    // Match by new-format event_key (url) OR the old-format key OR by url field directly
    // This ensures backward compatibility when event_key format changed
    const existingRows = await TopicAlertState.find({
      $or: [{ event_key: { $in: eventKeys } }, { url: { $in: urls } }],
    })
      .select("event_key url published_at summary")
      .lean();
    // Build lookup by BOTH event_key and url so old-format rows are recognised
    const existingMap = new Map([
      ...existingRows.map((row) => [row.event_key, row]),
      ...existingRows.map((row) => [row.url, row]),
    ]);
    const existingSet = new Set([
      ...existingRows.map((row) => row.event_key),
      ...existingRows.map((row) => row.url),
    ]);

    const fresh = posts.filter((p) => !existingSet.has(p.event_key));
    const updates = posts.filter((p) => {
      const row = existingMap.get(p.event_key);
      if (!row) return false;
      const oldDate = normalizeSpace(row.published_at);
      const newDate = normalizeSpace(p.published_at);
      const oldSummary = normalizeSpace(row.summary);
      const newSummary = normalizeSpace(p.summary);
      const hasMissingDate = !oldDate && !!newDate;
      const hasMissingSummary = !oldSummary && !!newSummary;
      const dateChanged = !!newDate && oldDate !== newDate;
      const summaryChanged = !!newSummary && oldSummary !== newSummary;
      return hasMissingDate || hasMissingSummary || dateChanged || summaryChanged;
    });

    if (fresh.length > 0) {
      await TopicAlertState.insertMany(
        fresh.map((p) => ({
          ...p,
          first_seen_at: new Date(),
          last_notified_at: null,
        })),
        { ordered: false }
      ).catch(() => { });
    }

    if (updates.length > 0) {
      await TopicAlertState.bulkWrite(
        updates.map((p) => ({
          updateOne: {
            filter: { event_key: p.event_key },
            update: { $set: { published_at: p.published_at || "", summary: p.summary || p.title || "" } },
          },
        })),
        { ordered: false }
      ).catch(() => { });
    }

    const notifyCandidates = [
      ...fresh,
      ...updates.filter((u) => !!normalizeSpace(u.published_at)),
    ];
    const uniqueNotify = Array.from(
      new Map(notifyCandidates.map((p) => [p.url, p])).values()
    );

    let sentEmail = false;
    status.last_email_error = null;
    status.last_email_reason = null;
    if (uniqueNotify.length > 0 && !(BOOTSTRAP_SILENT && existingCount === 0)) {
      try {
        const mail = await sendNewTopicEmail(uniqueNotify);
        sentEmail = Boolean(mail?.sent);
        status.last_email_reason = mail?.reason || null;
        if (sentEmail) {
          status.last_email_sent_at = new Date().toISOString();
          await TopicAlertState.updateMany(
            { event_key: { $in: uniqueNotify.map((p) => p.event_key) } },
            { $set: { last_notified_at: new Date() } }
          );
        }
      } catch (mailError) {
        status.last_email_error = String(mailError?.message || mailError || "unknown_mail_error");
      }
    } else if (uniqueNotify.length === 0) {
      status.last_email_reason = "no_new_posts";
    } else {
      status.last_email_reason = "bootstrap_silent_enabled";
    }

    status.last_run_at = new Date().toISOString();
    status.last_new_count = fresh.length;
    return {
      scanned: posts.length,
      new_posts: fresh.length,
      updated_posts: updates.length,
      notified_posts: uniqueNotify.length,
      sent_email: sentEmail,
    };
  } catch (error) {
    status.last_error = error.message;
    status.last_run_at = new Date().toISOString();
    throw error;
  } finally {
    status.running = false;
  }
};

const startTopicWatcher = () => {
  if (!WATCH_ENABLED || timer) return;
  timer = setInterval(() => {
    runTopicWatcherOnce().catch((err) => {
      console.error("Topic watcher error:", err.message);
    });
  }, WATCH_INTERVAL_MS);
  void runTopicWatcherOnce().catch((err) => {
    console.error("Topic watcher initial run failed:", err.message);
  });
};

const getTopicWatcherStatus = () => ({ ...status });

module.exports = {
  startTopicWatcher,
  runTopicWatcherOnce,
  getTopicWatcherStatus,
  sendTopicWatcherTestEmail,
  fetchTopicPostsOnce,
};
