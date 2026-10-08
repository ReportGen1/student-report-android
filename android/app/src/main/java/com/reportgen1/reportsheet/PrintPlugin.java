package com.reportgen1.reportsheet;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PrintPlugin")
public class PrintPlugin extends Plugin {

    @PluginMethod
    public void print(final PluginCall call) {
        final String jobName = call.getString("name", "Student_Reports");

        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    WebView webView = getBridge().getWebView();
                    PrintManager printManager =
                            (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(jobName);
                    printManager.print(jobName, adapter, new PrintAttributes.Builder().build());
                    call.resolve();
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            }
        });
    }
}
