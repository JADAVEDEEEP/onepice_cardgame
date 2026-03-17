require("dotenv").config();

const connectDB = require("../config/configdb");
const { runTopicWatcherOnce, getTopicWatcherStatus } = require("../services/topic_watcher_service");

const main = async () => {
  try {
    await connectDB();
    const result = await runTopicWatcherOnce();
    const status = getTopicWatcherStatus();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ok: true, result, status }, null, 2));
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error || "unknown_error") }, null, 2));
    process.exit(1);
  }
};

void main();

