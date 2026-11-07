import { defineConfig } from "vitest/config";

// Тесты не должны зависеть от часового пояса ПК: Worker в Cloudflare тоже живёт в UTC.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
