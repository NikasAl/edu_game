'use client';

import { useEffect, useRef, useState } from 'react';
import { saveDraftPatch } from '@/lib/db';

/**
 * Черновики ответов узла: всё набранное сохраняется в IndexedDB
 * (в том числе неверные ответы) и восстанавливается при повторном входе.
 *
 * Приоритет при монтировании:
 *  1) сохранённый черновик (db.drafts);
 *  2) последняя отправленная попытка (attempt.userAnswer);
 *  3) пустая строка.
 *
 * Сохранение — дебаунс 500 мс во время ввода + сброс последнего значения
 * при размонтировании (уход из узла не теряет последний символ).
 *
 * Компоненты-испытания монтируются с key={nodeId…}, поэтому при смене узла
 * состояние пересоздаётся — спецсброс в эффекте не нужен.
 */

const DRAFT_DEBOUNCE_MS = 500;

type TextSetter = React.Dispatch<React.SetStateAction<string>>;

interface DraftOpts {
  nodeId: string;
  materialId: string;
  /** Ответ из последней попытки — показывается, если черновика ещё нет */
  attemptAnswer?: string;
}

/** Текстовое поле (объяснение Фейнмана / своя задача) */
export function useNodeDraft(
  opts: DraftOpts & { field: 'feynmanText' | 'ownTaskText' }
): [string, TextSetter] {
  const { nodeId, materialId, field, attemptAnswer } = opts;
  const [value, setValue] = useState('');
  const seededRef = useRef(false);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // восстановление при входе в узел (attemptAnswer осознанно не в зависимостях:
  // сид применяется один раз при монтировании)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { db } = await import('@/lib/db');
      const draft = await db.drafts.get(nodeId);
      if (!alive) return;
      const saved = (draft?.[field] as string | undefined) ?? '';
      setValue(saved || attemptAnswer || '');
      seededRef.current = true;
    })();
    return () => {
      alive = false;
    };
  }, [nodeId, field]);

  // автосохранение с дебаунсом
  useEffect(() => {
    if (!seededRef.current) return;
    const t = setTimeout(() => {
      void saveDraftPatch(nodeId, materialId, { [field]: valueRef.current });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, nodeId, materialId, field]);

  // сброс последнего значения при уходе из узла
  useEffect(
    () => () => {
      if (seededRef.current) {
        void saveDraftPatch(nodeId, materialId, { [field]: valueRef.current });
      }
    },
    [nodeId, materialId, field]
  );

  return [value, setValue];
}

/** Ответ на конкретную задачу: текст (numeric/exact) и выбранный вариант (choice) */
export function useTaskAnswerDraft(opts: DraftOpts & { taskId: string; attemptChoiceIdx?: number }): {
  input: string;
  setInput: TextSetter;
  choiceIdx: number | null;
  setChoiceIdx: (i: number | null) => void;
} {
  const { nodeId, materialId, taskId, attemptAnswer, attemptChoiceIdx } = opts;
  const [input, setInput] = useState('');
  const [choiceIdx, setChoiceIdxState] = useState<number | null>(null);
  const seededRef = useRef(false);
  const inputRef = useRef(input);
  const choiceRef = useRef(choiceIdx);
  useEffect(() => {
    inputRef.current = input;
  }, [input]);
  useEffect(() => {
    choiceRef.current = choiceIdx;
  }, [choiceIdx]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { db } = await import('@/lib/db');
      const draft = await db.drafts.get(nodeId);
      if (!alive) return;
      const savedText = draft?.taskAnswers?.[taskId] ?? '';
      const savedChoice = draft?.taskChoices?.[taskId];
      setInput(savedText || attemptAnswer || '');
      setChoiceIdxState(
        typeof savedChoice === 'number'
          ? savedChoice
          : typeof attemptChoiceIdx === 'number'
            ? attemptChoiceIdx
            : null
      );
      seededRef.current = true;
    })();
    return () => {
      alive = false;
    };
  }, [nodeId, taskId]);

  // единый дебаунс на оба поля задачи
  useEffect(() => {
    if (!seededRef.current) return;
    const t = setTimeout(() => {
      const taskAnswers = { [taskId]: inputRef.current };
      const choice = choiceRef.current;
      const taskChoices = choice === null ? undefined : { [taskId]: choice };
      void saveDraftPatch(nodeId, materialId, { taskAnswers, ...(taskChoices ? { taskChoices } : {}) });
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, choiceIdx, nodeId, materialId, taskId]);

  // сброс последнего значения при уходе из узла
  useEffect(
    () => () => {
      if (seededRef.current) {
        const choice = choiceRef.current;
        const taskChoices = choice === null ? undefined : { [taskId]: choice };
        void saveDraftPatch(nodeId, materialId, { taskAnswers: { [taskId]: inputRef.current }, ...(taskChoices ? { taskChoices } : {}) });
      }
    },
    [nodeId, materialId, taskId]
  );

  const setChoiceIdx = (i: number | null) => setChoiceIdxState(i);

  return { input, setInput, choiceIdx, setChoiceIdx };
}
