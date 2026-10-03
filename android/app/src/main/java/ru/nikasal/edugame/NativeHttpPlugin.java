package ru.nikasal.edugame;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * NativeHttp — HTTP через Java HttpURLConnection, в обход CORS
 * и mixed-content ограничений Android WebView.
 *
 * Веб-сторона: src/lib/nativeHttp.ts (registerPlugin('NativeHttp') +
 * fallback на fetch в браузере). Используется всеми вызовами LLM:
 * провайдеры OpenAI-совместимых API запрещают запросы с произвольных
 * origin, поэтому из WebView напрямую они не работают.
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void request(PluginCall call) {
        String urlStr = call.getString("url", "");
        String method = call.getString("method", "POST");
        JSObject headers = call.getObject("headers");
        String body = call.getString("body");
        // тайм-аут чтения от JS (reasoning-модели могут думать дольше 5 минут);
        // 10 минут по умолчанию, жёсткий потолок 30 минут
        double rawTimeout = call.getDouble("timeoutMs", 600_000.0) != null
                ? call.getDouble("timeoutMs", 600_000.0)
                : 600_000.0;
        final int readTimeoutMs = (int) Math.min(Math.max(rawTimeout, 5_000.0), 1_800_000.0);

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod(method == null ? "POST" : method);
                conn.setConnectTimeout(30_000);
                conn.setReadTimeout(readTimeoutMs);
                conn.setUseCaches(false);
                conn.setInstanceFollowRedirects(true);

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String value = headers.getString(key, "");
                        if (key != null && value != null && !value.isEmpty()) {
                            conn.setRequestProperty(key, value);
                        }
                    }
                }

                boolean hasBody = body != null && !body.isEmpty();
                if (hasBody) {
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                        os.flush();
                    }
                }

                int status = conn.getResponseCode();
                InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                String responseBody = readAll(is);

                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", responseBody);
                call.resolve(result);
            } catch (SocketTimeoutException e) {
                call.reject("Тайм-аут: сервер не ответил за " + (readTimeoutMs / 1000) + " с. Попробуй ещё раз, уменьши фрагмент или выбери более быструю модель.");
            } catch (Exception e) {
                call.reject("Native HTTP error: " + e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            char[] buf = new char[8192];
            int n;
            while ((n = reader.read(buf)) != -1) {
                sb.append(buf, 0, n);
            }
        }
        return sb.toString();
    }
}
