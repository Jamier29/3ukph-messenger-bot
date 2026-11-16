package com.threeukph.esim;

import android.content.Intent;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Opens the phone's eSIM / SIM settings so the customer can tap "Add eSIM" and paste the
 * activation code the app just copied. (Android doesn't let ordinary apps install an eSIM by
 * themselves; only carrier apps can.) Tries the most specific screen first.
 */
@CapacitorPlugin(name = "Esim")
public class EsimPlugin extends Plugin {
    @PluginMethod
    public void openEsimSettings(PluginCall call) {
        String[] actions = {
            "android.settings.MANAGE_ALL_SIM_PROFILES_SETTINGS", // Android 13+ SIM list (Pixel and others)
            Settings.ACTION_NETWORK_OPERATOR_SETTINGS,           // Mobile network
            Settings.ACTION_WIRELESS_SETTINGS                    // Connections (Samsung)
        };
        for (String action : actions) {
            try {
                Intent i = new Intent(action);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (i.resolveActivity(getContext().getPackageManager()) != null) {
                    getContext().startActivity(i);
                    JSObject r = new JSObject();
                    r.put("opened", true);
                    r.put("screen", action);
                    call.resolve(r);
                    return;
                }
            } catch (Exception ignored) { }
        }
        JSObject r = new JSObject();
        r.put("opened", false);
        call.resolve(r);
    }
}
