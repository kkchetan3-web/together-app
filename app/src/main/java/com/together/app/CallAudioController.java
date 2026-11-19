package com.together.app;

/**
 * Single owner for the app's communication-output preference.
 *
 * Chromium owns the Android audio mode: it enters communication mode when a
 * processed microphone stream opens and leaves it when the last one closes.
 * This controller deliberately NEVER calls setMode() and NEVER requests audio
 * focus. Doing either from the wrapper races Chromium and can turn an already
 * created media stream into a call stream (or vice versa).
 *
 * While voice capture or a peer connection is alive, we select the built-in
 * loudspeaker for communication output. Android then routes concurrent media
 * to that same physical speaker instead of the earpiece. Movie playback alone
 * does not activate this controller. The movie keeps its normal media usage
 * and its own player volume; the call mute button only mutes the remote video.
 *
 * All public methods are synchronized. The Android adapter dispatches system
 * callbacks onto the main thread; JavaScript bridge calls do the same.
 */
final class CallAudioController {
    static final int MODE_NORMAL = 0;
    static final int MODE_IN_CALL = 2;
    static final int MODE_IN_COMMUNICATION = 3;

    interface Backend {
        int mode();
        /** Returns whether the platform accepted the request, not whether sound was heard. */
        boolean selectSpeaker();
        /** Reads back the platform's selected communication output. */
        boolean speakerSelected();
        void clearSpeaker();
        String callDevice();
        String mediaDevices();
        String note();
    }

    private final Backend backend;
    private boolean captureActive;
    private boolean callActive;
    private boolean movieActive;
    private boolean ownsSpeaker;
    private boolean closed;
    private String lastError = "";
    private String lastReason = "created";

    CallAudioController(Backend backend) {
        if (backend == null) throw new IllegalArgumentException("backend required");
        this.backend = backend;
    }

    synchronized void setSessionState(boolean capture, boolean call, boolean movie) {
        captureActive = capture;
        callActive = call;
        movieActive = movie;
        reconcile("session");
    }

    synchronized void setCaptureActive(boolean active) {
        captureActive = active;
        reconcile("capture");
    }

    synchronized void setCallActive(boolean active) {
        callActive = active;
        reconcile("call");
    }

    /** Diagnostic state only. A movie must not create a communication session. */
    synchronized void setMovieActive(boolean active) {
        movieActive = active;
        reconcile("movie");
    }

    synchronized void reconcile(String reason) {
        lastReason = reason == null ? "unknown" : reason;
        if (closed) return;
        try {
            int mode = backend.mode();
            // Never compete with the system dialer or change its route.
            if (mode == MODE_IN_CALL) {
                clearOwnedSpeaker();
                lastError = "System phone call is active; Together left its route alone";
                return;
            }
            if (!captureActive && !callActive) {
                clearOwnedSpeaker();
                lastError = "";
                return;
            }
            // In normal mode Chromium uses media output, which already defaults
            // to the loudspeaker. Wait for Chromium's mode callback before
            // selecting a communication device; do not force the mode ourselves.
            if (mode != MODE_IN_COMMUNICATION) {
                clearOwnedSpeaker();
                lastError = "";
                return;
            }
            if (backend.speakerSelected()) {
                ownsSpeaker = true;
                lastError = "";
                return;
            }
            boolean accepted = backend.selectSpeaker();
            ownsSpeaker = accepted;
            lastError = accepted ? "" : backend.note();
            if (lastError == null || lastError.isEmpty()) {
                lastError = "Android did not accept the loudspeaker request";
            }
        } catch (RuntimeException error) {
            // A routing failure must not crash the room. Keep it visible in the
            // call doctor instead of silently pretending the speaker is fixed.
            lastError = "Audio routing failed: " + error.getClass().getSimpleName();
        }
    }

    /** End the current room session. The same controller can be reused on re-entry. */
    synchronized void release() {
        captureActive = false;
        callActive = false;
        movieActive = false;
        try {
            clearOwnedSpeaker();
        } catch (RuntimeException error) {
            lastError = "Audio cleanup failed: " + error.getClass().getSimpleName();
        }
        lastReason = "release";
    }

    /** Activity destruction: no later callback may recreate a route. */
    synchronized void close() {
        closed = true;
        release();
    }

    synchronized boolean isSessionActive() {
        return captureActive || callActive;
    }

    synchronized String stateJson() {
        int mode = -1;
        boolean confirmed = false;
        String callDevice = "unavailable";
        String mediaDevices = "unavailable";
        String note = "";
        try {
            mode = backend.mode();
            confirmed = backend.speakerSelected();
            callDevice = backend.callDevice();
            mediaDevices = backend.mediaDevices();
            note = backend.note();
        } catch (RuntimeException error) {
            lastError = "Audio state unavailable: " + error.getClass().getSimpleName();
        }
        return "{"
                + "\"bridgeVersion\":3,"
                + "\"captureActive\":" + captureActive + ","
                + "\"callActive\":" + callActive + ","
                + "\"movieActive\":" + movieActive + ","
                + "\"mode\":" + mode + ","
                + "\"speakerRequested\":" + ownsSpeaker + ","
                + "\"speakerConfirmed\":" + confirmed + ","
                + "\"callDevice\":\"" + escape(callDevice) + "\","
                + "\"mediaDevices\":\"" + escape(mediaDevices) + "\","
                + "\"lastReason\":\"" + escape(lastReason) + "\","
                + "\"backendNote\":\"" + escape(note) + "\","
                + "\"lastError\":\"" + escape(lastError) + "\""
                + "}";
    }

    private void clearOwnedSpeaker() {
        if (!ownsSpeaker) return;
        backend.clearSpeaker();
        ownsSpeaker = false;
    }

    private static String escape(String value) {
        if (value == null) return "";
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
