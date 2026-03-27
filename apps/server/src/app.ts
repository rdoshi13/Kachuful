import cors from "cors";
import express from "express";
import type { CreateRoomRequest, JoinRoomRequest } from "@kachuful/shared-types";
import { RoomStore } from "./store.js";

export const createApp = (store: RoomStore) => {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/rooms", (req, res) => {
    try {
      const body = req.body as Partial<CreateRoomRequest>;
      if (!body?.name || typeof body.name !== "string") {
        return res.status(400).json({ error: "Name is required" });
      }
      const { response } = store.createRoom(body.name);
      return res.status(201).json(response);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/rooms/:code/join", (req, res) => {
    try {
      const body = req.body as Partial<JoinRoomRequest>;
      if (!body?.name || typeof body.name !== "string") {
        return res.status(400).json({ error: "Name is required" });
      }
      const { response } = store.joinRoom(req.params.code ?? "", body.name);
      return res.status(200).json(response);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      if (message.includes("locked") || message.includes("full")) {
        return res.status(409).json({ error: message });
      }
      return res.status(400).json({ error: message });
    }
  });

  return app;
};
