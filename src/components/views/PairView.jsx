// FEAT-18.2: the phone opened <TELEHARNESS_PUBLIC_URL>/#/pair/<code> (the QR of
// «Подключить телефон»). Once the boot check has answered, the code is
// exchanged for this device's session (POST /auth/pair/claim) and the user
// lands on the chat list. A used / expired / unknown link drops to the login
// screen with a plain explanation (pairError); a device that is already
// signed in stays where it was and gets the same text as a notice.
import { useEffect, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import { claimPair, me, setNotice } from "../../lib/store.js";
import { navigate } from "../../lib/router.js";
import { t } from "../../lib/i18n.js";

export const expiredText = () => t("pair.expired");

// Text for the login screen after a failed link (null = none).
export const pairError = signal(null);

export function pairErrorText(err) {
  if (err?.status === 401 || err?.status === 410) return expiredText();
  if (err?.status === 429) return t("pair.tooMany");
  if (!err?.status) return t("pair.offline");
  return t("pair.failed");
}

export default function PairView({ code, claim = claimPair }) {
  const user = me.value; // null while boot() is still asking /auth/me
  const started = useRef(false);
  useEffect(() => {
    if (user === null || started.current) return;
    started.current = true;
    claim(code)
      .then(() => {
        pairError.value = null;
        navigate("/", { replace: true });
      })
      .catch((err) => {
        const text = pairErrorText(err);
        if (me.value && typeof me.value === "object") setNotice(text, 8000);
        else {
          pairError.value = text;
          me.value = false;
        }
        navigate("/", { replace: true });
      });
  }, [user]);
  return (
    <div class="login-splash" role="status" aria-label={t("pair.signingIn")}>
      <span class="login-splash-dot" />
    </div>
  );
}
