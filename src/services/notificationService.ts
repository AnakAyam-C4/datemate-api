import { messaging } from "../config/firebase";
import { getUser, removeFcmTokens } from "../repositories/userRepository";

type PartnerPush = {
  title: string;
  body: string;
  /** Data payload the iOS app uses to deep-link straight into the session. */
  data: Record<string, string>;
};

const UNREGISTERED_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * Sends a push to every device a partner has registered.
 *
 * Push is a convenience, never a correctness requirement: the partner's app
 * also learns about the session from the `activeSessionId` pointer on the
 * couple document it is already listening to. So this never throws — a failed
 * push must not fail the request that triggered it.
 */
export const notifyPartner = async (
  partnerId: string,
  push: PartnerPush,
): Promise<{ sent: number; failed: number }> => {
  try {
    const partner = await getUser(partnerId);
    const tokens = partner?.fcmTokens ?? [];

    if (tokens.length === 0) return { sent: 0, failed: 0 };

    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title: push.title, body: push.body },
      data: push.data,
      apns: {
        payload: {
          aps: {
            sound: "default",
            // Session invites are time-critical; the partner has to act now.
            "interruption-level": "time-sensitive",
          },
        },
      },
    });

    // Prune tokens FCM has told us are dead, so we stop paying for them.
    const stale = response.responses
      .map((result, index) =>
        !result.success && UNREGISTERED_ERRORS.has(result.error?.code ?? "")
          ? tokens[index]
          : null,
      )
      .filter((token): token is string => token !== null);

    if (stale.length > 0) await removeFcmTokens(partnerId, stale);

    return {
      sent: response.successCount,
      failed: response.failureCount,
    };
  } catch (error) {
    console.error("[FCM] failed to notify partner", partnerId, error);
    return { sent: 0, failed: 0 };
  }
};

export const sessionInvitePush = (
  sessionId: string,
  inviterName: string,
): PartnerPush => ({
  title: "Date night?",
  body: `${inviterName} wants to pick a spot with you.`,
  data: { type: "match_session_invite", sessionId },
});

export const sessionReadyPush = (sessionId: string): PartnerPush => ({
  title: "Your deck is ready",
  body: "Start swiping to find your next date.",
  data: { type: "match_session_deck_ready", sessionId },
});

export const sessionMatchedPush = (
  sessionId: string,
  matchCount: number,
): PartnerPush => ({
  title: matchCount > 0 ? "It's a match!" : "All done",
  body:
    matchCount > 0
      ? `You both liked ${matchCount} spot${matchCount === 1 ? "" : "s"}.`
      : "No matches this time — try another round?",
  data: { type: "match_session_result", sessionId },
});
