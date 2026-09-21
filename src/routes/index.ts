import { Router } from "express";
import sessionRouter from "./sessions";
import userRouter from "./users";

const router = Router();

// API Welcome Message
router.get("/", (_, response) => {
  response.send({
    message: "DateMate API is running successfully!",
  });
});

/**
 * Liveness probe. Deliberately touches nothing, so it stays cheap and does not
 * spend Firestore quota on uptime checks.
 */
router.get("/health", (_, response) => {
  response.send({ status: "success", data: { ok: true, uptime: process.uptime() } });
});

router.use("/v1/sessions", sessionRouter);
router.use("/v1/users", userRouter);

export default router;
