import { createApiServer } from "./socket.js";
import { log } from "./logger.js";

const PORT = Number(process.env.PORT ?? 4000);

const { httpServer } = createApiServer();

httpServer.listen(PORT, () => {
  log("info", "Kachuful server listening", { port: PORT });
});
