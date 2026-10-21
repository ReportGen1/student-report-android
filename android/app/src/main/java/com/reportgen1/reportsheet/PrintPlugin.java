package com.reportgen1.reportsheet;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PrintPlugin")
public class PrintPlugin extends Plugin {

    private WebView printView;   // kept so it is not cleaned up while the print dialog is open

    // Prints the page currently on screen (used by the report sheets). Unchanged.
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
                    // Default to a full A4 sheet with no margins so the report can fill the page.
                    // (The user can still change the paper size in the print dialog.)
                    PrintAttributes attributes = new PrintAttributes.Builder()
                            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                            .build();
                    printManager.print(jobName, adapter, attributes);
                    call.resolve();
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            }
        });
    }

    // NEW: prints a piece of HTML passed from the page (used by fee receipts).
    @PluginMethod
    public void printHtml(final PluginCall call) {
        final String html = call.getString("html", "");
        final String jobName = call.getString("name", "Receipt");

        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    WebView w = new WebView(getActivity());
                    final boolean[] done = { false };
                    w.setWebViewClient(new WebViewClient() {
                        @Override
                        public void onPageFinished(WebView view, String url) {
                            if (done[0]) return;
                            done[0] = true;
                            try {
                                PrintManager pm =
                                        (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                                PrintAttributes attrs = new PrintAttributes.Builder()
                                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                        .build();
                                pm.print(jobName, view.createPrintDocumentAdapter(jobName), attrs);
                                call.resolve();
                            } catch (Exception e) {
                                call.reject(e.getMessage());
                            }
                        }
                    });
                    printView = w;
                    w.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
                } catch (Exception e) {
                    call.reject(e.getMessage());
                }
            }
        });
    }
}
