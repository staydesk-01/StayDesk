import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach } from "vitest";
import "../server/models/index"; // register every model (models do not read env)

// Must be set before src/config/env is first imported.
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123";
process.env.TWILIO_AUTH_TOKEN = "test_twilio_auth_token";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.PUBLIC_BASE_URL = "https://staydesk.test";
process.env.OPENAI_API_KEY = "";
process.env.RESEND_API_KEY = "";
process.env.AGENT_TOOL_SECRET = "test-agent-secret";
process.env.TWILIO_SKIP_SIGNATURE = "false";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.MONGODB_URI = process.env.MONGODB_URI_TEST ?? "mongodb://127.0.0.1:27017/staydesk_test";

const uri = process.env.MONGODB_URI_TEST ?? "mongodb://127.0.0.1:27017/staydesk_test";

beforeAll(async () => {
  await mongoose.connect(uri);
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
