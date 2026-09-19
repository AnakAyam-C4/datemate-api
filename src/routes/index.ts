import { Router } from "express";

const router = Router();

// API Welcome Message
router.get("/", (_, response) => {
  response.send({
    message: "DateMate API is running successfully!",
  });
});

/**
 * Insert your router here
 * @example router.use("/example", exampleRouter)
 */

export default router;
