package ru.nikasal.edugame;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Собственный плагин HTTP: LLM-запросы идут через Java, минуя CORS WebView
        registerPlugin(NativeHttpPlugin.class);
    }
}
