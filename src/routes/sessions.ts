import { Router } from "express";
import { SessionController } from "../controllers";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";

const sessionRouter = Router();

// Every session route is authenticated; the uid always comes from the token.
sessionRouter.use(asyncHandler(requireAuth));

sessionRouter.post("/", asyncHandler(SessionController.create));
sessionRouter.get("/active", asyncHandler(SessionController.active));
sessionRouter.get("/:sessionId", asyncHandler(SessionController.show));

sessionRouter.post("/:sessionId/join", asyncHandler(SessionController.join));
sessionRouter.post(
  "/:sessionId/preferences",
  asyncHandler(SessionController.preferences),
);
sessionRouter.post("/:sessionId/deck", asyncHandler(SessionController.deck));
sessionRouter.post(
  "/:sessionId/finalize",
  asyncHandler(SessionController.finalize),
);
sessionRouter.post("/:sessionId/select", asyncHandler(SessionController.select));
sessionRouter.post("/:sessionId/cancel", asyncHandler(SessionController.cancel));
sessionRouter.post("/:sessionId/nudge", asyncHandler(SessionController.nudge));

export default sessionRouter;
