package ru.nikasal.edugame;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * NativeHttp — собственный плагин HTTP для LLM-запросов (минуя CORS WebView).
     *
     * ВАЖНО: в Capacitor 8 bridge создаётся ВНУТРИ super.onCreate() — в конце он
     * вызывает this.load() → Builder.create(), и конструктор Bridge синхронно
     * регистрирует все плагины. Поэтому registerPlugin(), вызванный ПОСЛЕ
     * super.onCreate(), дописывает класс в уже «отработавший» builder и в
     * работающий bridge не попадает (ошибка "plugin is not implemented on android").
     *
     * Переопределяем load(): регистрируем плагин ДО super.load() → create(),
     * чтобы он был включён в bridge наравне с автоплагинами из
     * capacitor.plugins.json (@capacitor/camera, filesystem, share).
     */
    @Override
    protected void load() {
        registerPlugin(NativeHttpPlugin.class);
        super.load();
    }
}
