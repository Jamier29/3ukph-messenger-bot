package com.threeukph.esim;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EsimPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
