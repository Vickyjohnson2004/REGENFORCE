import pino from "pino";
import { config } from "./config.js";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: config.logLevel,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }),
});
