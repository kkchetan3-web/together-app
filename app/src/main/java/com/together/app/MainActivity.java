package com.together.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
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
    private AudioFocusRequest focusRequest;

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
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /* ---------------- Audio routing ----------------
       IMPORTANT: we deliberately do NOT use MODE_IN_COMMUNICATION.
       Switching the device into communication mode routes *all* output
       through the voice-call path, which dragged the movie's audio onto the
       earpiece at call volume. This app watches films together, so both the
       WebRTC call and the movie must stay on the MEDIA stream / loudspeaker.
       WebRTC's own echo cancellation handles the mic side. */

    private void startCallAudio() {
        try {
            if (audioManager == null) return;
            // Stay in normal mode so movie + call both use the media stream.
            audioManager.setMode(AudioManager.MODE_NORMAL);
            if (focusRequest == null) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                        .build();
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setOnAudioFocusChangeListener(f -> { })
                        .build();
            }
            audioManager.requestAudioFocus(focusRequest);
            useMediaSpeaker();
        } catch (Exception e) { }
    }

    /* Force output back to the media loudspeaker. Called when a movie starts
       and from the page's speaker control, so the film never plays through
       the call earpiece. */
    private void useMediaSpeaker() {
        try {
            if (audioManager == null) return;
            audioManager.setMode(AudioManager.MODE_NORMAL);
            if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice();
            audioManager.setSpeakerphoneOn(false); // no-op in normal mode; media already uses the speaker
        } catch (Exception e) { }
    }

    private void stopCallAudio() {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice();
            audioManager.setSpeakerphoneOn(false);
            audioManager.setMode(AudioManager.MODE_NORMAL);
            if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
        } catch (Exception e) { }
    }

    private void routeSpeaker(boolean speaker) {
        try {
            if (audioManager == null) return;
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo target = null;
                for (AudioDeviceInfo d : audioManager.getAvailableCommunicationDevices()) {
                    int t = d.getType();
                    if (speaker && t == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) { target = d; break; }
                    if (!speaker && t == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) { target = d; break; }
                }
                if (target != null) audioManager.setCommunicationDevice(target);
            } else {
                audioManager.setSpeakerphoneOn(speaker);
            }
        } catch (Exception e) { }
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
    }
}
