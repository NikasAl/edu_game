package ru.nikasal.edugame;

import android.os.Bundle;
import android.view.WindowManager;

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

    /**
     * Держим экран включённым, пока окно приложения на экране (FLAG_KEEP_SCREEN_ON):
     * длинные LLM-операции (импорт, OCR, генерация задач) не обрываются из-за
     * системного тайм-аута гашения. Флаг действует, только пока окно видно —
     * при уходе из приложения экран гаснет по обычным правилам; кнопка
     * блокировки по-прежнему работает без ограничений.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
