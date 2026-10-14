package ru.nikasal.edugame;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

/**
 * ContinuousSpeech — фоновое непрерывное распознавание речи без системного попапа.
 *
 * Зачем свой плагин, если стоит @capacitor-community/speech-recognition:
 * 1. Community-плагин не передаёт Android-extras тишины, поэтому сервис Google
 *    закрывает сессию после каждой короткой паузы (~1 сек «конец фразы»), а на
 *    тишину без речи — по таймауту ~5 сек. JS-обёртка успевала перезапускать
 *    его лишь через 800 мс + переподключение сервиса: окно в 1.5–3 секунды,
 *    когда микрофон выключен, — начало фраз падало в него и терялось.
 * 2. Часть ошибок (таймаут тишины и др.) community-плагин не транслирует в
 *    JS-события вовсе — приходилось опрашивать isListening() по таймеру.
 *
 * Как это устроено здесь:
 * - В Intent передаются EXTRA_SPEECH_INPUT_(POSSIBLY_)COMPLETE_SILENCE_LENGTH_MILLIS:
 *   сессия не считается завершённой, пока тишина короче 12/30 секунд (если сервис
 *   чтит extras — пауза на раздумье вообще не рвёт сессию; если нет — сессии
 *   станут короче, но рестарт ниже всё равно держит непрерывность записи).
 * - Перезапуск происходит ВНУТРИ Java (onResults/onError → новая сессия через
 *   ~220 мс, с backoff на серийных ошибках) — без круга через JS-мост, окно
 *   выключенного микрофона минимально.
 * - Текст сессии не теряется на границах: последний кумулятивный partial
 *   догоняет JS событием final, если сессия закончилась без onResults.
 * - Системные сигналы включения/выключения микрофона приглушаются на ~700 мс
 *   (STREAM_MUSIC, только если у пользователя не играет музыка).
 * - Все вызовы SpeechRecognizer выполняются на main thread (требование API);
 *   события наружу: partial {text}, final {text}, fatal {code,message}.
 */
@CapacitorPlugin(
    name = "ContinuousSpeech",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class ContinuousSpeechPlugin extends Plugin {

    private static final String EVENT_PARTIAL = "partial";
    private static final String EVENT_FINAL = "final";
    private static final String EVENT_FATAL = "fatal";

    /** Тишина после речи, при которой сессия завершается (полный порог) */
    private static final long DEFAULT_COMPLETE_SILENCE_MILLIS = 30000L;
    /** Более ранний порог «возможно закончил» — даёт финал и догон текста в поле */
    private static final long DEFAULT_POSSIBLE_SILENCE_MILLIS = 12000L;
    /** Пауза перед новой сессией после штатного завершения предыдущей */
    private static final long RESTART_DELAY_MS = 220L;
    /** Верхняя граница backoff при серийных ошибках без единой речи */
    private static final long MAX_BACKOFF_MS = 5000L;
    /** Сколько рестартов подряд без onReadyForSpeech считаем поломкой сервиса */
    private static final int MAX_RESTARTS_WITHOUT_READY = 30;
    /** На сколько приглушать системные сигналы распознавателя */
    private static final long MUTE_WINDOW_MS = 700L;

    private SpeechRecognizer recognizer;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private volatile boolean wantListening = false;
    private String language = "ru-RU";
    private long completeSilenceMillis = DEFAULT_COMPLETE_SILENCE_MILLIS;
    private long possibleSilenceMillis = DEFAULT_POSSIBLE_SILENCE_MILLIS;
    private boolean muteSounds = true;

    /** Кумулятивный текст текущей сессии (последний partial) — страховой flush на границе */
    private String lastPartial = "";
    private Runnable pendingRestart;
    private int restartsSinceReady = 0;
    private boolean beepsMuted = false;

    // ------------------------------------------------------------ plugin API

    @PluginMethod
    public void start(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.unavailable("Распознавание речи недоступно на этом устройстве");
            return;
        }
        language = call.getString("lang", "ru-RU");
        Double complete = call.getDouble("completeSilenceMillis");
        completeSilenceMillis = complete == null ? DEFAULT_COMPLETE_SILENCE_MILLIS : complete.longValue();
        Double possible = call.getDouble("possibleSilenceMillis");
        possibleSilenceMillis = possible == null ? DEFAULT_POSSIBLE_SILENCE_MILLIS : possible.longValue();
        Boolean mute = call.getBoolean("muteSounds");
        muteSounds = mute == null || mute;

        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestAllPermissions(call, "startAfterPermission");
            return;
        }
        beginSession(call);
    }

    @PermissionCallback
    private void startAfterPermission(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission denied");
            notifyFatal("permission", "Нет доступа к микрофону — разреши его для приложения");
            return;
        }
        beginSession(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        wantListening = false;
        mainHandler.post(() -> {
            cancelPendingRestart();
            muteRecognitionSounds();
            destroyRecognizer();
        });
        call.resolve();
    }

    @PluginMethod
    public void isListening(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("listening", wantListening);
        call.resolve(ret);
    }

    // ------------------------------------------------------- session engine
    // Всё ниже исполняется на main thread (post из @PluginMethod; колбэки
    // RecognitionListener сервис тоже доставляет в main looper).

    private void beginSession(PluginCall call) {
        wantListening = true;
        restartsSinceReady = 0;
        lastPartial = "";
        mainHandler.post(() -> {
            startRecognizer();
            call.resolve();
        });
    }

    private void startRecognizer() {
        if (!wantListening) return;
        destroyRecognizer();
        muteRecognitionSounds();
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(listener);
            recognizer.startListening(buildIntent());
        } catch (Exception ex) {
            // сервис упал при старте — серия рестартов с backoff, иначе fatal
            handleError(SpeechRecognizer.ERROR_CLIENT);
        }
    }

    private Intent buildIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        // long-form диктовка: сервис старается не резать фразы по запятым
        intent.putExtra("android.speech.extra.DICTATION_MODE", true);
        // тишина не завершает сессию раньше этих порогов (если сервис чтит extras)
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, completeSilenceMillis);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, possibleSilenceMillis);
        return intent;
    }

    /** Новая сессия после штатного завершения предыдущей (results / ошибка / таймаут) */
    private void scheduleRestart(long delayMs) {
        if (!wantListening) return;
        cancelPendingRestart();
        Runnable restart = () -> {
            pendingRestart = null;
            if (!wantListening) return;
            // сессия закончилась без onResults — накопленный текст отдаём,
            // чтобы ни одна фраза не пропала на границе сессий
            flushPartialAsFinal();
            startRecognizer();
        };
        pendingRestart = restart;
        mainHandler.postDelayed(restart, delayMs);
    }

    private void cancelPendingRestart() {
        if (pendingRestart != null) {
            mainHandler.removeCallbacks(pendingRestart);
            pendingRestart = null;
        }
    }

    private void flushPartialAsFinal() {
        String text = lastPartial;
        lastPartial = "";
        if (text.isEmpty()) return;
        JSObject ret = new JSObject();
        ret.put("text", text);
        notifyListeners(EVENT_FINAL, ret);
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // сервис уже мёртв — не страшно
            }
            recognizer = null;
        }
    }

    private void handleError(int error) {
        if (!wantListening) return;

        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
            wantListening = false;
            destroyRecognizer();
            notifyFatal("permission", "Нет доступа к микрофону — разреши его для приложения");
            return;
        }

        restartsSinceReady++;
        if (restartsSinceReady > MAX_RESTARTS_WITHOUT_READY) {
            wantListening = false;
            flushPartialAsFinal();
            destroyRecognizer();
            notifyFatal("service", "Сервис распознавания речи не отвечает");
            return;
        }

        // первые неудачи перезапускаем почти сразу; серийные — с backoff
        long delay = restartsSinceReady <= 2
            ? RESTART_DELAY_MS
            : Math.min(RESTART_DELAY_MS * (restartsSinceReady - 1), MAX_BACKOFF_MS);
        scheduleRestart(delay);
    }

    private void notifyFatal(String code, String message) {
        JSObject ret = new JSObject();
        ret.put("code", code);
        ret.put("message", message);
        notifyListeners(EVENT_FATAL, ret);
    }

    // ------------------------------------------------- звуковые сигналы

    /**
     * Сервис Google проигрывает «динь» на старте/остановке микрофона. На время
     * перехода между сессиями глушим STREAM_MUSIC (только если у пользователя
     * сейчас не играет музыка — её приглушать нельзя).
     */
    private void muteRecognitionSounds() {
        if (!muteSounds || beepsMuted) return;
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null || am.isMusicActive()) return;
        try {
            beepsMuted = true;
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, 0);
            mainHandler.postDelayed(() -> {
                beepsMuted = false;
                try {
                    am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
                } catch (Exception ignored) {
                    // окно приглушения уже не актуально
                }
            }, MUTE_WINDOW_MS);
        } catch (Exception ignored) {
            beepsMuted = false;
        }
    }

    // --------------------------------------------------------- listener

    private String firstMatch(Bundle results) {
        if (results == null) return "";
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty()) return "";
        String text = matches.get(0);
        return text == null ? "" : text.trim();
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            // сервис жив и слушает — счётчик серийных сбоев можно сбросить
            restartsSinceReady = 0;
        }

        @Override
        public void onBeginningOfSpeech() {
            // пользователь заговорил
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            // уровень сигнала — не нужен
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            // сырой звук — не нужен
        }

        @Override
        public void onEndOfSpeech() {
            // Пользователь замолчал. ВАЖНО: это НЕ конец сессии — при чтимых
            // extras сервис продолжит ждать (до порога тишины), при неп чтимых
            // следом придут onResults/onError и рестарт. Ничего не делаем:
            // короткая пауза в речи не должна рвать запись.
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstMatch(partialResults);
            if (text.isEmpty()) return;
            lastPartial = text;
            JSObject ret = new JSObject();
            ret.put("text", text);
            notifyListeners(EVENT_PARTIAL, ret);
        }

        @Override
        public void onResults(Bundle results) {
            String text = firstMatch(results);
            lastPartial = ""; // финал получен — страховой flush не нужен
            if (!text.isEmpty()) {
                JSObject ret = new JSObject();
                ret.put("text", text);
                notifyListeners(EVENT_FINAL, ret);
            }
            scheduleRestart(RESTART_DELAY_MS);
        }

        @Override
        public void onError(int error) {
            handleError(error);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
            // зарезервировано — не используется
        }
    };
}
