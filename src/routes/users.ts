import { Router } from "express";
import { UserController } from "../controllers";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";

const userRouter = Router();

userRouter.use(asyncHandler(requireAuth));

userRouter.post("/me/fcm-token", asyncHandler(UserController.registerFcmToken));
userRouter.delete(
  "/me/fcm-token",
  asyncHandler(UserController.unregisterFcmToken),
);

export default userRouter;
