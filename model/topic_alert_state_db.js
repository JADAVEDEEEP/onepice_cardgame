const mongoose = require("mongoose");

const topicAlertStateSchema = new mongoose.Schema(
  {
    event_key: { type: String, required: true, unique: true, index: true },
    url: { type: String, required: true, index: true },
    title: { type: String, default: "" },
    published_at: { type: String, default: "" },
    summary: { type: String, default: "" },
    first_seen_at: { type: Date, default: Date.now },
    last_notified_at: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model(
  "TopicAlertState",
  topicAlertStateSchema,
  process.env.TOPIC_ALERT_COLLECTION || "onepice_topics_alert_state_v2"
);
