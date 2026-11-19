package com.together.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.content.res.Configuration;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final String LAUNCHER = "file:///android_asset/launcher.html";
    private static final int REQ_FILE = 1;
    private static final int REQ_PERM = 2;

    private FrameLayout root;
    private WebView web;
    private WebChromeClient chrome;
    private View customView;
    private WebChromeClient.CustomViewCallback customCallback;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingPermission;
    private AudioManager audioManager;
    // Single owner of the output route. Chromium's WebRTC stack inside the
    // WebView sets the audio mode/device on its own when a call connects, so a
    // one-shot route change loses the race. This guard re-asserts it.
    private android.os.Handler audioHandler;
    private Runnable audioGuard;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Lavender Glass: match the launcher background so there is no dark flash.
        int bg = Color.parseColor("#F4F1FD");
        root = new FrameLayout(this);
        root.setBackgroundColor(bg);

        web = new WebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        // Lets you debug the room / video-call page from a desktop browser
        // via chrome://inspect while the phone/tablet is plugged in.
        WebView.setWebContentsDebuggingEnabled(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return false;
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                // Only bounce back to the launcher for real connection failures of
                // the main page. Subresource hiccups must never kill a live call.
                if (!r.isForMainFrame()) return;
                int c = e.getErrorCode();
                boolean connectionFailure = c == ERROR_HOST_LOOKUP || c == ERROR_CONNECT
                        || c == ERROR_TIMEOUT || c == ERROR_IO || c == ERROR_UNKNOWN;
                String url = r.getUrl() != null ? r.getUrl().toString() : "";
                if (connectionFailure && !url.startsWith("file:///android_asset")) {
                    v.loadUrl(LAUNCHER + "?error=1");
                }
            }
            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                // Renderer crashed (can happen with camera + video). Recover the
                // whole activity instead of leaving a frozen screen.
                recreate();
                return true;
            }
        });

        chrome = new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    List<String> need = new ArrayList<>();
                    for (String r : req.getResources()) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !has(Manifest.permission.CAMERA))
                            need.add(Manifest.permission.CAMERA);
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                            if (!has(Manifest.permission.RECORD_AUDIO))
                                need.add(Manifest.permission.RECORD_AUDIO);
                            // Android 12+: routing call audio to a Bluetooth headset
                            // needs this. Optional — never blocks the call itself.
                            if (Build.VERSION.SDK_INT >= 31 && !has(Manifest.permission.BLUETOOTH_CONNECT))
                                need.add(Manifest.permission.BLUETOOTH_CONNECT);
                        }
                    }
                    if (need.isEmpty()) {
                        answer(req);
                    } else {
                        if (pendingPermission != null) pendingPermission.deny();
                        pendingPermission = req;
                        requestPermissions(need.toArray(new String[0]), REQ_PERM);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try {
                    startActivityForResult(p.createIntent(), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public void onShowCustomView(View v, CustomViewCallback cb) {
                if (customView != null) {
                    cb.onCustomViewHidden();
                    return;
                }
                customView = v;
                customCallback = cb;
                web.setVisibility(View.GONE);
                root.addView(v, new FrameLayout.LayoutParams(-1, -1));
                immersive(true);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                immersive(false);
                if (customCallback != null) customCallback.onCustomViewHidden();
                customCallback = null;
            }
        };
        web.setWebChromeClient(chrome);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        web.addJavascriptInterface(new SpeakerBridge(), "AndroidSpeaker");
        web.addJavascriptInterface(new ThemeBridge(), "AndroidTheme");

        web.loadUrl(LAUNCHER);
    }

    private boolean has(String perm) {
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void answer(PermissionRequest req) {
        List<String> ok = new ArrayList<>();
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
        }
        if (ok.isEmpty()) req.deny();
        else req.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_PERM && pendingPermission != null) {
            answer(pendingPermission);
            pendingPermission = null;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCallback = null;
        }
    }

    private void immersive(boolean on) {
        getWindow().getDecorView().setSystemUiVisibility(on
            ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            : View.SYSTEM_UI_FLAG_VISIBLE);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            chrome.onHideCustomView();
            return;
        }
        String u = web.getUrl();
        if (u != null && u.startsWith("file:///android_asset")) super.onBackPressed();
        else web.loadUrl(LAUNCHER);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        stopCallAudio();
        stopAudioGuard();
        callAudio.close();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------- Audio routing ----------------
       ROOT CAUSE of "the movie plays on the call speaker":
       two owners were fighting over Android's output route -- this wrapper
       AND Chromium's WebRTC stack inside the WebView. Chromium enters
       MODE_IN_COMMUNICATION when a processed mic stream opens and picks the
       EARPIECE; the whole device is then in call mode, so the movie's media
       stream is dragged onto the earpiece too.

       CallAudioController is now the SINGLE owner. It never calls setMode()
       and never requests audio focus (doing either races Chromium). It waits
       for Chromium's mode, then selects the built-in loudspeaker for
       communication output, so concurrent media uses that same speaker.
       A periodic reconcile re-asserts it if Chromium changes the route. */

    private final CallAudioController callAudio = new CallAudioController(new CallAudioController.Backend() {
        @Override public int mode() {
            return audioManager == null ? CallAudioController.MODE_NORMAL : audioManager.getMode();
        }
        @Override public boolean selectSpeaker() {
            if (audioManager == null) return false;
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo target = null;
                for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                    if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { target = d; break; }
                }
                if (target == null) return false;
                return audioManager.setCommunicationDevice(target);
            }
            audioManager.setSpeakerphoneOn(true);
            return audioManager.isSpeakerphoneOn();
        }
        @Override public boolean speakerSelected() {
            if (audioManager == null) return false;
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo d = audioManager.getCommunicationDevice();
                return d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
            }
            return audioManager.isSpeakerphoneOn();
        }
        @Override public void clearSpeaker() {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice();
            else audioManager.setSpeakerphoneOn(false);
        }
        @Override public String callDevice() {
            if (audioManager == null) return "unavailable";
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo d = audioManager.getCommunicationDevice();
                return d == null ? "none" : String.valueOf(d.getType());
            }
            return audioManager.isSpeakerphoneOn() ? "speaker" : "earpiece";
        }
        @Override public String mediaDevices() {
            if (audioManager == null) return "unavailable";
            AudioDeviceInfo[] list = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            StringBuilder sb = new StringBuilder();
            for (AudioDeviceInfo d : list) {
                if (sb.length() > 0) sb.append(',');
                sb.append(d.getType());
            }
            return sb.toString();
        }
        @Override public String note() {
            return Build.VERSION.SDK_INT >= 31 ? "communication-device API" : "legacy speakerphone API";
        }
    });

    private void startAudioGuard() {
        stopAudioGuard();
        if (audioHandler == null) {
            audioHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        }
        audioGuard = new Runnable() {
            @Override public void run() {
                callAudio.reconcile("guard");
                if (audioHandler != null) audioHandler.postDelayed(this, 1200);
            }
        };
        audioHandler.postDelayed(audioGuard, 500);
    }

    private void stopAudioGuard() {
        if (audioHandler != null && audioGuard != null) audioHandler.removeCallbacks(audioGuard);
        audioGuard = null;
    }

    private void startCallAudio() {
        callAudio.setSessionState(true, true, false);
        startAudioGuard();
    }

    private void stopCallAudio() {
        stopAudioGuard();
        callAudio.release();
    }

    /* The page calls this when the film starts. A movie on its own must NOT
       create a communication session -- it only refreshes the route if a call
       is already active. */
    private void useMediaSpeaker() {
        callAudio.setMovieActive(true);
        if (callAudio.isSessionActive()) startAudioGuard();
    }

    public class ThemeBridge {
        // Lets the website's "System" theme follow Android's actual night mode.
        @JavascriptInterface
        public boolean isNightMode() {
            int mask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return mask == Configuration.UI_MODE_NIGHT_YES;
        }
    }

    public class SpeakerBridge {
        // Keep the original JS API so the existing room page keeps working.
        @JavascriptInterface
        public void setCallSpeaker(final boolean on) {
            // 'on' means "use the loudspeaker"; muting is handled by the page.
            runOnUiThread(() -> { if (on) useMediaSpeaker(); });
        }

        @JavascriptInterface
        public void useMediaSpeaker() {
            runOnUiThread(() -> MainActivity.this.useMediaSpeaker());
        }

        @JavascriptInterface
        public void setSpeakerOn(final boolean on) {
            runOnUiThread(() -> {
                if (on) startCallAudio();
                else stopCallAudio();
            });
        }

        @JavascriptInterface
        public void setMoviePlaying(final boolean on) {
            runOnUiThread(() -> callAudio.setMovieActive(on));
        }

        @JavascriptInterface
        public String getAudioState() {
            return callAudio.stateJson();
        }
    }
}
