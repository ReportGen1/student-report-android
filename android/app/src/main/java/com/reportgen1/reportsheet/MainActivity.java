package com.reportgen1.reportsheet;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PrintPlugin.class);
        super.onCreate(savedInstanceState);

        // Ignore the phone's font-size setting so printed layout matches the browser.
        getBridge().getWebView().getSettings().setTextZoom(100);
    }
}
